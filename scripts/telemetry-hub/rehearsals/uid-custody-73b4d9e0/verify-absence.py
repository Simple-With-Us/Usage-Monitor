#!/usr/bin/env python3
"""Separate unarmed exact-ID/name/RAM absence readback; default does no Engine I/O."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import types

ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / "custody.py").read_bytes()
if hashlib.sha256(SOURCE).hexdigest() != "45c64c6c28597b78da4a10a1635fc8d0fd1f39f0235006cd01673082d0b757d9":
    raise RuntimeError("exact reviewed custody source required")
C = types.ModuleType("uid_absence_custody")
C.__file__ = str(ROOT / "custody.py")
exec(compile(SOURCE, C.__file__, "exec"), C.__dict__)


def ram_present():
    try:
        os.lstat(C.RAM_ROOT)
    except FileNotFoundError:
        return False
    return True


def verify_absence(identifier, engine, ram_check=ram_present):
    if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier) or engine.armed is not False:
        raise C.Stop("one exact full returned ID and unarmed reader required")
    status, info = engine.request("GET", "/info")
    if (status != 200 or not isinstance(info, dict) or not isinstance(info.get("ID"), str)
            or hashlib.sha256(info["ID"].encode()).hexdigest() != C.B.DAEMON_SHA256):
        raise C.Stop("reviewed daemon mismatch during independent absence readback")
    engine.permit_container(identifier)
    statuses = {}
    for target in (identifier, C.NAME):
        status, _ = engine.request("GET", "/containers/" + target + "/json")
        statuses[target] = status
        if status != 404:
            raise C.Stop("exact synthetic resource not confirmed absent")
    if ram_check():
        raise C.Stop("exact synthetic RAM path still exists")
    return {"all_exact_resources_absent": True, "daemon_verified": True, "http_statuses": statuses,
            "ram_absent": True, "wire_requests": engine.calls, "mutations": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container-id")
    parser.add_argument("--reviewed-reader-sha256")
    parser.add_argument("--expected-daemon-sha256")
    args = parser.parse_args()
    if args.container_id is None:
        print(C.B.canonical({"mode": "offline_plan", "engine_calls": 0, "fixture_writes": 0}))
        return
    try:
        if (args.reviewed_reader_sha256 != hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
                or args.expected_daemon_sha256 != C.B.DAEMON_SHA256 or (os.getuid(), os.getgid()) != C.OPERATOR
                or not re.fullmatch(r"[0-9a-f]{64}", args.container_id)):
            raise C.Stop("exact reviewed reader/daemon/actor/returned-ID required")
        engine = C.CustodyEngine(armed=False, expected_daemon=C.B.DAEMON_SHA256)
        print(C.B.canonical(verify_absence(args.container_id, engine)))
    except Exception as error:
        print(C.B.canonical({"status": "stopped", "reason": str(error) if isinstance(error, C.Stop) else "absence unverified; no retry"}), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
