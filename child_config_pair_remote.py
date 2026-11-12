"""Private, release-gated two-key controller; token values never leave this process."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

VERIFIED_RELEASE_MESSAGE_ID = 637193996
VERIFIED_WIRE_MESSAGE_ID = 637192947
HOLD_MESSAGE_ID = 637192307
PROJECT = "86e35e51-91bc-4dfd-a045-4484726b9c40"
ENVIRONMENT = "prod"
FOLDER = "/telemetry"
BASE = "https://app.infisical.com"
MAX_RESPONSE_BYTES = 128 * 1024
CUSTODY_ROOT = Path("/Users/jay/.config/usage-monitor/infisical-service-tokens")
CLAIM_ROOT = Path("/Users/jay/.local/state/usage-monitor/um1646-child-config-pair")
TOKENS = {
    "read": {"file": "telemetry-read-token", "id": "2da57b07-1bed-4955-85ad-4db24ff60c43", "name": "um-telemetry-read", "expiresAt": "2027-02-01T13:05:31.892Z"},
    "write": {"file": "telemetry-write-token", "id": "81318b7a-7e2e-41f9-8788-cb0fefa12273", "name": "um-telemetry-write", "expiresAt": "2027-02-01T13:05:32.458Z"},
}
DESIRED = {
    "OPENCODE_SERVER_ADDITIONAL_DBS_JSON": '["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"]',
    "BOTFLEET_SERVER_WORKSPACES_DIRS": "/mnt/fleet-extra/apps/botfleet-server/data/workspaces",
}


class Refusal(Exception):
    def __init__(self, code, fields=None):
        self.code = code
        self.fields = fields or {}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def require_release(payload):
    if (type(VERIFIED_RELEASE_MESSAGE_ID) is not int or VERIFIED_RELEASE_MESSAGE_ID <= HOLD_MESSAGE_ID
            or VERIFIED_WIRE_MESSAGE_ID != 637192947
            or payload.get("releaseMessageId") != VERIFIED_RELEASE_MESSAGE_ID
            or payload.get("wireMessageId") != VERIFIED_WIRE_MESSAGE_ID):
        raise Refusal("authorization_route_held")


def field_names(value, prefix="", depth=0):
    names = []
    if depth > 4:
        return names
    if isinstance(value, dict):
        for key, child in list(value.items())[:60]:
            if isinstance(key, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", key):
                path = prefix + "." + key if prefix else key
                names.append(path)
                names.extend(field_names(child, path, depth + 1))
    elif isinstance(value, list):
        for child in value[:1]:
            names.extend(field_names(child, prefix + "[]", depth + 1))
    return sorted(set(names))[:120]


def identity(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        values = [value[key] for key in ("id", "_id") if key in value]
        if values and all(isinstance(item, str) and item == values[0] for item in values):
            return values[0]
    raise Refusal("explicit_identity_shape_unknown")


def assert_explicit_scope(row):
    for key in ("workspace", "workspaceId", "projectId", "project"):
        if key in row and identity(row[key]) != PROJECT:
            raise Refusal("explicit_project_conflict")
    for key in ("environment", "environmentSlug"):
        if key in row and row[key] != ENVIRONMENT:
            raise Refusal("explicit_environment_conflict")
    for key in ("secretPath", "path"):
        if key in row and row[key] != FOLDER:
            raise Refusal("explicit_folder_conflict")


def parse_self_metadata(body, role):
    """Recognize canonical fields only; unknown shape returns field names, never values."""
    required = {"id", "_id", "name", "workspace", "projectId", "scopes", "permissions", "expiresAt"}
    if not isinstance(body, dict) or not required.issubset(body):
        raise Refusal("self_metadata_shape_unknown", {"fieldNames": field_names(body)})
    row = body
    expected = TOKENS[role]
    explicit_ids = {}
    for key in ("id", "_id"):
        if key in row:
            if row[key] != expected["id"]:
                raise Refusal("self_metadata_id_conflict")
            explicit_ids[key] = row[key]
    if row.get("name") != expected["name"]:
        raise Refusal("self_metadata_name_conflict")
    if not any(key in row for key in ("workspace", "workspaceId", "projectId", "project")):
        raise Refusal("self_metadata_project_missing", {"fieldNames": field_names(body)})
    assert_explicit_scope(row)
    if row["permissions"] != [role]:
        raise Refusal("self_metadata_permissions_conflict")
    scopes = row["scopes"]
    if not isinstance(scopes, list) or len(scopes) != 1 or not isinstance(scopes[0], dict):
        raise Refusal("self_metadata_scopes_conflict")
    scope = scopes[0]
    if set(scope) != {"environment", "secretPath"}:
        raise Refusal("self_metadata_scope_fields_unknown", {"fieldNames": field_names(body)})
    if scope.get("environment") != ENVIRONMENT or scope.get("secretPath") != FOLDER:
        raise Refusal("self_metadata_scope_shape_or_value_conflict", {"fieldNames": field_names(body)})
    assert_explicit_scope(scope)
    if "permissions" in scope and scope["permissions"] != [role]:
        raise Refusal("self_metadata_scope_permissions_conflict")
    try:
        actual_expiry = dt.datetime.fromisoformat(row["expiresAt"].replace("Z", "+00:00"))
        expected_expiry = dt.datetime.fromisoformat(expected["expiresAt"].replace("Z", "+00:00"))
        if actual_expiry.tzinfo is None or actual_expiry != expected_expiry or actual_expiry <= dt.datetime.now(dt.timezone.utc):
            raise ValueError()
    except (AttributeError, TypeError, ValueError):
        raise Refusal("self_metadata_expiry_conflict") from None
    if row.get("isActive") is False or row.get("revoked") is True or row.get("isRevoked") is True:
        raise Refusal("self_metadata_inactive")
    verified = {"role": role, "explicitIds": explicit_ids, "nameVerified": True, "projectVerified": True,
            "singletonPermission": role, "singletonEnvironment": ENVIRONMENT, "singletonFolder": FOLDER,
            "expiresAt": expected["expiresAt"]}
    # Usage/updated timestamps are not authorization identity and may change on a read.
    verified["metadataSha256"] = digest(encoded(verified))
    return verified


def read_token(role, custody_root=None):
    root = CUSTODY_ROOT if custody_root is None else custody_root
    parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent_key = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode))
    try:
        parent_before = os.fstat(parent_fd)
        if not stat.S_ISDIR(parent_before.st_mode) or parent_before.st_uid != os.getuid() or stat.S_IMODE(parent_before.st_mode) != 0o700:
            raise Refusal("custody_directory_identity_invalid")
        fd = os.open(TOKENS[role]["file"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        with os.fdopen(fd, "rb") as handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600 or not 32 <= before.st_size <= 8192:
                raise Refusal("custody_file_identity_invalid")
            raw = handle.read(8193)
            after = os.fstat(handle.fileno())
            current = os.stat(TOKENS[role]["file"], dir_fd=parent_fd, follow_symlinks=False)
        parent_after = os.fstat(parent_fd)
        parent_path = os.stat(root, follow_symlinks=False)
        if not stat.S_ISDIR(parent_path.st_mode) or parent_key(parent_before) != parent_key(parent_after) or parent_key(parent_before) != parent_key(parent_path):
            raise Refusal("custody_directory_changed")
    finally:
        os.close(parent_fd)
    key = lambda value: (value.st_dev, value.st_ino, value.st_mtime_ns, value.st_size, value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode))
    if key(before) != key(after) or key(before) != key(current) or len(raw) != before.st_size:
        raise Refusal("custody_file_changed")
    try:
        token = raw.decode().strip()
    except UnicodeDecodeError:
        raise Refusal("custody_file_encoding_invalid") from None
    if not re.fullmatch(r"\S{32,8192}", token):
        raise Refusal("custody_file_shape_invalid")
    metadata = dict(zip(("device", "inode", "mtimeNs", "bytes", "uid", "gid", "mode"), key(before)))
    metadata["sha256"] = digest(raw)
    metadata["parent"] = dict(zip(("device", "inode", "uid", "gid", "mode"), parent_key(parent_before)))
    return token, metadata


def assert_custody_unchanged(expected, custody_root=None):
    for role in ("read", "write"):
        # Revalidation never replaces the tokens already captured by Transport.
        _, current = read_token(role, custody_root=custody_root)
        if current != expected[role]:
            raise Refusal("custody_changed_before_create", {"role": role})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Transport:
    def __init__(self, tokens):
        self.tokens = tokens
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, role, method, path, body=None):
        allowed_self = method == "GET" and path == "/api/v2/service-token"
        raw_paths = {"/api/v3/secrets/raw/" + key for key in DESIRED}
        parsed = urllib.parse.urlsplit(path)
        if not (allowed_self or parsed.path in raw_paths and ((role == "read" and method == "GET") or (role == "write" and method == "POST"))):
            raise Refusal("request_scope_refused")
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise Refusal("request_target_refused")
        if method == "POST" and (parsed.query or body != {**scope_params(), "secretValue": DESIRED[parsed.path.rsplit("/", 1)[1]]}):
            raise Refusal("create_body_scope_refused")
        if not allowed_self and method == "GET" and urllib.parse.parse_qs(parsed.query) != {key: [value] for key, value in scope_params().items()}:
            raise Refusal("read_query_scope_refused")
        request = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": "Bearer " + self.tokens[role], "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with self.opener.open(request, timeout=25) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise Refusal("response_size_limit")
                try:
                    data = json.loads(raw)
                except (UnicodeDecodeError, ValueError):
                    raise Refusal("response_json_invalid") from None
                return response.status, data
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            return status, None


def scope_params():
    return {"workspaceId": PROJECT, "environment": ENVIRONMENT, "secretPath": FOLDER, "type": "shared"}


def read_key(transport, key):
    if key not in DESIRED:
        raise Refusal("unknown_key_refused")
    status, body = transport.request("read", "GET", "/api/v3/secrets/raw/" + key + "?" + urllib.parse.urlencode(scope_params()))
    if status == 404:
        return {"state": "absent", "valueSha256": None}
    if status != 200:
        raise Refusal("raw_read_refused", {"httpStatus": status})
    if not isinstance(body, dict) or not isinstance(body.get("secret"), dict):
        raise Refusal("raw_read_shape_unknown", {"fieldNames": field_names(body)})
    row = body["secret"]
    if row.get("secretKey") != key or not isinstance(row.get("secretValue"), str):
        raise Refusal("raw_read_key_or_value_shape_conflict")
    assert_explicit_scope(body)
    assert_explicit_scope(row)
    if row["secretValue"] != DESIRED[key]:
        raise Refusal("existing_canonical_value_conflict", {"key": key})
    return {"state": "equal", "valueSha256": digest(DESIRED[key].encode())}


def remote_snapshot(transport, custody):
    metadata = {}
    for role in ("read", "write"):
        status, body = transport.request(role, "GET", "/api/v2/service-token")
        if status != 200:
            raise Refusal("self_metadata_read_refused", {"role": role, "httpStatus": status})
        metadata[role] = parse_self_metadata(body, role)
    return {"custody": custody, "serviceMetadata": metadata, "keys": {key: read_key(transport, key) for key in DESIRED}}


def private_json(path, value, exclusive=False):
    data = encoded(value)
    if len(data) > MAX_RESPONSE_BYTES:
        raise Refusal("receipt_size_limit")
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
    else:
        temporary = path.with_name(path.name + "." + secrets.token_hex(12) + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return digest(data)


def apply_pair(transport, expected, snapshot, plan_sha, claim_root=CLAIM_ROOT, *, custody_check=None):
    if snapshot != expected:
        raise Refusal("remote_plan_compare_and_swap_failed")
    if not re.fullmatch(r"[a-f0-9]{64}", plan_sha):
        raise Refusal("root_plan_digest_required")
    claim_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = claim_root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
        raise Refusal("private_claim_directory_invalid")
    claim_path = claim_root / "two-key-apply.claim.json"
    claim = {"version": 1, "rootPlanSha256": plan_sha, "releaseMessageId": VERIFIED_RELEASE_MESSAGE_ID, "wireMessageId": VERIFIED_WIRE_MESSAGE_ID,
             "phase": "claimed", "keys": {key: {"plannedState": snapshot["keys"][key]["state"], "attempted": False, "postHttpStatus": None, "confirmedCreated": False, "readbackVerified": False} for key in DESIRED}}
    private_json(claim_path, claim, exclusive=True)
    # The exclusive claim precedes a fresh reader-only CAS of BOTH keys.
    current = {key: read_key(transport, key) for key in DESIRED}
    if current != expected["keys"]:
        raise Refusal("remote_reader_compare_and_swap_failed")
    for key in DESIRED:
        item = claim["keys"][key]
        if current[key]["state"] == "absent":
            item.update(attempted=True, status="attempting")
            private_json(claim_path, claim)
            try:
                if custody_check is None:
                    assert_custody_unchanged(expected["custody"])
                else:
                    custody_check()
            except Exception:
                item.update(attempted=False, status="pre_create_custody_refused")
                private_json(claim_path, claim)
                raise
            try:
                status, body = transport.request("write", "POST", "/api/v3/secrets/raw/" + key, {**scope_params(), "secretValue": DESIRED[key]})
            except Exception:
                item["status"] = "outcome_unknown"
                private_json(claim_path, claim)
                raise Refusal("create_outcome_unknown", {"key": key}) from None
            item.update(postHttpStatus=status, status="create_response_received")
            private_json(claim_path, claim)
            if status not in (200, 201):
                raise Refusal("create_refused_or_partial", {"key": key, "httpStatus": status})
            if not isinstance(body, dict) or not isinstance(body.get("secret"), dict) or body["secret"].get("secretKey") != key:
                raise Refusal("create_response_identity_unknown", {"key": key})
            assert_explicit_scope(body)
            assert_explicit_scope(body["secret"])
            if "secretValue" in body["secret"] and body["secret"]["secretValue"] != DESIRED[key]:
                raise Refusal("create_response_value_conflict", {"key": key})
            if read_key(transport, key)["state"] != "equal":
                raise Refusal("created_key_readback_failed", {"key": key})
            item["confirmedCreated"] = True
        item.update(readbackVerified=True, status="verified_equal")
        private_json(claim_path, claim)
    final = {key: read_key(transport, key) for key in DESIRED}
    if any(row["state"] != "equal" for row in final.values()):
        raise Refusal("canonical_final_readback_failed")
    claim["phase"] = "canonical_complete"
    receipt_sha = private_json(claim_path, claim)
    return {"sourceOfTruthComplete": True, "keys": claim["keys"], "claimSha256": receipt_sha}


def main():
    payload_raw = sys.stdin.buffer.read(MAX_RESPONSE_BYTES + 1)
    if len(payload_raw) > MAX_RESPONSE_BYTES:
        raise Refusal("controller_input_too_large")
    payload = json.loads(payload_raw)
    require_release(payload)
    mode = sys.argv[1] if len(sys.argv) == 2 else None
    if mode not in ("plan", "apply"):
        raise Refusal("mode_refused")
    code_sha = digest(Path(__file__).read_bytes())
    if payload.get("remoteCodeSha256") != code_sha:
        raise Refusal("remote_code_changed")
    token_values = {}
    custody = {}
    for role in ("read", "write"):
        token_values[role], custody[role] = read_token(role)
    transport = Transport(token_values)
    snapshot = remote_snapshot(transport, custody)
    if mode == "plan":
        print(json.dumps({"ok": True, "remoteCodeSha256": code_sha, "snapshot": snapshot, "remoteWrites": False}))
    else:
        result = apply_pair(transport, payload["remotePlan"]["snapshot"], snapshot, payload["rootPlanSha256"])
        print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print(json.dumps({"ok": False, "reason": error.code, **error.fields}))
        raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"ok": False, "reason": "operation_stopped_inspect_before_retry", "errorClass": type(error).__name__}))
        raise SystemExit(1)
