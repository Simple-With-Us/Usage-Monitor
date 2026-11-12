#!/usr/bin/env python3
"""Prepare offline; explicitly inspect only the owner's security process ancestry."""
import argparse
import json
import os
import platform
from pathlib import Path
import re
import subprocess


MAX_SECURITY_PROCESSES = 16
MAX_ANCESTORS = 8
MAX_OUTPUT_BYTES = 16384
KNOWN_NAMES = frozenset({
    "security", "node", "nodejs", "launchd", "bash", "zsh", "sh",
    "python3", "python", "muse", "Muse", "Clutch", "BotFleet",
    "CodeCaps", "AgentBar", "Usage Monitor", "env", "sshd",
})
# Fixed candidates come from the fleet's documented tools, apps and runtimes.
# These are equality comparisons against comm metadata, never argv inspection.
NAME_CANDIDATES = {
    "fleet_secrets": ("fleet-secrets", "fleet-secrets.sh"),
    "infisical": ("infisical",),
    "fleet_cli": ("simple-chat", "simple-board", "simple-notes", "fleet-share"),
    "backup_helper": ("hk-backups-prune.sh",),
    "node": ("node", "nodejs"),
    "python": ("python", "python3", "python3.11", "python3.12", "python3.13", "python3.14"),
    "shell": ("sh", "bash", "zsh"),
    "env": ("env",),
    "security": ("security",),
    "launchd": ("launchd",),
    "ssh": ("ssh", "sshd"),
    "codex": ("codex", "Codex", "Codex Helper", "Codex Helper (Renderer)"),
    "claude": ("claude", "Claude", "Claude Helper", "Claude Helper (Renderer)"),
    "muse": ("muse", "Muse"),
    "clutch": ("Clutch", "ClutchMuseACP"),
    "botfleet": ("BotFleet", "botfleet"),
    "muster": ("Muster", "muster"),
    "codecaps": ("CodeCaps",),
    "agentbar": ("AgentBar",),
    "usage_monitor": ("Usage Monitor",),
}
PATH_CANDIDATES = {
    "system_security": "/usr/bin/security",
    "system_sh": "/bin/sh",
    "system_bash": "/bin/bash",
    "system_zsh": "/bin/zsh",
    "homebrew_bash": "/opt/homebrew/bin/bash",
    "homebrew_node": "/opt/homebrew/bin/node",
    "homebrew_node24": "/opt/homebrew/opt/node@24/bin/node",
    "local_fleet_secrets": "/Users/jay/.local/bin/fleet-secrets",
    "backup_helper": "/Users/jay/apps/hk-backups-prune/hk-backups-prune.sh",
    "codex_app": "/Applications/Codex.app/Contents/MacOS/Codex",
    "clutch_app": "/Applications/Clutch.app/Contents/MacOS/Clutch",
    "botfleet_app": "/Applications/BotFleet.app/Contents/MacOS/BotFleet",
    "muster_app": "/Applications/Muster.app/Contents/MacOS/Muster",
}


def executable_matches(comm):
    basename = comm.rsplit("/", 1)[-1]
    return {
        "candidate_name_matches": {key: basename in candidates for key, candidates in NAME_CANDIDATES.items()},
        "candidate_path_matches": {key: comm == candidate for key, candidate in PATH_CANDIDATES.items()},
    }


def bounded_run(arguments):
    # No shell, environment inspection, argv output or execution of security.
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=5, check=False)
    if len(result.stdout) > MAX_OUTPUT_BYTES or len(result.stderr) > MAX_OUTPUT_BYTES:
        raise ValueError("process metadata exceeded limit")
    return result.returncode, result.stdout.decode("utf-8", errors="strict")


def process_metadata(pid, run=bounded_run):
    if type(pid) is not int or not 0 < pid < 2**31:
        raise ValueError("invalid process identifier")
    code, output = run(["/bin/ps", "-p", str(pid), "-o", "pid=,ppid=,uid=,comm="])
    if code != 0 or not output.strip():
        return None
    lines = output.strip().splitlines()
    if len(lines) != 1:
        raise ValueError("unexpected process metadata shape")
    fields = lines[0].strip().split(None, 3)
    if len(fields) != 4 or any(not re.fullmatch(r"[0-9]{1,10}", field) for field in fields[:3]):
        raise ValueError("unexpected process metadata shape")
    actual, parent, uid = map(int, fields[:3])
    if actual != pid:
        raise ValueError("process identifier changed")
    basename = fields[3].rsplit("/", 1)[-1]
    # A process can alter its display name; do not echo arbitrary process text.
    name = basename if basename in KNOWN_NAMES else "other"
    return {"pid": actual, "ppid": parent, "uid": uid, "executable_name": name,
            **executable_matches(fields[3])}


def audit(uid, run=bounded_run):
    code, output = run(["/usr/bin/pgrep", "-x", "-u", str(uid), "security"])
    if code == 1:
        return {"security_processes": [], "matching_processes": 0}
    if code != 0:
        raise ValueError("process discovery unavailable")
    fields = output.split()
    if any(not re.fullmatch(r"[0-9]{1,10}", field) for field in fields):
        raise ValueError("unexpected process discovery shape")
    pids = list(dict.fromkeys(map(int, fields)))
    chains = []
    for initial in pids[:MAX_SECURITY_PROCESSES]:
        pid, seen, chain = initial, set(), []
        for _ in range(MAX_ANCESTORS):
            if pid <= 0 or pid in seen:
                break
            seen.add(pid)
            row = process_metadata(pid, run)
            if row is None:
                break
            if not chain and (row["uid"] != uid or row["executable_name"] != "security"):
                break
            chain.append(row)
            pid = row["ppid"]
        if chain:
            chains.append(chain)
    return {"security_processes": chains, "matching_processes": len(pids),
            "process_limit_reached": len(pids) > MAX_SECURITY_PROCESSES,
            "limitations": ["concurrent exit and PID reuse can invalidate ancestry",
                            "executable names do not identify script paths or Keychain items",
                            "no process arguments or environment inspected",
                            "unrecognized executable names are reported as other"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect-local-mac", action="store_true")
    args = parser.parse_args()
    if not args.inspect_local_mac:
        print(json.dumps({"mode": "offline_plan", "credential_reads": 0,
                          "writes": 0, "process_inspection": False,
                          "operations": ["exact current-user security PID discovery",
                                         "bounded parent PID, owner UID and executable name metadata"]}))
        return
    if platform.system() != "Darwin" or Path.home() != Path("/Users/jay"):
        raise SystemExit("Refused: exact authorized Mac context required")
    try:
        print(json.dumps(audit(os.getuid())))
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        # Never include subprocess stdout, stderr or exception text.
        raise SystemExit("Process metadata inspection unavailable")


if __name__ == "__main__":
    main()
