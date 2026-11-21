#!/usr/bin/env python3
"""Prepare or explicitly apply a digest-bound UM-1646 inventory update."""

from __future__ import annotations

import argparse
import base64
import difflib
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


SESSION = "01a18e51-51e1-7093-9269-0901397a9ec1"
NOTE_TITLE = "⭐️ Background Jobs Master List"
INVENTORY_PATH = "/Users/jay/apps/MAC-LOCAL-PROCESSES.md"
INVENTORY_START = b"## Usage Monitor Telemetry (UM-1646)"
NOTE_START = b"Usage Monitor Telemetry ("
NOTE_END = b"<div>Private runtime routing and credentials remain in the private operations inventory and Infisical.</div>"
PLAN_PATH = Path(__file__).resolve().parent / ".um1646-inventory-update.plan.json"
MAX_INVENTORY_BYTES = 4 * 1024 * 1024
MAX_NOTE_BYTES = 2 * 1024 * 1024

HUB_DESCRIPTION = (
    "Always-on server container; active; source 0a92fcfa; "
    "program node /app/scripts/telemetry-hub/start-with-infisical.mjs; restart unless-stopped; "
    "logs Docker stdout/stderr; generated span/log numeric aliases stored in Sentry; independently "
    "healthy after the same-service upgrade from Usage-Monitor PR #1874; original durable volume "
    "and configuration preserved; ambiguous acknowledgements are held for reconciliation."
)
HUB_ROW = f"| usage-monitor-telemetry-hub | {HUB_DESCRIPTION} |".encode("utf-8")

BRIDGE_DESCRIPTION = (
    "Server collector installation: 55 files at ca19ad6; Mac: 54 files at ca19ad6 plus the Muse "
    "file at 7424ae0; both hosts verified "
    "installed/imported; all four CLI sources configured for authenticated hub delivery; Mac jobs "
    "reloaded with guarded config readbacks; delivery uses the existing four CLI collector schedules; "
    "independent durable delivery inside existing invocations; no additional daemon.\u00a0 "
    "Muse source 7424ae0 is installed but remains unloaded under the injector hold; no Muse job is loaded."
)
BRIDGE_ROW = f"| Collector Sentry bridge | {BRIDGE_DESCRIPTION} |".encode("utf-8")

BOTFLEET_OLD_TAIL = (
    b"Its child OpenCode data-root location remains unverified after the child exited; "
    b"the standalone source is unchanged."
)
BOTFLEET_NEW_TAIL = (
    "The standalone OpenCode source is unchanged.\u00a0 The permanent server child sources are "
    "verified: the OpenCode database is /mnt/fleet-extra/apps/botfleet-server/home/.local/share/"
    "opencode/opencode.db and the workspace root is /mnt/fleet-extra/apps/botfleet-server/data/"
    "workspaces; all eight retained child events are classified BotFleet."
).encode("utf-8")

PRUNE_DESCRIPTION = (
    "On-demand only; bounded receipt pruning requires a verified checkpoint and preserves pending "
    "or quarantined records."
)
RETRY_DESCRIPTION = (
    "On-demand only; retries explicitly selected quarantined records after correction."
)
AUDIT_DESCRIPTION = (
    "Task-scoped on-demand helper; approved Mac Python read route; stdout aggregate receipt counts only; "
    "no scheduler."
)

CAS_REMOTE_SCRIPT = r'''import base64,hashlib,json,os,stat,sys,tempfile
path="/Users/jay/apps/MAC-LOCAL-PROCESSES.md"
MAX=4*1024*1024
def bad(reason):
    print(json.dumps({"state":"refused","reason":reason},sort_keys=True)); raise SystemExit(2)
def read_source():
    try: before=os.lstat(path)
    except OSError: bad("inventory_unavailable")
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_size > MAX: bad("inventory_metadata_invalid")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NONBLOCK",0))
    try:
        opened=os.fstat(fd)
        if (opened.st_dev,opened.st_ino,opened.st_size,opened.st_mtime_ns,opened.st_uid,opened.st_gid,stat.S_IMODE(opened.st_mode)) != (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode)): bad("inventory_changed")
        chunks=[]; remaining=MAX+1
        while remaining:
            part=os.read(fd,min(65536,remaining))
            if not part: break
            chunks.append(part); remaining-=len(part)
        data=b"".join(chunks); after=os.fstat(fd)
        if len(data)>MAX or len(data)!=before.st_size or after.st_mtime_ns!=before.st_mtime_ns: bad("inventory_changed")
        return data,before
    finally: os.close(fd)
try:
    payload=json.load(sys.stdin); expected=payload["beforeSha256"]; old_section=base64.b64decode(payload["beforeSection"],validate=True); new_section=base64.b64decode(payload["afterSection"],validate=True); new_sha=payload["afterSha256"]
    data,before=read_source(); current=hashlib.sha256(data).hexdigest()
    marker=b"## Usage Monitor Telemetry (UM-1646)"; start=data.find(marker); end=data.find(b"\n## ",start+len(marker))
    if start<0 or data.find(marker,start+1)>=0: bad("inventory_section_invalid")
    end=end if end>=0 else len(data); current_section=data[start:end]
    if current==new_sha and current_section==new_section:
        print(json.dumps({"state":"already_applied","sha256":current},sort_keys=True)); raise SystemExit(0)
    if current!=expected or current_section!=old_section: bad("inventory_compare_failed")
    new=data[:start]+new_section+data[end:]
    if hashlib.sha256(new).hexdigest()!=new_sha: bad("inventory_target_hash_invalid")
    fd,temp_path=tempfile.mkstemp(prefix=".MAC-LOCAL-PROCESSES.um1646-",dir=os.path.dirname(path))
    temp_info=os.fstat(fd)
    try:
        os.fchown(fd,before.st_uid,before.st_gid); os.fchmod(fd,stat.S_IMODE(before.st_mode))
        view=memoryview(new)
        while view:
            n=os.write(fd,view)
            if n<=0: bad("inventory_write_failed")
            view=view[n:]
        os.fsync(fd)
        staged=os.fstat(fd)
        if (staged.st_uid,staged.st_gid,stat.S_IMODE(staged.st_mode),staged.st_size)!=(before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode),len(new)): bad("inventory_stage_invalid")
    except BaseException:
        os.close(fd)
        try:
            cur=os.lstat(temp_path)
            if (cur.st_dev,cur.st_ino)==(temp_info.st_dev,temp_info.st_ino): os.unlink(temp_path)
        except OSError: pass
        raise
    os.close(fd)
    latest,info=read_source(); latest_hash=hashlib.sha256(latest).hexdigest(); latest_start=latest.find(marker); latest_end=latest.find(b"\n## ",latest_start+len(marker)); latest_end=latest_end if latest_end>=0 else len(latest)
    if latest_hash!=expected or latest[latest_start:latest_end]!=old_section or (info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(before.st_dev,before.st_ino,before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode)): bad("inventory_compare_failed")
    os.replace(temp_path,path)
    dfd=os.open(os.path.dirname(path),os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
    try: os.fsync(dfd)
    finally: os.close(dfd)
    written,_=read_source(); observed=hashlib.sha256(written).hexdigest()
    if observed!=new_sha: bad("inventory_readback_mismatch")
    print(json.dumps({"state":"written","sha256":observed},sort_keys=True))
except SystemExit: raise
except Exception as error:
    print(json.dumps({"state":"failed","errorType":type(error).__name__},sort_keys=True)); raise SystemExit(1)
'''

NOTE_TEMP_SCRIPT = r'''import json,os,stat,sys,tempfile
data=sys.stdin.buffer.read(2*1024*1024+1)
if len(data)>2*1024*1024: raise SystemExit(2)
fd,path=tempfile.mkstemp(prefix="um1646-note-",suffix=".html",dir="/tmp")
os.fchmod(fd,0o600)
with os.fdopen(fd,"wb") as out:
    out.write(data); out.flush(); os.fsync(out.fileno())
print(json.dumps({"path":path},sort_keys=True))
'''

NOTE_CLEANUP_SCRIPT = r'''import json,os,stat,sys
path=sys.argv[1]
if not path.startswith("/tmp/um1646-note-") or not path.endswith(".html"): raise SystemExit(2)
try: st=os.lstat(path)
except FileNotFoundError: raise SystemExit(0)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600: raise SystemExit(3)
os.unlink(path)
'''


class UpdateFailure(Exception):
    """A sanitized refusal containing a reason code only."""


def _fail(reason: str) -> UpdateFailure:
    return UpdateFailure(reason)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ssh(remote_command: str, *, input_bytes: bytes | None = None,
         timeout: int = 60) -> bytes:
    try:
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mac", remote_command],
            input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        raise _fail("mac_route_timeout") from None
    except OSError as error:
        raise _fail(type(error).__name__) from None
    if result.returncode:
        raise _fail("mac_route_failed")
    return result.stdout


def _read_inventory() -> tuple[bytes, bytes]:
    reader = (
        "import hashlib,json; from pathlib import Path; "
        f"p=Path({INVENTORY_PATH!r}); b=p.read_bytes(); "
        f"m={INVENTORY_START.decode('utf-8')!r}.encode(); s=b.index(m); "
        "e=b.find(b'\\n## ',s+len(m)); section=b[s:e if e>=0 else None]; "
        "print(json.dumps({'sha256':hashlib.sha256(b).hexdigest(),'section':section.decode('utf-8')}))"
    )
    output = _ssh("python3 -c " + shlex.quote(reader), timeout=30)
    try:
        value = json.loads(output)
        section = value["section"].encode("utf-8")
        digest = value["sha256"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        raise _fail("inventory_read_result_invalid") from None
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or len(section) > MAX_INVENTORY_BYTES:
        raise _fail("inventory_read_result_invalid")
    return digest.encode("ascii"), section


def _read_note() -> bytes:
    command = (
        "simple-notes --as CODEX --session " + SESSION +
        " read --format html " + shlex.quote(NOTE_TITLE)
    )
    data = _ssh(command, timeout=90)
    if not data or len(data) > MAX_NOTE_BYTES:
        raise _fail("note_read_size_invalid")
    return data


def _replace_inventory_rows(section: bytes) -> bytes:
    lines = section.splitlines(keepends=True)
    replacements = {
        b"| usage-monitor-telemetry-hub |": HUB_ROW,
        b"| Collector Sentry bridge |": BRIDGE_ROW,
    }
    updated: dict[bytes, int] = {prefix: 0 for prefix in replacements}
    result: list[bytes] = []
    for line in lines:
        matched = False
        for prefix, value in replacements.items():
            if line.startswith(prefix):
                newline = b"\r\n" if line.endswith(b"\r\n") else b"\n" if line.endswith(b"\n") else b""
                result.append(value + newline)
                updated[prefix] += 1
                matched = True
                break
        if not matched and line.startswith(b"| botfleet-session-collector.mjs |"):
            if line.count(BOTFLEET_OLD_TAIL) != 1:
                raise _fail("botfleet_old_clause_mismatch")
            line = line.replace(BOTFLEET_OLD_TAIL, BOTFLEET_NEW_TAIL, 1)
            line = line.replace(b"Linux ordinary native activity remains zero", b"The earlier Linux native audit found no ordinary activity", 1)
            updated[b"botfleet-session-collector.mjs"] = updated.get(b"botfleet-session-collector.mjs", 0) + 1
            result.append(line)
            matched = True
        if not matched:
            result.append(line)
    if updated.get(b"| usage-monitor-telemetry-hub |") != 1 or updated.get(b"| Collector Sentry bridge |") != 1 or updated.get(b"botfleet-session-collector.mjs") != 1:
        raise _fail("inventory_target_rows_not_unique")
    return b"".join(result)


def _note_rows(inventory_section: bytes) -> bytes:
    labels = (
        b"usage-monitor-telemetry-hub",
        b"Collector Sentry bridge",
        b"scripts/prune-collector-sentry-outbox.mjs",
        b"scripts/retry-collector-sentry-outbox.mjs",
        b"botfleet-session-collector.mjs",
        b"UM-1646 Sentry Receipt Audit",
    )
    found: dict[bytes, bytes] = {}
    for line in inventory_section.splitlines():
        if not line.startswith(b"|"):
            continue
        fields = line.split(b"|", 2)
        if len(fields) != 3:
            continue
        label, description = fields[1].strip(), fields[2].rsplit(b"|", 1)[0].strip()
        if label in labels:
            if label in found:
                raise _fail("inventory_note_row_not_unique")
            found[label] = description
    if tuple(label for label in labels if label in found) != labels:
        raise _fail("inventory_note_rows_incomplete")
    values = []
    for label in labels:
        values.append(
            "<li><b>" + html.escape(label.decode("utf-8")) + "</b>: "
            + html.escape(found[label].decode("utf-8")) + "</li>"
        )
    return ("<ul>" + "".join(values) + "</ul>").encode("utf-8")


def _note_section(html_body: bytes) -> tuple[int, int, int, bytes]:
    text_start = html_body.rfind(NOTE_START)
    if text_start < 0 or html_body.find(NOTE_START) != text_start:
        raise _fail("note_section_start_not_unique")
    start = html_body.rfind(b"<div>", 0, text_start)
    if start < 0:
        raise _fail("note_section_start_invalid")
    end = html_body.find(NOTE_END, start)
    if end < 0 or html_body.find(NOTE_END, end + len(NOTE_END)) >= 0:
        raise _fail("note_section_end_not_unique")
    heading_end = html_body.find(b"</div>", start)
    if heading_end < 0 or heading_end + len(b"</div>") > end:
        raise _fail("note_heading_invalid")
    heading_end += len(b"</div>")
    return start, end, heading_end, html_body[start:end]


def _note_after(note: bytes, inventory_section: bytes) -> tuple[bytes, bytes, bytes]:
    start, end, heading_end, before_section = _note_section(note)
    body = note[heading_end:end]
    if body != b"\n<div><br></div>\n<div><br><br></div>\n":
        raise _fail("note_target_section_not_blank")
    body = b"\n" + _note_rows(inventory_section) + b"\n<div><br><br></div>\n"
    new_section = note[start:heading_end] + body
    after = note[:start] + new_section + note[end:]
    return after, before_section, new_section


def _read_local_plan(path: Path, digest: str) -> tuple[dict[str, object], bytes]:
    try:
        before = os.lstat(path)
    except OSError:
        raise _fail("plan_unavailable") from None
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > MAX_NOTE_BYTES):
        raise _fail("plan_metadata_invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise _fail("plan_open_failed") from None
    try:
        chunks = []
        remaining = MAX_NOTE_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    if len(data) > MAX_NOTE_BYTES or _sha(data) != digest:
        raise _fail("plan_digest_mismatch")
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _fail("plan_json_invalid") from None
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise _fail("plan_schema_invalid")
    return value, data


def _write_plan(plan: dict[str, object]) -> str:
    data = json.dumps(plan, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(PLAN_PATH, flags, 0o600)
    except OSError:
        raise _fail("plan_already_exists_or_unavailable") from None
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise _fail("plan_write_failed")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(PLAN_PATH.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return _sha(data)


def prepare_plan() -> dict[str, object]:
    inventory_before_sha, inventory_before = _read_inventory()
    note_before = _read_note()
    inventory_after_section = _replace_inventory_rows(inventory_before)
    inventory_after_sha = _remote_inventory_after_hash(
        inventory_before_sha.decode("ascii"), inventory_before, inventory_after_section,
    )
    note_after, note_before_section, note_after_section = _note_after(note_before, inventory_after_section)
    inventory_diff = "".join(difflib.unified_diff(
        inventory_before.decode("utf-8").splitlines(keepends=True),
        inventory_after_section.decode("utf-8").splitlines(keepends=True),
        fromfile="MAC-LOCAL-PROCESSES.md:UM-1646 before",
        tofile="MAC-LOCAL-PROCESSES.md:UM-1646 after",
    ))
    note_diff = "".join(difflib.unified_diff(
        note_before_section.decode("utf-8").splitlines(keepends=True),
        note_after_section.decode("utf-8").splitlines(keepends=True),
        fromfile="Background Jobs Master List:UM-1646 before",
        tofile="Background Jobs Master List:UM-1646 after",
    ))
    return {
        "schema": 1,
        "task": "UM-1646 inventory completion",
        "session": SESSION,
        "inventory": {
            "path": INVENTORY_PATH,
            "beforeSha256": inventory_before_sha.decode("ascii"),
            "beforeSectionSha256": _sha(inventory_before),
            "afterSectionSha256": _sha(inventory_after_section),
            "afterSha256": inventory_after_sha,
            "sectionBefore": inventory_before.decode("utf-8"),
            "sectionAfter": inventory_after_section.decode("utf-8"),
            "diff": inventory_diff,
        },
        "note": {
            "title": NOTE_TITLE,
            "beforeSha256": _sha(note_before),
            "beforeSectionSha256": _sha(note_before_section),
            "afterSectionSha256": _sha(note_after_section),
            "afterSha256": _sha(note_after),
            "sectionBefore": note_before_section.decode("utf-8"),
            "sectionAfter": note_after_section.decode("utf-8"),
            "diff": note_diff,
        },
        "applyRequiresExactPlanSha256": True,
        "writes": False,
    }


def _read_inventory_section_and_hash() -> tuple[str, bytes]:
    digest, section = _read_inventory()
    return digest.decode("ascii"), section


def _apply_inventory(before_sha: str, expected_after_sha: str, updated_section: bytes,
                     original_section: bytes) -> None:
    current_sha, current_section = _read_inventory_section_and_hash()
    if current_sha == expected_after_sha:
        return
    if current_sha != before_sha or current_section != original_section:
        raise _fail("inventory_fresh_compare_failed")
    # The remote writer receives only the changed target section and checks the full source hash itself.
    payload = {
        "beforeSha256": before_sha,
        "afterSha256": expected_after_sha,
        "beforeSection": base64.b64encode(original_section).decode("ascii"),
        "afterSection": base64.b64encode(updated_section).decode("ascii"),
    }
    result = _ssh("python3 -c " + shlex.quote(CAS_REMOTE_SCRIPT),
                  input_bytes=json.dumps(payload, separators=(",", ":")).encode("utf-8"), timeout=45)
    try:
        status = json.loads(result)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _fail("inventory_write_receipt_invalid") from None
    if not isinstance(status, dict) or status.get("state") not in {"written", "already_applied"} or status.get("sha256") != expected_after_sha:
        raise _fail("inventory_write_failed")


def _write_note_temp(data: bytes) -> str:
    result = _ssh("python3 -c " + shlex.quote(NOTE_TEMP_SCRIPT), input_bytes=data, timeout=30)
    try:
        path = json.loads(result)["path"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        raise _fail("note_temp_creation_failed") from None
    if not isinstance(path, str) or not re.fullmatch(r"/tmp/um1646-note-[A-Za-z0-9_-]+\.html", path):
        raise _fail("note_temp_path_invalid")
    return path


def _cleanup_note_temp(path: str) -> None:
    command = "python3 -c " + shlex.quote(NOTE_CLEANUP_SCRIPT) + " " + shlex.quote(path)
    try:
        _ssh(command, timeout=15)
    except UpdateFailure:
        pass


def _update_note(path: str, plan_sha: str) -> None:
    command = (
        "simple-notes --as CODEX --session " + SESSION + " update " + shlex.quote(NOTE_TITLE)
        + " --html " + shlex.quote(path) + " --request-id um1646-" + plan_sha[:40]
    )
    _ssh(command, timeout=150)


def apply_plan(plan: dict[str, object], plan_sha: str) -> dict[str, object]:
    inv = plan["inventory"]
    note = plan["note"]
    inv_before = inv["beforeSha256"]
    note_before = note["beforeSha256"]
    inv_after_section = inv["sectionAfter"].encode("utf-8")
    inv_before_section = inv["sectionBefore"].encode("utf-8")
    note_after_section = note["sectionAfter"].encode("utf-8")

    inventory_sha, inventory_section = _read_inventory_section_and_hash()
    note_html = _read_note()
    note_sha = _sha(note_html)
    if inventory_sha not in {inv_before, inv.get("afterSha256")} or note_sha not in {note_before, note["afterSha256"]}:
        raise _fail("fresh_full_source_compare_failed")
    if inventory_sha == inv_before and inventory_section != inv_before_section:
        raise _fail("inventory_section_compare_failed")
    if inventory_sha == inv.get("afterSha256") and inventory_section != inv_after_section:
        raise _fail("inventory_after_section_mismatch")
    if note_sha == note_before:
        fresh_note_after, fresh_note_before_section, fresh_note_after_section = _note_after(note_html, inv_after_section)
        if (_sha(fresh_note_before_section) != note["beforeSectionSha256"]
                or fresh_note_after_section != note_after_section
                or _sha(fresh_note_after) != note["afterSha256"]):
            raise _fail("note_section_compare_failed")
    elif note_sha == note["afterSha256"]:
        _, _, _, current_note_section = _note_section(note_html)
        if current_note_section != note_after_section:
            raise _fail("note_after_section_mismatch")

    if inventory_sha == inv_before:
        inventory_hash_again, inventory_section_again = _read_inventory_section_and_hash()
        note_html_again = _read_note()
        if (inventory_hash_again != inv_before or inventory_section_again != inv_before_section
                or _sha(note_html_again) != note_before):
            raise _fail("prewrite_full_source_compare_failed")
        updated_full_section = _replace_inventory_rows(inventory_section_again)
        _apply_inventory(inv_before, inv["afterSha256"], updated_full_section, inventory_section_again)

    if _sha(_read_note()) == note_before:
        current_note = _read_note()
        if _sha(current_note) != note_before:
            raise _fail("note_prewrite_compare_failed")
        new_note, _, _ = _note_after(current_note, inv_after_section)
        if _sha(new_note) != note["afterSha256"]:
            raise _fail("note_after_hash_mismatch")
        temp_path = _write_note_temp(new_note)
        try:
            if _sha(_read_note()) != note_before:
                raise _fail("note_prewrite_compare_failed")
            _update_note(temp_path, plan_sha)
        finally:
            _cleanup_note_temp(temp_path)

    inventory_final, _ = _read_inventory_section_and_hash()
    note_final = _sha(_read_note())
    if inventory_final != inv["afterSha256"] or note_final != note["afterSha256"]:
        raise _fail("final_readback_hash_mismatch")
    return {"state": "applied_and_verified", "inventorySha256": inventory_final,
            "noteSha256": note_final, "planSha256": plan_sha}


def _remote_inventory_after_hash(before_sha: str, before_section: bytes,
                                 after_section: bytes) -> str:
    code = (
        "import hashlib,json; from pathlib import Path; "
        f"p=Path({INVENTORY_PATH!r}); b=p.read_bytes(); "
        "start=b.index(b'## Usage Monitor Telemetry (UM-1646)'); "
        "end=b.find(b'\\n## ',start+1); end=end if end>=0 else len(b); "
        "assert hashlib.sha256(b).hexdigest()==" + repr(before_sha) + "; "
        "assert b[start:end]==" + repr(before_section) + "; "
        "a=b[:start]+" + repr(after_section) + "+b[end:]; "
        "print(hashlib.sha256(a).hexdigest())"
    )
    # This read-only hash calculation uses the exact current source bytes and the target section bytes.
    output = _ssh("python3 -c " + shlex.quote(code), timeout=30).decode("ascii", "strict").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", output):
        raise _fail("inventory_after_hash_invalid")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", metavar="PLAN_SHA256", help="apply only this exact private plan")
    args = parser.parse_args()
    if args.apply is None:
        plan = prepare_plan()
        plan_sha = _write_plan(plan)
        print(json.dumps({
            "phase": "plan",
            "planPath": str(PLAN_PATH),
            "planSha256": plan_sha,
            "inventoryBeforeSha256": plan["inventory"]["beforeSha256"],
            "noteBeforeSha256": plan["note"]["beforeSha256"],
            "writes": False,
        }, sort_keys=True))
        return 0
    if not re.fullmatch(r"[a-f0-9]{64}", args.apply):
        raise _fail("invalid_plan_sha256")
    plan, _ = _read_local_plan(PLAN_PATH, args.apply)
    result = apply_plan(plan, args.apply)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except UpdateFailure as error:
        print(json.dumps({"phase": "refused", "reason": str(error)}, sort_keys=True))
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"phase": "failed", "errorType": type(error).__name__}, sort_keys=True))
        sys.exit(1)
