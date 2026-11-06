#!/usr/bin/env python3
"""Offline-plan-first mounted snapshot CAS and explicit existing Compose recreation."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path, PurePosixPath
import secrets
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location("canonical_activation", Path(__file__).with_name("activate-kimi-zcode.py"))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
Stop = C.Stop
FIELDS = {"SENTRY_OTLP_ENDPOINT", "SENTRY_PUBLIC_KEY", C.HUB_MAP}


def pinned_create_payload(inspected):
    """Offline proposal only; derive a self-contained Engine create body, never start it.

    The caller must retain this payload privately and validate a created, stopped
    container against it before a separately implemented start is considered.
    """
    config = copy.deepcopy(inspected["Config"])
    host = copy.deepcopy(inspected["HostConfig"])
    image = inspected["Image"]
    if (not re.fullmatch(r"sha256:[0-9a-f]{64}", image) or config.get("User") != "10001:10001"
            or host.get("Privileged") or host.get("NetworkMode") != "host"
            or not host.get("ReadonlyRootfs") or host.get("PortBindings")
            or host.get("VolumesFrom") or host.get("Links")):
        raise Stop("pinned recreation proposal violates existing isolation")
    # Never recover credentials from an env_file; this snapshot-mode hub has none in Config.Env.
    names = []
    for entry in config.get("Env", []):
        if not isinstance(entry, str) or "=" not in entry:
            raise Stop("invalid resolved container environment")
        name = entry.split("=", 1)[0]
        if re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API_KEY|PUBLIC_KEY|DSN", name, re.IGNORECASE):
            raise Stop("resolved environment contains a credential-shaped key; separate review required")
        if name in names:
            raise Stop("duplicate resolved environment key")
        names.append(name)
    mounts = inspected.get("Mounts", [])
    declared = {}
    for bind in host.get("Binds") or []:
        parts = bind.split(":")
        if len(parts) not in (2, 3) or parts[1] in declared:
            raise Stop("ambiguous resolved bind declaration")
        kind = "bind" if parts[0].startswith("/") else "volume"
        declared[parts[1]] = (kind, parts[0], "ro" not in (parts[2].split(",") if len(parts) == 3 else []))
    for mount in host.get("Mounts") or []:
        target = mount.get("Target")
        if not isinstance(target, str) or target in declared or mount.get("Type") not in ("bind", "volume"):
            raise Stop("unsupported resolved mount declaration")
        declared[target] = (mount["Type"], mount.get("Source"), not mount.get("ReadOnly", False))
    destinations = [mount.get("Destination") for mount in mounts]
    if len(set(destinations)) != len(destinations) or set(destinations) != set(declared):
        raise Stop("resolved mounts and create declarations differ")
    for mount in mounts:
        actual_source = mount.get("Name") if mount.get("Type") == "volume" else mount.get("Source")
        if declared.get(mount.get("Destination")) != (mount.get("Type"), actual_source, mount.get("RW")):
            raise Stop("resolved mount is not pinned by the create HostConfig")
    if (len([row for row in mounts if row.get("Destination") == "/data" and row.get("Type") == "volume" and row.get("RW")]) != 1
            or len([row for row in mounts if row.get("Destination") == "/run/secrets/telemetry-hub.json" and row.get("Type") == "bind" and not row.get("RW")]) != 1):
        raise Stop("existing durable and snapshot mounts required")
    config["Image"] = image
    payload = dict(config)
    payload["HostConfig"] = host
    return payload


def resolved_invariants(inspected):
    """Compare pre-start resolved configuration, independent of generated container ID/name."""
    config = copy.deepcopy(inspected["Config"])
    config.pop("Hostname", None)
    config["Image"] = inspected["Image"]
    mounts = copy.deepcopy(inspected["Mounts"])
    if not isinstance(mounts, list):
        raise Stop("resolved mounts must be a list")
    destinations = set()
    for mount in mounts:
        destination = mount.get("Destination") if isinstance(mount, dict) else None
        if not isinstance(destination, str) or not destination.startswith("/") or "\x00" in destination:
            raise Stop("exact absolute mount destination required")
        if destination in destinations:
            raise Stop("duplicate resolved mount destination")
        destinations.add(destination)
    mounts.sort(key=lambda mount: mount["Destination"])
    return {"Config": config, "HostConfig": inspected["HostConfig"],
            "Mounts": mounts, "Image": inspected["Image"]}


def directory_fd(path):
    if not os.path.isabs(path):
        raise Stop("absolute path required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in PurePosixPath(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def read_snapshot(path):
    parent, name = os.path.split(path)
    directory = directory_fd(parent)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or (before.st_uid, before.st_gid) != (10001, 10001)
                    or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= 1024 * 1024):
                raise Stop("mounted snapshot custody mismatch")
            raw = os.read(fd, 1024 * 1024 + 1)
            after = os.fstat(fd)
            if len(raw) != before.st_size or any(getattr(before, key) != getattr(after, key) for key in ("st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")):
                raise Stop("snapshot changed while reading")
            return raw.decode()
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def snapshot(raw):
    data = C.decode(raw)
    if not isinstance(data, dict) or set(data) != FIELDS or any(not isinstance(value, str) or not value for value in data.values()):
        raise Stop("snapshot must contain exactly the three existing fields")
    return data


def sources(raw):
    # Reuse strict duplicate/member/token validation without requiring unactivated producers.
    rows = C.decode(raw)
    if not isinstance(rows, list):
        raise Stop("invalid sources")
    ids, tokens = set(), set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"id", "platform", "token"}
                or any(not isinstance(value, str) or not value for value in row.values())
                or any(not re.fullmatch(r"[a-z0-9._-]{1,80}", row[key]) for key in ("id", "platform"))
                or not re.fullmatch(r"\S{32,512}", row["token"])
                or row["id"] in ids or row["token"] in tokens):
            raise Stop("invalid or duplicate source")
        ids.add(row["id"])
        tokens.add(row["token"])
    return rows


def replacement(old_raw, new_map, manifest):
    old = snapshot(old_raw)
    old_sources, new_sources = sources(old[C.HUB_MAP]), sources(new_map)
    if (C.digest(old_raw) != manifest["old_snapshot_sha256"]
            or C.digest(old[C.HUB_MAP]) != manifest["old_map_sha256"]
            or C.digest(new_map) != manifest["new_map_sha256"]
            or sorted(row["id"] for row in new_sources) != sorted(manifest["new_members"])):
        raise Stop("snapshot or canonical map baseline changed")
    new_by_id = {row["id"]: row for row in new_sources}
    if any(new_by_id.get(row["id"]) != row for row in old_sources):
        raise Stop("existing member changed or removed")
    if not {"clutch.mac", "kimi-code", "zcode"} <= set(new_by_id):
        raise Stop("requested members missing")
    new = dict(old)
    new[C.HUB_MAP] = new_map
    return json.dumps(new, separators=(",", ":"))


def atomic_replace(path, old_raw, new_raw):
    parent, name = os.path.split(path)
    directory = directory_fd(parent)
    staged = ".telemetry-hub-reviewed-" + secrets.token_hex(16)
    try:
        fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            os.fchmod(fd, 0o600)
            os.fchown(fd, 10001, 10001)
            raw = new_raw.encode()
            while raw:
                count = os.write(fd, raw)
                if count <= 0:
                    raise Stop("staged snapshot write incomplete")
                raw = raw[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        if read_snapshot(path) != old_raw:
            raise Stop("snapshot compare immediately before rename changed")
        os.replace(staged, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        if read_snapshot(path) != new_raw:
            raise Stop("host snapshot replacement outcome unknown")
    finally:
        # A failed rename leaves only the private staged file; never overwrite the target to recover.
        os.close(directory)


class DockerCompose:
    """Exact existing project/service; never pulls/builds or changes Compose source."""
    def __init__(self, manifest):
        self.m = manifest

    def command(self, args):
        result = subprocess.run(args, capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise Stop("Docker operation refused or outcome unknown; reconcile private receipts")
        return result.stdout

    def compose(self, args):
        if C.digest(Path(self.m["compose_file"]).read_text()) != self.m["compose_sha256"]:
            raise Stop("Compose source changed before operation")
        return self.command(["docker", "compose", "--project-directory", self.m["compose_directory"],
            "--project-name", self.m["compose_project"], "-f", self.m["compose_file"], *args, self.m["compose_service"]])

    def inspect(self, *, running=True):
        # Read only this exact existing project/service; no fleet-wide credential inspection.
        ids = self.command(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + self.m["compose_project"],
                            "--filter", "label=com.docker.compose.service=" + self.m["compose_service"]]).splitlines()
        if len(ids) != 1:
            raise Stop("existing service selector ambiguous")
        item = C.decode(self.command(["docker", "inspect", ids[0]]))[0]
        config_mounts = [mount for mount in item["Mounts"] if mount["Destination"] == "/run/secrets/telemetry-hub.json"]
        journals = [mount for mount in item["Mounts"] if mount["Destination"] == "/data"]
        host = item["HostConfig"]
        if (len(config_mounts) != 1 or config_mounts[0]["Type"] != "bind" or config_mounts[0]["RW"]
                or config_mounts[0]["Source"] != self.m["snapshot_path"]
                or len(journals) != 1 or journals[0]["Type"] != "volume" or not journals[0]["RW"]
                or journals[0]["Source"] != self.m["journal_path"]
                or item["Config"]["User"] != "10001:10001" or not host["ReadonlyRootfs"]
                or host["NetworkMode"] != "host" or host.get("PortBindings")):
            raise Stop("private host network, user or durable/config mounts changed")
        if bool(item["State"]["Running"]) != running:
            raise Stop("unexpected service running state")
        # Same canonical projection and compact sorted encoding as the rest of the toolchain.
        stable = resolved_invariants(item)
        if C.digest(json.dumps(stable, sort_keys=True, separators=(",", ":"))) != self.m["container_invariants_sha256"]:
            raise Stop("container configuration or durable mounts changed")
        if item["Image"] != self.m["image_id"]:
            raise Stop("image changed")
        if running and item["State"].get("Health", {}).get("Status") != "healthy":
            raise Stop("service is not healthy")
        return ids[0]

    def preflight(self):
        if C.digest(Path(self.m["compose_file"]).read_text()) != self.m["compose_sha256"]:
            raise Stop("Compose source changed")
        container = self.inspect()
        item = C.decode(self.command(["docker", "inspect", container]))[0]
        labels = item["Config"].get("Labels", {})
        if (labels.get("com.docker.compose.project.config_files") != self.m["compose_file"]
                or labels.get("com.docker.compose.project.working_dir") != self.m["compose_directory"]):
            raise Stop("Compose source provenance differs from selected existing container")
        self.mounted()

    def mounted(self):
        container = self.inspect()
        host = read_snapshot(self.m["snapshot_path"])
        # The container emits only the mounted file's SHA-256 digest, so the raw
        # mounted secret never transits subprocess stdout.
        remote = self.command(["docker", "exec", container, "node", "-e",
            "process.stdout.write(require('node:crypto').createHash('sha256')"
            ".update(require('node:fs').readFileSync('/run/secrets/telemetry-hub.json','utf8'))"
            ".digest('hex'))"])
        if remote != C.digest(host):
            raise Stop("host and running mounted snapshots differ")
        # Callers receive the private host custody snapshot, never container output.
        return host

    def stop(self):
        raise Stop("live stop is unavailable until a pinned recreation route is reviewed")

    def journal(self):
        # Metadata reads only; no event body read or replay.
        root = Path(self.m["journal_path"])
        def read_state(name):
            directory = directory_fd(str(root / "state"))
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
                        raise Stop("invalid journal state")
                    return C.decode(os.read(fd, 1024 * 1024 + 1))
                finally:
                    os.close(fd)
            finally:
                os.close(directory)
        base = read_state("journal.base.json")
        offset = read_state("sentry.offset.json")
        directory = directory_fd(str(root))
        try:
            journal = os.stat("journal.jsonl", dir_fd=directory, follow_symlinks=False)
            try:
                dead = os.stat("dead-letter.jsonl", dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(dead.st_mode):
                    raise Stop("dead letter is not a regular file")
                dead_size = dead.st_size
            except FileNotFoundError:
                dead_size = 0
        finally:
            os.close(directory)
        if not stat.S_ISREG(journal.st_mode):
            raise Stop("journal is not a regular file")
        end = base.get("base", -1) + journal.st_size
        position = offset.get("offset", -1)
        if not isinstance(position, int) or not 0 <= position <= end or base.get("pendingSize", -1) != 0:
            raise Stop("journal offset or compaction state invalid")
        return {"logical_end": end, "offset": position, "device": journal.st_dev, "dead_letter_bytes": dead_size}

    def recreate(self):
        raise Stop("live recreation is intentionally unimplemented; Compose inputs are not frozen")


def execute(manifest, backend, *, read=read_snapshot, write=C.exclusive_write, replace=atomic_replace, source_read=C.private_read, backup_read=C.private_read):
    old_raw = read(manifest["snapshot_path"])
    new_map = source_read(manifest["canonical_map_path"])
    new_raw = replacement(old_raw, new_map, manifest)
    backend.preflight()
    write(manifest["receipt_prefix"] + ".backup.json", old_raw)
    if backup_read(manifest["receipt_prefix"] + ".backup.json") != old_raw:
        raise Stop("private snapshot backup readback failed")
    write(manifest["receipt_prefix"] + ".intent.json", json.dumps({"old_sha256": C.digest(old_raw), "new_sha256": C.digest(new_raw)}))
    backend.stop()
    before = backend.journal()
    write(manifest["receipt_prefix"] + ".stopped.json", json.dumps(before))
    replace(manifest["snapshot_path"], old_raw, new_raw)
    backend.recreate()
    if backend.mounted() != new_raw:
        raise Stop("actual in-container snapshot readback differs; reconcile without rollback")
    after = backend.journal()
    if (after["device"] != before["device"] or after["logical_end"] < before["logical_end"]
            or after["offset"] < before["offset"] or after["dead_letter_bytes"] != before["dead_letter_bytes"]):
        raise Stop("journal continuity failed; reconcile without replay")
    result = {"status": "mounted_snapshot_verified", "snapshot_sha256": C.digest(new_raw),
              "map_sha256": C.digest(new_map), "member_count": len(sources(new_map)), "journal_continuity": True}
    write(manifest["receipt_prefix"] + ".complete.json", json.dumps(result))
    return result


def validate_manifest(data):
    keys = {"snapshot_path", "canonical_map_path", "old_snapshot_sha256", "old_map_sha256", "new_map_sha256", "new_members",
            "receipt_prefix", "compose_directory", "compose_project", "compose_file", "compose_service", "compose_sha256",
            "container_invariants_sha256", "image_id", "journal_path"}
    if not isinstance(data, dict) or set(data) != keys:
        raise Stop("exact reviewed manifest fields required")
    for key in ("snapshot_path", "canonical_map_path", "receipt_prefix", "compose_directory", "compose_file", "journal_path"):
        if not isinstance(data[key], str) or not os.path.isabs(data[key]):
            raise Stop("absolute reviewed paths required")
    for key in ("old_snapshot_sha256", "old_map_sha256", "new_map_sha256", "compose_sha256", "container_invariants_sha256"):
        if not isinstance(data[key], str) or not re.fullmatch(r"[0-9a-f]{64}", data[key]):
            raise Stop("exact reviewed SHA256 digests required")
    for key in ("compose_project", "compose_service"):
        if not isinstance(data[key], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,150}", data[key]):
            raise Stop("invalid existing Compose selector")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-manifest-sha256")
    args = parser.parse_args()
    try:
        raw = Path(args.manifest).read_text()
        if len(raw) > C.LIMIT:
            raise Stop("manifest exceeds limit")
        manifest = C.decode(raw)
        validate_manifest(manifest)
        if not args.execute:
            print(json.dumps({"mode": "offline_plan", "manifest_sha256": C.digest(raw), "writes": 0, "docker_calls": 0,
                              "operations_if_released": ["backup", "stop", "snapshot_compare_replace", "recreate", "mounted_readback", "journal_continuity"]}))
            return
        if args.reviewed_manifest_sha256 != C.digest(raw):
            raise Stop("exact reviewed manifest digest required")
        # A matching manifest is insufficient while the real recreation route is unresolved.
        raise Stop("live mounted execution unavailable pending reviewed pinned recreation implementation")
    except Exception as error:
        print(json.dumps({"status": "stopped", "reason": str(error) if isinstance(error, Stop) else "operation failed or outcome unknown; inspect private receipts"}), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
