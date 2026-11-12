"""Private two-key source-of-truth/CAS controller; no I/O occurs on import."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys

VERIFIED_RELEASE_MESSAGE_ID = 637193996
VERIFIED_WIRE_MESSAGE_ID = 637192947
HOLD_MESSAGE_ID = 637192307
SOURCE_COMMIT = "ca19ad6ab8e98b5ac506d75d15b72dd0b9cd9015"
ROOT = Path("/mnt/fleet-extra/apps/lanes/Usage-Monitor/codex-um-1646-completion-audit")
MODULE = ROOT / "child_config_local_cas.py"
REMOTE_SOURCE = ROOT / "child_config_pair_remote.py"
REMOTE_STAGED = "/tmp/um1646-child-source-pair/child_config_pair_remote.py"
PLAN = ROOT / ".um1646-child-pair-plan.json"
INSTALLED = Path("/mnt/fleet-extra/apps/usage-monitor-collectors")
MAX_DOCUMENT_BYTES = 128 * 1024
RELEVANT = (
    "opencode-usage-collector.mjs", "lib/opencode-session-telemetry.mjs",
    "lib/run-session-token-collector.mjs", "lib/session-token-collectors.mjs",
    "lib/collector-sentry-bridge.mjs", "lib/fleet-secrets.mjs",
    "telemetry-hub/metadata-projection.mjs", "telemetry-hub/allowlist.mjs",
    "telemetry-hub/sentry-sender.mjs", "telemetry-hub/journal.mjs",
    "telemetry-hub/internal-event.mjs",
)
RUNTIME_DESIRED = {
    "OPENCODE_ADDITIONAL_DBS_JSON": '["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"]',
    "BOTFLEET_WORKSPACES_DIRS": "/mnt/fleet-extra/apps/botfleet-server/data/workspaces",
}


class Refusal(Exception):
    def __init__(self, code, fields=None):
        self.code = code
        self.fields = fields or {}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require_release():
    if (type(VERIFIED_RELEASE_MESSAGE_ID) is not int or VERIFIED_RELEASE_MESSAGE_ID <= HOLD_MESSAGE_ID
            or VERIFIED_WIRE_MESSAGE_ID != 637192947):
        raise Refusal("authorization_route_held")


def read_regular(path, maximum, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise Refusal("document_shape_invalid")
        if private and (before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600):
            raise Refusal("private_document_identity_invalid")
        data = handle.read(maximum + 1)
        after = os.fstat(handle.fileno())
    if len(data) > maximum or (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_size):
        raise Refusal("document_changed_or_exceeded_bound")
    return data


def code_binding():
    return {"controllerSha256": digest(read_regular(Path(__file__), 256 * 1024)),
            "remoteSha256": digest(read_regular(REMOTE_SOURCE, 256 * 1024)),
            "localModuleSha256": digest(read_regular(MODULE, 256 * 1024))}


def load_local_module():
    spec = importlib.util.spec_from_file_location("um1646_child_config_local_cas", MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if module.DESIRED != RUNTIME_DESIRED:
        raise Refusal("local_module_key_scope_changed")
    return module


def local_binding(cas, snapshot):
    return {**cas.safePlan(snapshot), "fileIdentity": {"device": snapshot.device, "inode": snapshot.inode,
            "mtimeNs": snapshot.mtime_ns, "bytes": snapshot.size}}


def installed_binding():
    hashes = {}
    for name in RELEVANT:
        actual = digest(read_regular(INSTALLED / "scripts" / name, 2 * 1024 * 1024))
        result = subprocess.run(["git", "-C", str(ROOT), "show", SOURCE_COMMIT + ":scripts/" + name], capture_output=True, timeout=20)
        if result.returncode or actual != digest(result.stdout):
            raise Refusal("installed_relevant_source_mismatch")
        hashes[name] = actual
    return {"sourceCommit": SOURCE_COMMIT, "hashes": hashes}


def remote_call(mode, binding, remote_plan=None, root_plan_sha=None):
    payload = {"releaseMessageId": VERIFIED_RELEASE_MESSAGE_ID, "wireMessageId": VERIFIED_WIRE_MESSAGE_ID,
               "remoteCodeSha256": binding["remoteSha256"]}
    if mode == "apply":
        payload.update(remotePlan=remote_plan, rootPlanSha256=root_plan_sha)
    command = shlex.join(["python3", REMOTE_STAGED, mode])
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mac", command],
                            input=json.dumps(payload).encode(), capture_output=True, timeout=390 if mode == "apply" else 180)
    if len(result.stdout) > MAX_DOCUMENT_BYTES:
        raise Refusal("remote_result_size_limit")
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise Refusal("remote_outcome_unknown_inspect_before_retry") from None
    if result.returncode or value.get("ok") is not True:
        reason = value.get("reason")
        reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,100}", reason) else "unrecognized_remote_refusal"
        fields = {"remoteReason": reason}
        names = value.get("fieldNames")
        if isinstance(names, list) and len(names) <= 120 and all(isinstance(name, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.\[\]]{0,300}", name) for name in names):
            fields["fieldNames"] = names
        raise Refusal("remote_stopped_inspect_before_retry", fields)
    if mode == "plan" and value.get("remoteCodeSha256") != binding["remoteSha256"]:
        raise Refusal("remote_code_readback_mismatch")
    return value


def persist(path, value, exclusive=False):
    data = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    if len(data) > MAX_DOCUMENT_BYTES:
        raise Refusal("private_receipt_size_limit")
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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else None
    if mode not in ("plan", "apply") or (mode == "plan" and len(sys.argv) != 2) or (mode == "apply" and len(sys.argv) != 3):
        raise Refusal("use_plan_or_apply_exact_reviewed_digest")
    require_release()  # Before any production source, custody, SSH or API operation.
    binding = code_binding()
    module = load_local_module()
    cas = module.ChildConfigLocalCAS()
    snapshot = cas.snapshot()
    local = local_binding(cas, snapshot)
    installed = installed_binding()
    if mode == "plan":
        remote = remote_call("plan", binding)
        plan = {"version": 1, "releaseMessageId": VERIFIED_RELEASE_MESSAGE_ID, "wireMessageId": VERIFIED_WIRE_MESSAGE_ID,
                "code": binding, "local": local, "installed": installed, "remote": remote,
                "scope": "two-child-source-settings-only"}
        plan_sha = persist(PLAN, plan, exclusive=True)
        print(json.dumps({"ok": True, "mode": "plan", "planSha256": plan_sha, "releaseMessageId": VERIFIED_RELEASE_MESSAGE_ID,
                          "sourceSha256": snapshot.sha256, "keyStates": snapshot.key_states, "remoteWrites": False,
                          "localConfigurationWrites": False}))
        return
    raw_plan = read_regular(PLAN, MAX_DOCUMENT_BYTES, private=True)
    if not re.fullmatch(r"[a-f0-9]{64}", sys.argv[2]) or digest(raw_plan) != sys.argv[2]:
        raise Refusal("exact_reviewed_plan_digest_required")
    plan = json.loads(raw_plan)
    if (plan["code"] != binding or plan["local"] != local or plan["installed"] != installed
            or plan["releaseMessageId"] != VERIFIED_RELEASE_MESSAGE_ID or plan["wireMessageId"] != VERIFIED_WIRE_MESSAGE_ID):
        raise Refusal("reviewed_plan_binding_changed")
    receipt_path = ROOT / (".um1646-child-pair-apply-" + sys.argv[2] + ".json")
    if receipt_path.exists():
        raise Refusal("prior_attempt_preserved_no_retry")
    # The private local backup precedes the remote exclusive claim and every POST.
    backup = cas.prepare_backup(snapshot)
    receipt = {"rootPlanSha256": sys.argv[2], "releaseMessageId": VERIFIED_RELEASE_MESSAGE_ID,
               "phase": "local_backup_verified", "backup": backup, "localBefore": local}
    persist(receipt_path, receipt, exclusive=True)
    try:
        canonical = remote_call("apply", binding, plan["remote"], sys.argv[2])
    except Exception:
        receipt["phase"] = "remote_outcome_unknown_or_stopped"
        persist(receipt_path, receipt)
        raise
    if canonical.get("sourceOfTruthComplete") is not True:
        raise Refusal("remote_canonical_completion_unproven")
    receipt.update(phase="canonical_complete_local_pending", remote=canonical)
    persist(receipt_path, receipt)
    if code_binding() != binding or installed_binding() != installed:
        raise Refusal("canonical_preserved_local_code_or_runtime_changed")
    result = cas.apply_local(snapshot)
    after = cas.snapshot()
    if any(state != "equal" for state in after.key_states.values()) or (after.uid, after.gid, after.mode) != (snapshot.uid, snapshot.gid, snapshot.mode) or not after.content.startswith(snapshot.content):
        raise Refusal("local_readback_identity_or_preservation_failed")
    receipt.update(phase="complete", localResult=result, localAfter=local_binding(cas, after), unrelatedBytesPreserved=True)
    receipt_sha = persist(receipt_path, receipt)
    print(json.dumps({"ok": True, "mode": "apply", "receiptSha256": receipt_sha, "sourceOfTruthComplete": True,
                      "localReadbackVerified": True, "unrelatedBytesPreserved": True, "changedRuntimeKeys": sorted(RUNTIME_DESIRED),
                      "plistsChanged": False, "credentialMapsChanged": False, "checkpointsChanged": False, "collectorInvoked": False}))


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print(json.dumps({"ok": False, "reason": error.code, **error.fields}))
        raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"ok": False, "reason": "operation_stopped_inspect_before_retry", "errorClass": type(error).__name__}))
        raise SystemExit(1)
