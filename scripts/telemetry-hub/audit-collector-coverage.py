#!/usr/bin/env python3
"""Offline by default; explicitly audit fixed local Mac collector metadata only."""
import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import stat
import subprocess
import time
from pathlib import Path


MAX_FILE_BYTES = 1024 * 1024
MAX_TREE_ENTRIES = 20000
JOBS = {
    "kimi-code": "com.jays.kimi-usage-collector",
    "zcode": "com.jays.zcode-usage-collector",
    "muse-code": "com.jays.muse-code-usage-collector",
    "muse": "com.jays.muse-usage-collector",
    "antigravity": "com.jays.antigravity-session-collector",
    "grok": "com.jays.grok-usage-collector",
    "fx": "com.jays.fx-usage-collector",
}
SCRIPTS = (
    "kimi-usage-collector.mjs", "zcode-usage-collector.mjs",
    "muse-code-usage-collector.mjs", "muse-usage-collector.mjs",
    "antigravity-session-collector.mjs", "collector-injector.mjs",
)


def bounded_file(path, limit=MAX_FILE_BYTES):
    """Read a regular owned file through nonsymlink components, without writes."""
    path = Path(path)
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        raise ValueError("invalid path")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    descriptor = None
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or not 0 <= before.st_size <= limit:
            raise ValueError("unavailable bounded owned file")
        content = bytearray()
        while len(content) < before.st_size:
            chunk = os.read(descriptor, before.st_size - len(content))
            if not chunk:
                raise ValueError("file changed")
            content.extend(chunk)
        after = os.fstat(descriptor)
        if any(getattr(before, key) != getattr(after, key) for key in ("st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_uid")):
            raise ValueError("file changed")
        return bytes(content)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def metadata(path, now):
    """Stat only: never open native transcript, database, checkpoint or log data."""
    try:
        info = path.lstat()
        if path.is_symlink():
            return {"present": True, "symlink": True, "inspected": False}
        if path.resolve() != path:
            return {"present": True, "inspected": False}
        return {"present": True, "regular": stat.S_ISREG(info.st_mode),
                "directory": stat.S_ISDIR(info.st_mode),
                "age_seconds": max(0, int(now - info.st_mtime)), "bytes": info.st_size}
    except FileNotFoundError:
        return {"present": False}
    except OSError:
        return {"present": None, "inspected": False}


def tree_metadata(path, now):
    result = metadata(path, now)
    if not result.get("directory"):
        return result
    entries = files = wire_files = 0
    newest = None
    stack = [path]
    try:
        while stack:
            current = stack.pop()
            # Refuse observed symlink substitution; same-owner concurrent mutation
            # is outside the fixed trusted source-directory assumption.
            if current.is_symlink() or current.resolve() != current:
                raise ValueError("source directory changed")
            with os.scandir(current) as scan:
                for entry in scan:
                    entries += 1
                    if entries > MAX_TREE_ENTRIES:
                        result["complete"] = False
                        result["entry_limit_reached"] = True
                        return result
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        stack.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode):
                        files += 1
                        wire_files += entry.name == "wire.jsonl"
                        newest = info.st_mtime if newest is None else max(newest, info.st_mtime)
        result.update(complete=True, files=files, wire_files=wire_files,
                      newest_file_age_seconds=max(0, int(now - newest)) if newest is not None else None)
    except (OSError, ValueError):
        result["complete"] = False
    return result


def job_metadata(home, producer, label):
    row = {"producer": producer}
    path = home / "Library" / "LaunchAgents" / (label + ".plist")
    try:
        config = plistlib.loads(bounded_file(path))
    except FileNotFoundError:
        return {**row, "configured": False}
    except Exception:
        return {**row, "configured": None, "inspection_failed": True}
    row["configured"] = True
    arguments = config.get("ProgramArguments", [])
    row["injector_argument_present"] = isinstance(arguments, list) and any(
        isinstance(value, str) and value.endswith("/collector-injector.mjs") for value in arguments)
    interval = config.get("StartInterval")
    row["interval_seconds"] = interval if type(interval) is int and 0 < interval < 86400 else None
    # Plist environment, arbitrary arguments and launchctl output are never emitted.
    del config, arguments
    try:
        reply = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=8)
        row["loaded"] = reply.returncode == 0
        if len(reply.stdout) > MAX_FILE_BYTES:
            row["state_inspected"] = False
        else:
            match = re.search(rb"last exit code = (-?\d{1,10})(?:\s|$)", reply.stdout)
            row["last_exit_code"] = int(match.group(1)) if match else None
    except (OSError, subprocess.TimeoutExpired):
        row["loaded"] = None
    return row


def audit(home):
    now = time.time()
    installed = home / "apps" / "usage-monitor-collectors"
    installation = {}
    try:
        match = re.search(rb"^sha=([a-f0-9]{7,40})$", bounded_file(installed / "VERSION"), re.M)
        installation["revision"] = match.group(1).decode() if match else None
    except Exception:
        installation["revision"] = None
    installation["script_sha256"] = {}
    for name in SCRIPTS:
        try:
            installation["script_sha256"][name] = hashlib.sha256(bounded_file(installed / "scripts" / name)).hexdigest()
        except FileNotFoundError:
            installation["script_sha256"][name] = None
        except Exception:
            installation["script_sha256"][name] = "unverified"
    for name in ("current", "previous"):
        link = home / "apps" / "usage-monitor-collector-runtime" / name
        installation[name + "_pointer_present"] = link.is_symlink()
    sources = {"kimi-code": tree_metadata(home / ".kimi-code" / "sessions", now),
               "kimi-index": metadata(home / ".kimi-code" / "session_index.jsonl", now),
               "zcode": metadata(home / ".zcode" / "cli" / "db" / "db.sqlite", now),
               "muse": tree_metadata(home / ".local" / "share" / "muse" / "sessions", now),
               "antigravity": metadata(home / ".cache" / "usage-monitor" / "antigravity-statusline" / "usage.jsonl", now),
               "grok": tree_metadata(home / ".grok" / "sessions", now),
               "fx": metadata(home / ".fx" / "usage.jsonl", now)}
    return {"host_role": "mac", "installation": installation,
            "jobs": [job_metadata(home, producer, label) for producer, label in JOBS.items()],
            "native_source_metadata": sources,
            "limitations": ["default source paths only; per-job source overrides not inspected",
                            "source presence does not prove usable exact usage records",
                            "no direct Usage Monitor ACK or stored ledger read",
                            "no hub journal or Sentry stored receipt read",
                            "concurrent same-owner changes can make fields non-atomic"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-local-mac", action="store_true")
    args = parser.parse_args()
    if not args.audit_local_mac:
        print(json.dumps({"mode": "offline_plan", "hosts": ["existing authorized Mac SSH target"],
                          "operations": ["bounded owned installed source/plist reads", "native source stat", "fixed launchctl print"],
                          "network_requests": 0, "writes": 0, "credential_reads": 0}))
        return
    if platform.system() != "Darwin" or Path.home() != Path("/Users/jay"):
        raise SystemExit("Refused: exact authorized Mac host context required")
    print(json.dumps(audit(Path.home())))


if __name__ == "__main__":
    main()
