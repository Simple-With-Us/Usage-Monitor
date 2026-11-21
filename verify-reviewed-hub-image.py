#!/usr/bin/env python3
"""Verify a telemetry hub image against one exact Git commit without starting the hub."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


IMAGE_NAME = "usage-monitor-telemetry-hub"
REVISION_LABEL = "org.opencontainers.image.revision"
FIXED_IMPORTS = (
    "scripts/telemetry-hub/journal.mjs",
    "scripts/telemetry-hub/sentry-sender.mjs",
    "scripts/telemetry-hub/metadata-projection.mjs",
    "scripts/telemetry-hub/allowlist.mjs",
)
RESULT_KEYS = {"fileCount", "hashMatch", "nodeVersion", "importsOk"}
CONTAINER_CHECK = r"""
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(process.argv[1]);
let hashMatch = Array.isArray(manifest);
for (const entry of manifest) {
  const digest = createHash('sha256').update(await readFile(`/app/${entry.path}`)).digest('hex');
  if (digest !== entry.sha256) hashMatch = false;
}
await import('file:///app/scripts/telemetry-hub/journal.mjs');
await import('file:///app/scripts/telemetry-hub/sentry-sender.mjs');
await import('file:///app/scripts/telemetry-hub/metadata-projection.mjs');
await import('file:///app/scripts/telemetry-hub/allowlist.mjs');
process.stdout.write(JSON.stringify({
  fileCount: manifest.length,
  hashMatch,
  nodeVersion: process.version,
  importsOk: true
}));
"""


class Refusal(Exception):
    pass


def git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=repo, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, check=False,
    )
    if result.returncode:
        raise Refusal("git_validation_failed")
    return result.stdout


def docker_call(docker: str, args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [docker, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        check=False,
    )


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="run the isolated image checks")
    parser.add_argument("sha", help="exact 40-character commit SHA")
    args = parser.parse_args()

    sha = args.sha
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise Refusal("invalid_sha")

    repo = Path(__file__).resolve().parent
    git_dir = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel")).strip()).resolve()
    if git_dir != repo:
        raise Refusal("not_repository_root")
    git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    names = git(repo, "ls-tree", "-r", "-z", "--name-only", sha,
                "--", "scripts/telemetry-hub", "scripts/lib/fleet-secrets.mjs")
    paths = sorted({
        os.fsdecode(item) for item in names.split(b"\0") if item.endswith(b".mjs")
    })
    if "scripts/lib/fleet-secrets.mjs" not in paths or not paths:
        raise Refusal("expected_sources_missing")
    if not set(FIXED_IMPORTS).issubset(paths):
        raise Refusal("expected_import_sources_missing")

    manifest = []
    for path in paths:
        content = git(repo, "show", f"{sha}:{path}")
        manifest.append({"path": path, "sha256": hashlib.sha256(content).hexdigest()})
    manifest_json = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    manifest_digest = hashlib.sha256(manifest_json.encode("utf-8")).hexdigest()
    image = f"{IMAGE_NAME}:{sha}"
    if not args.apply:
        print(json.dumps({"phase": "plan", "commit": sha, "fileCount": len(manifest),
                          "manifestSha256": manifest_digest, "image": image}, sort_keys=True))
        return 0

    docker = shutil.which("docker")
    if docker is None:
        print(json.dumps({"phase": "inspect", "exitCode": 1,
                          "errorType": "FileNotFoundError"}, sort_keys=True))
        return 1

    inspect_format = f'{{{{.Id}}}}\t{{{{index .Config.Labels "{REVISION_LABEL}"}}}}'
    try:
        inspected = docker_call(docker, ["image", "inspect", "--format", inspect_format, image])
    except OSError as error:
        print(json.dumps({"phase": "inspect", "exitCode": 1,
                          "errorType": type(error).__name__}, sort_keys=True))
        return 1
    fields = inspected.stdout.decode("utf-8", "replace").strip().split("\t", 1)
    if inspected.returncode != 0 or len(fields) != 2 or fields[1] != sha:
        print(json.dumps({"phase": "inspect", "exitCode": inspected.returncode or 1,
                          "revisionMatches": False}, sort_keys=True))
        return inspected.returncode or 1

    container_args = [
        "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--env", "TELEMETRY_HUB_SENTRY_ONLY=",
        "--env", "TELEMETRY_HUB_METADATA_ONLY=",
        "--env", "TELEMETRY_HUB_READINESS_FILE=",
        "--entrypoint", "node", image,
        "--input-type=module", "-e", CONTAINER_CHECK, manifest_json,
    ]
    try:
        checked = docker_call(docker, container_args)
    except OSError as error:
        print(json.dumps({"phase": "container", "exitCode": 1,
                          "errorType": type(error).__name__}, sort_keys=True))
        return 1
    if checked.returncode != 0:
        print(json.dumps({"phase": "container", "exitCode": checked.returncode}, sort_keys=True))
        return checked.returncode

    try:
        result = json.loads(checked.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        result = None
    if (not isinstance(result, dict) or set(result) != RESULT_KEYS
            or not isinstance(result["fileCount"], int)
            or not isinstance(result["hashMatch"], bool)
            or not isinstance(result["nodeVersion"], str)
            or not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", result["nodeVersion"])
            or not isinstance(result["importsOk"], bool)):
        print(json.dumps({"phase": "container_result", "exitCode": 1}, sort_keys=True))
        return 1
    ok = result["fileCount"] == len(manifest) and result["hashMatch"] and result["importsOk"]
    result.update({"phase": "verified", "exitCode": 0 if ok else 1, "sourceCommit": sha,
                   "revisionMatches": True})
    print(json.dumps(result, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Refusal as error:
        print(json.dumps({"phase": "refused", "reason": str(error)}, sort_keys=True))
        sys.exit(2)
