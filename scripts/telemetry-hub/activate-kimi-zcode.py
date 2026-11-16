#!/usr/bin/env python3
"""Finite canonical activation controller; default operation is an offline plan.

No mounted-file, Docker, OAuth or collector operations are provided here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import PurePosixPath

ROOT_MAP = "USAGE_INGEST_PRODUCER_TOKENS"
HUB_MAP = "TELEMETRY_HUB_SOURCES_JSON"
KEYS = ("KIMI_CODE_INGEST_TOKEN", "KIMI_CODE_TELEMETRY_HUB_TOKEN",
        "ZCODE_INGEST_TOKEN", "ZCODE_TELEMETRY_HUB_TOKEN")
PRODUCERS = ("kimi-code", "zcode")
LIMIT = 128 * 1024


class Stop(Exception):
    """Sanitized stop; callers must reconcile any previous completed write."""


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Stop("duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Stop("invalid JSON") from None


def digest(raw):
    return hashlib.sha256(raw.encode()).hexdigest()


def private_read(path):
    """Walk every component without symlinks and bound an owner-only file read."""
    path = PurePosixPath(path)
    if not path.is_absolute():
        raise Stop("custody path must be absolute")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    file = None
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise Stop("custody directory must be owned and mode 0700")
        file = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(file)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= LIMIT):
            raise Stop("custody file must be owned, bounded and mode 0600")
        raw = os.read(file, LIMIT + 1)
        after = os.fstat(file)
        if len(raw) != before.st_size or any(getattr(before, key) != getattr(after, key) for key in ("st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")):
            raise Stop("custody file changed")
        return raw.decode("ascii")
    finally:
        if file is not None:
            os.close(file)
        os.close(directory)


def exclusive_write(path, data):
    """Exclusive durable private custody; never overwrite a prior or partial run."""
    parent, name = os.path.split(path)
    # Reuse the no-symlink directory traversal rather than trusting a path prefix.
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        if not os.path.isabs(path):
            raise Stop("custody path must be absolute")
        for part in PurePosixPath(parent).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise Stop("custody directory must be owned and mode 0700")
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            os.fchmod(fd, 0o600)
            raw = data.encode()
            while raw:
                count = os.write(fd, raw)
                if count <= 0:
                    raise Stop("custody write incomplete")
                raw = raw[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory)
    finally:
        os.close(directory)


def maps(root, hub):
    ids = []
    tokens = []
    for entry in root.split(","):
        parts = entry.strip().split(":", 1)
        if len(parts) != 2 or not re.fullmatch(r"[a-z0-9._-]{1,80}", parts[0]):
            raise Stop("invalid root map")
        name, token = parts
        if name in ids or not re.fullmatch(r"\S{32,512}", token) or token in tokens:
            raise Stop("duplicate or invalid root member")
        ids.append(name)
        tokens.append(token)
    sources = decode(hub)
    if not isinstance(sources, list):
        raise Stop("invalid hub map")
    hub_ids, hub_tokens = [], []
    for source in sources:
        if (not isinstance(source, dict) or set(source) != {"id", "platform", "token"}
                or any(not isinstance(value, str) for value in source.values())
                or any(not re.fullmatch(r"[a-z0-9._-]{1,80}", source[key]) for key in ("id", "platform"))
                or not re.fullmatch(r"\S{32,512}", source["token"])
                or source["id"] in hub_ids or source["token"] in hub_tokens):
            raise Stop("duplicate or invalid hub member")
        hub_ids.append(source["id"])
        hub_tokens.append(source["token"])
    if any(name in ids or name in hub_ids for name in PRODUCERS) or "clutch.mac" not in hub_ids:
        raise Stop("producer already exists or clutch.mac is missing")
    # The receiver enforces 1..64 sources; generation appends PRODUCERS.
    if not sources or len(sources) + len(PRODUCERS) > RECEIVER_MAX_SOURCES:
        raise Stop("hub map would violate the receiver 1..64 member limit")
    return ids, sources, tokens + hub_tokens


# Canonical receiver capacity, mirrored from parseReceiverSources (.max(64)) in
# otlp-receiver.mjs; test_receiver_capacity_matches_receiver pins the parity.
RECEIVER_MAX_SOURCES = 64


def validate_manifest(manifest):
    required = {"project", "grants", "root_sha256", "hub_sha256", "root_members",
                "hub_members", "custody_path", "receipt_prefix", "reservation_receipts"}
    if not isinstance(manifest, dict) or set(manifest) != required:
        raise Stop("invalid manifest fields")
    if any(not re.fullmatch(r"[0-9a-f]{64}", manifest[key]) for key in ("root_sha256", "hub_sha256")):
        raise Stop("invalid baseline digest")
    if not manifest["reservation_receipts"] or "clutch.mac" not in manifest["hub_members"]:
        raise Stop("reservation and Clutch-preservation evidence required")
    reservations = manifest["reservation_receipts"]
    if (not isinstance(reservations, list) or len(reservations) != 2
            or any(not isinstance(row, dict) or set(row) != {"topic", "receipt", "acknowledged"}
                   or not isinstance(row["receipt"], str) or not isinstance(row["acknowledged"], bool) for row in reservations)
            or {row["topic"] for row in reservations} != {"AFC-600", "Clutch"}):
        raise Stop("exact AFC-600 and Clutch reservation records required")
    if set(manifest["grants"]) != {"root_read", "root_write", "telemetry_read", "telemetry_write"}:
        raise Stop("exact four existing scoped grants required")
    for key, grant in manifest["grants"].items():
        if set(grant) != {"path", "id", "name", "expiresAt"}:
            raise Stop("invalid grant manifest")
        expected_name = "um-" + key.replace("root", "runtime").replace("_", "-")
        if grant["name"] != expected_name or not os.path.isabs(grant["path"]):
            raise Stop("grant name or custody path mismatch")
    if manifest["custody_path"] == manifest["receipt_prefix"] or not all(os.path.isabs(manifest[key]) for key in ("custody_path", "receipt_prefix")):
        raise Stop("invalid output custody")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Stop("redirect refused")


class API:
    def __init__(self, manifest):
        self.manifest = manifest
        self.opener = urllib.request.build_opener(NoRedirect())
        self.tokens = {key: private_read(grant["path"]) for key, grant in manifest["grants"].items()}
        if any(not re.fullmatch(r"st\.[!-~]{17,8190}", token) for token in self.tokens.values()):
            raise Stop("existing grant custody must contain an exact raw scalar")

    def request(self, method, path, grant, body=None):
        request = urllib.request.Request("https://app.infisical.com/api" + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self.tokens[grant], "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status not in ((200,) if method != "POST" else (200, 201)):
                    raise Stop("request not confirmed")
                raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise Stop("response exceeds limit")
            return decode(raw)
        except Exception:
            raise Stop("read failed" if method == "GET" else "write outcome unknown; reconcile, never retry") from None

    def verify(self):
        for key, spec in self.manifest["grants"].items():
            if private_read(spec["path"]) != self.tokens[key]:
                raise Stop("grant custody changed")
            data = self.request("GET", "/v2/service-token", key)
            expected = {"id": spec["id"], "name": spec["name"], "expiresAt": spec["expiresAt"],
                        "projectId": self.manifest["project"], "workspace": self.manifest["project"]}
            scope = "/" if key.startswith("root") else "/telemetry"
            if (any(data.get(k) != v for k, v in expected.items())
                    or ("_id" in data and data["_id"] != spec["id"])
                    or data.get("scopes") != [{"environment": "prod", "secretPath": scope}]
                    or data.get("permissions") != [key.split("_")[1]]
                    or datetime.fromisoformat(spec["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)):
                raise Stop("grant metadata mismatch or expired")

    def read(self, path, name=None):
        grant = "root_read" if path == "/" else "telemetry_read"
        query = urllib.parse.urlencode({"workspaceId": self.manifest["project"], "environment": "prod",
            "secretPath": path, "viewSecretValue": "false" if name is None else "true",
            "expandSecretReferences": "false", "include_imports": "false", "recursive": "false"})
        data = self.request("GET", "/v3/secrets/raw" + ("/" + name if name else "") + "?" + query, grant)
        def validate(row):
            for field, expected in (("workspace", self.manifest["project"]), ("workspaceId", self.manifest["project"]),
                                    ("projectId", self.manifest["project"]), ("environment", "prod"), ("secretPath", path)):
                if field in row and row[field] != expected:
                    raise Stop("scope echo contradiction")
        validate(data)
        if name is not None:
            row = data.get("secret", {})
            validate(row)
            if row.get("secretKey") != name or not isinstance(row.get("secretValue"), str) or "${" in row["secretValue"]:
                raise Stop("invalid exact secret read")
            return row["secretValue"]
        rows = data.get("secrets")
        if not isinstance(rows, list):
            raise Stop("invalid names response")
        names = []
        for row in rows:
            validate(row)
            name = row.get("secretKey")
            if not isinstance(name, str) or name in names:
                raise Stop("duplicate or invalid secret name")
            names.append(name)
        return set(names)

    def write(self, path, name, value, create):
        grant = "root_write" if path == "/" else "telemetry_write"
        self.request("POST" if create else "PATCH", "/v3/secrets/raw/" + name, grant,
            {"workspaceId": self.manifest["project"], "environment": "prod", "secretPath": path,
             "type": "shared", "secretValue": value})


def execute(manifest, api, *, writer=exclusive_write, reader=private_read, factory=lambda: secrets.token_urlsafe(32)):
    """No retries or rollback; every step is preceded by a full expected-state check."""
    validate_manifest(manifest)
    if not all(row["acknowledged"] for row in manifest["reservation_receipts"]):
        raise Stop("reservation acknowledgment missing; no credential consumption or writes allowed")
    api.verify()
    expected_names = {path: api.read(path) for path in ("/", "/telemetry")}
    if any(set(KEYS) & names for names in expected_names.values()):
        raise Stop("requested key already exists; reconcile previous or competing work")
    root, hub = api.read("/", ROOT_MAP), api.read("/telemetry", HUB_MAP)
    ids, sources, existing_tokens = maps(root, hub)
    if (digest(root) != manifest["root_sha256"] or digest(hub) != manifest["hub_sha256"]
            or sorted(ids) != sorted(manifest["root_members"])
            or sorted(item["id"] for item in sources) != sorted(manifest["hub_members"])):
        raise Stop("baseline mismatch")
    generated = {key: factory() for key in KEYS}
    if (len(set(generated.values())) != 4 or any(value in existing_tokens or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value) for value in generated.values())):
        raise Stop("generated token collision or invalid shape")
    writer(manifest["custody_path"], json.dumps(generated, separators=(",", ":")))
    if decode(reader(manifest["custody_path"])) != generated:
        raise Stop("producer custody readback failed")
    # Custody is durable before any remote write; an exclusive start receipt prevents reruns.
    writer(manifest["receipt_prefix"] + ".start.json", json.dumps({"status": "started", "manifest_sha256": digest(json.dumps(manifest, sort_keys=True))}))
    expected_maps = {"/": root, "/telemetry": hub}
    expected_values = {}
    # Collectors resolve tokens only via FLEET_SECRETS_PATHS ("/", "/global-api-keys"),
    # so the created collector tokens are written at "/" and read back from there;
    # only the hub map stays at "/telemetry".
    operations = [("/", key, generated[key], True) for key in KEYS]
    new_root = root + "," + ",".join(f"{producer}:{generated[KEYS[index * 2]]}" for index, producer in enumerate(PRODUCERS))
    new_hub = json.dumps(sources + [{"id": producer, "platform": producer, "token": generated[KEYS[index * 2 + 1]]} for index, producer in enumerate(PRODUCERS)], separators=(",", ":"))
    operations += [("/", ROOT_MAP, new_root, False), ("/telemetry", HUB_MAP, new_hub, False)]
    for index, (path, name, value, create) in enumerate(operations):
        api.verify()
        for scope in ("/", "/telemetry"):
            map_key = ROOT_MAP if scope == "/" else HUB_MAP
            if api.read(scope) != expected_names[scope] or api.read(scope, map_key) != expected_maps[scope]:
                raise Stop("compare-before-write changed; reconcile partial run")
        for key, previous in expected_values.items():
            if api.read("/", key) != previous:
                raise Stop("created key changed; reconcile partial run")
        # A pre-write receipt is deliberately durable even if the outcome becomes unknown.
        writer(manifest["receipt_prefix"] + f".{index}.intent.json", json.dumps({"step": index, "name": name, "status": "intent"}))
        api.write(path, name, value, create)
        if api.read(path, name) != value:
            raise Stop("write readback mismatch; reconcile, never retry")
        if create:
            expected_names[path].add(name)
            expected_values[name] = value
        else:
            expected_maps[path] = value
        # Verify complete expected state after each write, including all old members.
        for scope in ("/", "/telemetry"):
            key = ROOT_MAP if scope == "/" else HUB_MAP
            if api.read(scope) != expected_names[scope] or api.read(scope, key) != expected_maps[scope]:
                raise Stop("post-write state mismatch; reconcile partial run")
        for key, previous in expected_values.items():
            if api.read("/", key) != previous:
                raise Stop("created key changed after write; reconcile partial run")
        writer(manifest["receipt_prefix"] + f".{index}.confirmed.json", json.dumps({"step": index, "name": name, "status": "read_back"}))
    result = {"status": "canonical_read_back", "root_members": len(ids) + 2,
            "hub_members": len(sources) + 2, "hub_sha256": digest(new_hub), "root_sha256": digest(new_root),
            "mounted_config_changed": False, "restart_performed": False}
    writer(manifest["receipt_prefix"] + ".complete.json", json.dumps(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-manifest-sha256")
    args = parser.parse_args()
    try:
        # Manifest contains only metadata, never bearer values.
        with open(args.manifest, encoding="utf-8") as file:
            raw = file.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise Stop("manifest too large")
        manifest = decode(raw)
        validate_manifest(manifest)
        if not args.execute:
            print(json.dumps({"mode": "offline_plan", "network_requests": 0, "writes": 0,
                "manifest_sha256": digest(raw), "create_names": list(KEYS),
                "reservations_acknowledged": all(row["acknowledged"] for row in manifest["reservation_receipts"]),
                "update_maps": [ROOT_MAP, HUB_MAP], "activation": "separate reviewed mounted-config and runtime steps"}))
            return
        if args.reviewed_manifest_sha256 != digest(raw):
            raise Stop("exact reviewed manifest digest required")
        if not all(row["acknowledged"] for row in manifest["reservation_receipts"]):
            raise Stop("reservation acknowledgment missing; no credential consumption or writes allowed")
        print(json.dumps(execute(manifest, API(manifest))))
    except Exception as error:
        message = str(error) if isinstance(error, Stop) else "operation refused or outcome unknown; inspect private receipts"
        print(json.dumps({"status": "stopped", "reason": message}), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
