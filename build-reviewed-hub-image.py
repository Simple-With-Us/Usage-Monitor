#!/usr/bin/env python3
"""Build a telemetry hub image from an exact, reviewed Git commit archive."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


DOCKERFILE = "deploy/telemetry-hub/Dockerfile"
IMAGE_NAME = "usage-monitor-telemetry-hub"
COPY_SOURCES = {
    "deploy/telemetry-hub/package.json",
    "deploy/telemetry-hub/package-lock.json",
    "scripts/telemetry-hub",
    "scripts/lib/fleet-secrets.mjs",
}
REVISION_LABEL = "org.opencontainers.image.revision"
MAX_LOG_BYTES = 10 * 1024 * 1024
CHILD_WAIT_SECONDS = 2


class Refusal(Exception):
    pass


def stop_child(child: subprocess.Popen[bytes] | None) -> None:
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
        child.wait(timeout=CHILD_WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        try:
            child.wait(timeout=CHILD_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            pass
    except OSError:
        try:
            child.kill()
            child.wait(timeout=CHILD_WAIT_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            pass


def git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=repo, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, check=False,
    )
    if result.returncode:
        raise Refusal("git_validation_failed")
    return result.stdout


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="build the validated image")
    parser.add_argument("sha", help="exact merged 40-character commit SHA")
    args = parser.parse_args()

    sha = args.sha
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise Refusal("invalid_sha")

    repo = Path(__file__).resolve().parent
    git_dir = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel")).strip()).resolve()
    if git_dir != repo:
        raise Refusal("not_repository_root")
    git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    git(repo, "merge-base", "--is-ancestor", sha, "origin/main")

    dockerfile = git(repo, "show", f"{sha}:{DOCKERFILE}").decode("utf-8")
    copy_sources = set()
    for line in dockerfile.splitlines():
        parts = line.strip().split()
        if parts and parts[0] == "COPY" and len(parts) >= 3:
            copy_sources.update(parts[1:-1])
    if copy_sources != COPY_SOURCES:
        raise Refusal("unexpected_copy_targets")
    for source in sorted(COPY_SOURCES):
        git(repo, "cat-file", "-e", f"{sha}:{source}")

    tree_hash = os.fsdecode(git(repo, "rev-parse", f"{sha}^{{tree}}")).strip()
    dockerfile_hash = os.fsdecode(git(repo, "rev-parse", f"{sha}:{DOCKERFILE}")).strip()
    tag = f"{IMAGE_NAME}:{sha}"
    plan = {
        "phase": "plan",
        "commit": sha,
        "sourceTree": tree_hash,
        "dockerfileBlob": dockerfile_hash,
        "copyTargets": sorted(COPY_SOURCES),
        "imageTag": tag,
    }
    if not args.apply:
        print(json.dumps(plan, sort_keys=True))
        return 0

    inspect = subprocess.run(
        ["docker", "image", "inspect", "--format",
         f'{{{{.Id}}}}\t{{{{index .Config.Labels "{REVISION_LABEL}"}}}}', tag],
        cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        text=True,
    )
    if inspect.returncode == 0:
        fields = inspect.stdout.strip().split("\t", 1)
        if len(fields) != 2 or fields[1] != sha:
            raise Refusal("existing_tag_revision_mismatch")
        print(json.dumps({"phase": "existing", "exitCode": 0, "imageId": fields[0],
                          "sourceCommit": sha, "revisionMatches": True}, sort_keys=True))
        return 0

    log_fd, log_name = tempfile.mkstemp(prefix="usage-monitor-hub-build-", suffix=".log")
    os.fchmod(log_fd, 0o600)
    log_path = os.path.abspath(log_name)
    docker_exit = 1
    archive_exit = 1
    archive: subprocess.Popen[bytes] | None = None
    docker: subprocess.Popen[bytes] | None = None
    log_reader: threading.Thread | None = None
    reader_errors: list[str] = []
    try:
        with os.fdopen(log_fd, "wb") as log_file:
            archive = subprocess.Popen(
                ["git", "archive", "--format=tar", sha], cwd=repo,
                stdout=subprocess.PIPE, stderr=log_file,
            )
            assert archive.stdout is not None
            docker = subprocess.Popen(
                ["docker", "build", "--file", DOCKERFILE,
                 "--label", f"{REVISION_LABEL}={sha}", "--tag", tag, "-"],
                cwd=repo, stdin=archive.stdout, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            archive.stdout.close()

            def save_bounded_docker_log() -> None:
                assert docker.stdout is not None
                remaining = MAX_LOG_BYTES
                try:
                    while True:
                        chunk = docker.stdout.read(64 * 1024)
                        if not chunk:
                            break
                        if remaining:
                            kept = chunk[:remaining]
                            try:
                                log_file.write(kept)
                                remaining -= len(kept)
                            except OSError as error:
                                reader_errors.append(type(error).__name__)
                                remaining = 0
                except OSError as error:
                    reader_errors.append(type(error).__name__)
                    stop_child(docker)
                finally:
                    docker.stdout.close()

            log_reader = threading.Thread(target=save_bounded_docker_log, daemon=True)
            log_reader.start()
            docker_exit = docker.wait()
            log_reader.join()
            archive_exit = archive.wait()
    except Exception as error:
        stop_child(docker)
        stop_child(archive)
        if log_reader is not None and log_reader.is_alive():
            log_reader.join(timeout=CHILD_WAIT_SECONDS)
        if docker is not None and docker.stdout is not None:
            try:
                docker.stdout.close()
            except OSError:
                pass
            if log_reader is not None and log_reader.is_alive():
                log_reader.join(timeout=CHILD_WAIT_SECONDS)
        if archive is not None and archive.stdout is not None:
            try:
                archive.stdout.close()
            except OSError:
                pass
        try:
            os.close(log_fd)
        except OSError:
            pass
        print(json.dumps({"phase": "build", "exitCode": 1,
                          "errorType": type(error).__name__, "logPath": log_path}, sort_keys=True))
        return 1

    if archive_exit != 0 or docker_exit != 0:
        print(json.dumps({"phase": "build", "exitCode": docker_exit or archive_exit,
                          "logPath": log_path}, sort_keys=True))
        return docker_exit or archive_exit
    if reader_errors:
        print(json.dumps({"phase": "build", "exitCode": 1,
                          "errorType": reader_errors[0], "logPath": log_path}, sort_keys=True))
        return 1

    verified = subprocess.run(
        ["docker", "image", "inspect", "--format",
         f'{{{{.Id}}}}\t{{{{index .Config.Labels "{REVISION_LABEL}"}}}}', tag],
        cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        text=True,
    )
    fields = verified.stdout.strip().split("\t", 1) if verified.returncode == 0 else []
    if len(fields) != 2 or fields[1] != sha:
        print(json.dumps({"phase": "inspect", "exitCode": 1, "logPath": log_path}, sort_keys=True))
        return 1
    print(json.dumps({"phase": "built", "exitCode": 0, "imageId": fields[0],
                      "sourceCommit": sha, "revisionMatches": True,
                      "logPath": log_path}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Refusal as error:
        print(json.dumps({"phase": "refused", "reason": str(error)}, sort_keys=True))
        sys.exit(2)
