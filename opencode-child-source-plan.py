#!/usr/bin/env python3
"""Create a private two-key plan without contacting or changing configuration."""

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys


SOURCE = Path("/home/jay/.secrets/usage-monitor.env")
PLAN = Path(__file__).with_name(".um1646-opencode-child-source-plan-v2.json")
SUPERSEDED_PLAN = Path(__file__).with_name(".um1646-opencode-child-source-plan.json")
SUPERSESSION_MARKER = Path(__file__).with_name(".um1646-opencode-child-source-plan-v1.superseded.json")
REVIEWED_GUARD_COMMIT = "ca19ad6ab8e98b5ac506d75d15b72dd0b9cd9015"
MAX_SOURCE_BYTES = 4 * 1024 * 1024
EXPECTED_VALUES = {
    "OPENCODE_SERVER_ADDITIONAL_DBS_JSON": json.dumps(
        ["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"],
        separators=(",", ":"),
    ),
    "BOTFLEET_SERVER_WORKSPACES_DIRS": "/mnt/fleet-extra/apps/botfleet-server/data/workspaces",
}
RUNTIME_KEYS = {
    "OPENCODE_SERVER_ADDITIONAL_DBS_JSON": "OPENCODE_ADDITIONAL_DBS_JSON",
    "BOTFLEET_SERVER_WORKSPACES_DIRS": "BOTFLEET_WORKSPACES_DIRS",
}


def fail(message):
    raise SystemExit(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def parse_current_values(raw):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("Runtime snapshot is not valid UTF-8")
    values = {}
    for key in RUNTIME_KEYS.values():
        pattern = re.compile(r"^(?:export\s+)?" + re.escape(key) + r"=(.*)$")
        matches = [pattern.match(line) for line in lines]
        matches = [match for match in matches if match is not None]
        if not matches:
            values[key] = None
            continue
        if len(matches) != 1:
            fail("Runtime snapshot has duplicate requested key: " + key)
        try:
            parsed = shlex.split(matches[0].group(1), comments=True, posix=True)
        except ValueError:
            fail("Runtime snapshot has an invalid requested value for " + key)
        if len(parsed) != 1:
            fail("Runtime snapshot has an invalid requested value for " + key)
        values[key] = parsed[0]
    return values


def read_approved_source():
    try:
        before = SOURCE.lstat()
        if not stat.S_ISREG(before.st_mode):
            fail("Runtime snapshot must be a regular file")
        fd = os.open(SOURCE, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail("Runtime snapshot is unavailable through the no-follow route")
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.getuid()
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or stat.S_IMODE(opened.st_mode) & 0o077
        ):
            fail("Runtime snapshot owner, mode, or identity is unsafe")
        chunks = []
        remaining = MAX_SOURCE_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 64 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        if (
            len(raw) > MAX_SOURCE_BYTES
            or after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_dev != opened.st_dev
            or after.st_ino != opened.st_ino
        ):
            fail("Runtime snapshot changed during bounded read")
    finally:
        os.close(fd)
    try:
        final_path = SOURCE.lstat()
    except OSError:
        fail("Runtime snapshot changed during bounded read")
    if (
        final_path.st_dev != opened.st_dev
        or final_path.st_ino != opened.st_ino
        or not stat.S_ISREG(final_path.st_mode)
    ):
        fail("Approved source path changed during bounded read")
    return raw, opened


if len(sys.argv) != 1:
    fail("This planner accepts no arguments and has no apply mode")

source_bytes, source_stat = read_approved_source()
source_values = parse_current_values(source_bytes)

bindings = []
for source_key, runtime_key in RUNTIME_KEYS.items():
    current_value = source_values[runtime_key]
    desired_value = EXPECTED_VALUES[source_key]
    if current_value is not None and current_value != desired_value:
        fail("Runtime snapshot contains a different value for " + runtime_key)
    if source_key == "OPENCODE_SERVER_ADDITIONAL_DBS_JSON":
        try:
            parsed = json.loads(desired_value)
        except json.JSONDecodeError:
            fail("Reviewed OpenCode desired value is not valid JSON")
        if parsed != ["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"]:
            fail("Reviewed OpenCode selection differs from the single database")
    bindings.append({
        "sourceKey": source_key,
        "runtimeKey": runtime_key,
        "currentState": "absent" if current_value is None else "already-equal",
        "currentValueSha256": None if current_value is None else sha256(current_value.encode()),
        "desiredValueSha256": sha256(desired_value.encode()),
    })

plan = {
    "schema": "usage-monitor-collector-config-plan-v1",
    "mode": "plan-only",
    "supersedes": ".um1646-opencode-child-source-plan.json",
    "supersedesReason": "Earlier planner checked source-key names in the runtime snapshot; this version checks the runtime-key names.",
    "source": {
        "kind": "approved-local-runtime-snapshot",
        "ownerMatchesCurrentUser": True,
        "modeOctal": format(stat.S_IMODE(source_stat.st_mode), "04o"),
        "regularFile": True,
        "nofollowOpen": True,
        "stableDuringRead": True,
        "sourceSha256": sha256(source_bytes),
    },
    "collectorGuard": {
        "reviewedCommit": REVIEWED_GUARD_COMMIT,
        "opencodeRuntimeKey": "OPENCODE_ADDITIONAL_DBS_JSON",
        "botfleetRuntimeKey": "BOTFLEET_WORKSPACES_DIRS",
        "runtimeInstallationRechecked": False,
    },
    "destination": {
        "environment": "prod",
        "secretPath": "/telemetry",
        "currentState": "not-verified-from-Infisical",
        "compareAndSwap": {
            "required": True,
            "mustBeAbsentBeforeWrite": True,
            "keys": list(RUNTIME_KEYS.keys()),
        },
    },
    "bindings": bindings,
    "sourceOfTruthRoute": "HELD_NOT_IMPLEMENTED",
    "currentStateEvidence": "local runtime snapshot only; Infisical remains unverified",
    "configurationMutation": False,
    "credentialAccess": False,
    "applyAvailable": False,
}

plan_bytes = (json.dumps(plan, sort_keys=True, indent=2) + "\n").encode()
try:
    plan_fd = os.open(PLAN, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
except FileExistsError:
    try:
        old_info = PLAN.lstat()
        old_fd = os.open(PLAN, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail("Existing v2 plan cannot be safely inspected")
    try:
        old_opened = os.fstat(old_fd)
        if (
            not stat.S_ISREG(old_info.st_mode)
            or old_opened.st_dev != old_info.st_dev
            or old_opened.st_ino != old_info.st_ino
            or old_opened.st_uid != os.getuid()
            or stat.S_IMODE(old_opened.st_mode) & 0o077
        ):
            fail("Existing v2 plan owner, mode, or identity is unsafe")
        old_raw = os.read(old_fd, 128 * 1024)
        old_plan = json.loads(old_raw)
    except (json.JSONDecodeError, OSError):
        fail("Existing v2 plan is not a valid private plan artifact")
    finally:
        os.close(old_fd)
    if (
        old_plan.get("mode") != "plan-only"
        or old_plan.get("collectorGuard", {}).get("reviewedCommit") != REVIEWED_GUARD_COMMIT
    ):
        fail("Existing v2 plan is not the earlier planner artifact")
    try:
        plan_fd = os.open(PLAN, os.O_WRONLY | os.O_NOFOLLOW)
    except OSError:
        fail("Existing v2 plan changed before safe regeneration")
    opened_for_write = os.fstat(plan_fd)
    if (
        opened_for_write.st_dev != old_info.st_dev
        or opened_for_write.st_ino != old_info.st_ino
        or opened_for_write.st_uid != os.getuid()
        or stat.S_IMODE(opened_for_write.st_mode) & 0o077
    ):
        os.close(plan_fd)
        fail("Existing v2 plan changed before safe regeneration")
    os.ftruncate(plan_fd, 0)
with os.fdopen(plan_fd, "wb") as handle:
    handle.write(plan_bytes)
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(PLAN, 0o600)

marker_record = {
    "status": "superseded",
    "priorPlan": SUPERSEDED_PLAN.name,
    "supersededBy": PLAN.name,
    "reason": plan["supersedesReason"],
}
marker_bytes = (json.dumps(marker_record, sort_keys=True, indent=2) + "\n").encode()
try:
    marker_fd = os.open(
        SUPERSESSION_MARKER,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
        0o600,
    )
except FileExistsError:
    try:
        marker_info = SUPERSESSION_MARKER.lstat()
        marker_fd = os.open(SUPERSESSION_MARKER, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        fail("Existing supersession marker is unsafe")
    try:
        marker_opened = os.fstat(marker_fd)
        if (
            not stat.S_ISREG(marker_info.st_mode)
            or marker_opened.st_dev != marker_info.st_dev
            or marker_opened.st_ino != marker_info.st_ino
            or marker_opened.st_uid != os.getuid()
            or stat.S_IMODE(marker_opened.st_mode) & 0o077
            or os.read(marker_fd, 16 * 1024) != marker_bytes
        ):
            fail("Existing supersession marker differs from the reviewed record")
    finally:
        os.close(marker_fd)
else:
    with os.fdopen(marker_fd, "wb") as handle:
        handle.write(marker_bytes)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(SUPERSESSION_MARKER, 0o600)

print(json.dumps({
    "mode": "plan-only",
    "localSnapshotVerified": True,
    "keyStates": [binding["currentState"] for binding in bindings],
    "bindingCount": len(bindings),
    "sourceSha256": plan["source"]["sourceSha256"],
    "desiredValueSha256": [binding["desiredValueSha256"] for binding in bindings],
    "remoteCurrentState": "not-verified-from-Infisical",
    "configurationMutation": False,
    "applyAvailable": False,
    "planSha256": sha256(plan_bytes),
}))
