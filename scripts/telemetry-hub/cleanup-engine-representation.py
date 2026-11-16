#!/usr/bin/env python3
"""Exact stopped-fixture cleanup; default mode performs no Engine I/O or writes."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import types

SOURCE_SHA256 = "f5dab901d05226ec9df52cf51830feede01ba24189921a29ff4f80023581dfa3"
ORIGINAL_PLAN_SHA256 = "ca0b792e8273ae04154774aa7f12adf09fe1f87deb525a883f4597ffc2e7d361"
PLAN_SHA256 = "d0c05394c4e18fa9629d75fb61fb7a7f1e47742f7e65de9aad9edea3369ca61c"
DAEMON_SHA256 = "659e19e4b792e0ed00b136b7e91ad7ae1ea7decbf9e7930cdf1488d69b496565"
CONTAINER_ID = "a2272125598a8a0b3726c894e2dde2a8f3ca76ab6f3bc5a68cc285ab386256d5"
INVARIANTS_SHA256 = "babd1cf7751a91abfd6986b3fd71f1c423676e1ce7d8f19b08f66104cbcb0663"
RAM_IDENTITY = (26, 1742540, 1001)
RAM_FILES = {
    "config.json": (1742541, 42, "1a048d46429d7fcb16f690cf8b3a41118685fb53d2218522b2ca9e6020548d5c"),
    "container-0-intent.json": (1742544, 126, "c94c1d588c967119d96c0e4360ae48a43446260e769da160a8d677428f769080"),
    "volume-confirmed.json": (1742543, 133, "98adc4613f110843c64eb2e0ab168abf83835253865abec74596feb5660f6d4d"),
    "volume-intent.json": (1742542, 48, "e11d16a698d37abf1afb4a3875dfe2bc6c66fd3a576736e0f0b31d5463214d0f"),
}
MAX_REQUESTS = 18


class Stop(Exception):
    """Only fixed sanitized reasons are emitted."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def load_reviewed_transport():
    path = Path(__file__).with_name("probe-engine-representation.py")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise Stop("reviewed transport bytes changed")
    module = types.ModuleType("reviewed_fixture_transport")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec"), module.__dict__)
    return module


class CleanupEngine:
    """An outer closed route fence removes every create/start/exec capability."""
    def __init__(self, source):
        self.source = source
        self.transport = source.FixtureEngine(armed=True, expected_daemon=DAEMON_SHA256)
        self.transport.permit_container(CONTAINER_ID)
        self.calls = 0
        self.attempted = set()
        self.readable = {"/info", "/volumes/" + source.VOLUME}
        self.readable.update("/containers/" + ref + "/json" for ref in (CONTAINER_ID,) + source.NAMES)
        self.deletable = {
            "/containers/" + CONTAINER_ID + "?v=false&force=false&link=false",
            "/volumes/" + source.VOLUME + "?force=false",
        }

    def request(self, method, path, body=None):
        if body is not None or not ((method == "GET" and path in self.readable)
                                    or (method == "DELETE" and path in self.deletable)):
            raise Stop("cleanup route refused before socket access")
        cost = 2 if method == "DELETE" else 1
        if self.calls + cost > MAX_REQUESTS:
            raise Stop("cleanup request budget exhausted")
        if method == "DELETE":
            if path in self.attempted:
                raise Stop("cleanup deletion already attempted")
            self.attempted.add(path)
        self.calls += cost
        # The unchanged reviewed transport fingerprints /info on the same pinned
        # root-peer connection before each deletion, with no reconnect or retry.
        return self.transport.request(method, path, body)


class ExistingEvidence:
    """Read and remove only the pinned four private synthetic files."""
    def __init__(self, source):
        self.source = source
        self.parent = self.fd = None
        self.removed = []

    @staticmethod
    def directory_matches(info):
        return (stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino, info.st_uid) == RAM_IDENTITY
                and stat.S_IMODE(info.st_mode) == 0o700)

    def open(self):
        self.parent = os.open("/dev/shm", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fd = os.open(self.source.BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent)
        self.check()

    def check(self):
        if self.fd is None or self.parent is None:
            raise Stop("RAM evidence is not open")
        if (not self.directory_matches(os.fstat(self.fd))
                or not self.directory_matches(os.stat(self.source.BASE, dir_fd=self.parent, follow_symlinks=False))
                or set(os.listdir(self.fd)) != set(RAM_FILES)):
            raise Stop("RAM directory identity or entries changed")
        for name, (inode, size, expected_hash) in RAM_FILES.items():
            descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=self.fd)
            try:
                before = os.fstat(descriptor)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                        or (before.st_dev, before.st_ino, before.st_uid, before.st_size) != (RAM_IDENTITY[0], inode, RAM_IDENTITY[2], size)
                        or stat.S_IMODE(before.st_mode) != 0o600):
                    raise Stop("RAM evidence file identity changed")
                raw = bytearray()
                while len(raw) < size:
                    chunk = os.read(descriptor, size - len(raw))
                    if not chunk:
                        raise Stop("RAM evidence readback incomplete")
                    raw.extend(chunk)
                after = os.fstat(descriptor)
                if (any(getattr(before, key) != getattr(after, key) for key in
                        ("st_dev", "st_ino", "st_uid", "st_size", "st_mode", "st_nlink", "st_mtime_ns", "st_ctime_ns"))
                        or hashlib.sha256(raw).hexdigest() != expected_hash):
                    raise Stop("RAM evidence content changed")
            finally:
                os.close(descriptor)

    def cleanup(self):
        self.check()
        for name in RAM_FILES:
            # Refuse a changed entry immediately before its exact unlink.
            info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            inode, size, _hash = RAM_FILES[name]
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or (info.st_dev, info.st_ino, info.st_uid, info.st_size) != (RAM_IDENTITY[0], inode, RAM_IDENTITY[2], size)
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise Stop("RAM evidence changed before unlink")
            os.unlink(name, dir_fd=self.fd)
            self.removed.append(name)
        if (os.listdir(self.fd) or not self.directory_matches(os.fstat(self.fd))
                or not self.directory_matches(os.stat(self.source.BASE, dir_fd=self.parent, follow_symlinks=False))):
            raise Stop("RAM directory changed before removal")
        os.rmdir(self.source.BASE, dir_fd=self.parent)
        self.assert_absent()

    def assert_absent(self):
        try:
            os.stat(self.source.BASE, dir_fd=self.parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise Stop("RAM directory absence not confirmed")

    def close(self):
        for name in ("fd", "parent"):
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)


class Cleanup:
    def __init__(self, source, engine, evidence):
        self.source, self.engine, self.evidence = source, engine, evidence
        self.phase = "preflight"
        self.operations = []

    def call(self, method, path, expected):
        operation = None
        if method == "DELETE":
            operation = {"method": "DELETE", "path": path, "outcome": "unknown"}
            self.operations.append(operation)
        try:
            status, value = self.engine.request(method, path)
        except Stop as error:
            # Fixed-reason refusals are provably raised before the request is
            # sent (route/budget fences, daemon verification); only the
            # transport's post-send wrap leaves the outcome genuinely unknown.
            # Record which one the operator must reconcile.
            if (operation is not None
                    and str(error) != "Engine response unavailable after mutation sent; reconcile without retry"):
                operation.update(outcome="not_sent", reason=str(error))
            raise
        except Exception:
            raise Stop("request outcome unknown; stop without retry") from None
        if operation is not None:
            operation.update(outcome="response", http_status=status)
        if status != expected:
            raise Stop("unexpected response status; stop without retry")
        return value

    def absent_b(self):
        self.call("GET", "/containers/" + self.source.NAMES[1] + "/json", 404)

    def volume(self):
        item = self.call("GET", "/volumes/" + self.source.VOLUME, 200)
        if (not isinstance(item, dict) or item.get("Name") != self.source.VOLUME
                or item.get("Driver") != "local" or item.get("Options") != self.source.VOLUME_OPTIONS
                or item.get("Labels") != self.source.VOLUME_LABELS):
            raise Stop("volume ownership or options changed")

    def container(self, ref):
        item = self.call("GET", "/containers/" + ref + "/json", 200)
        if not isinstance(item, dict):
            raise Stop("invalid container metadata")
        state = item.get("State")
        if (not isinstance(state, dict) or state.get("Status") != "created"
                or any(state.get(key) is not False for key in ("Running", "Paused", "Restarting", "Dead"))
                or type(state.get("Pid")) is not int or state["Pid"] != 0
                or item.get("Id") != CONTAINER_ID or item.get("Name") != "/" + self.source.NAMES[0]
                or item.get("Image") != self.source.IMAGE_ID or item.get("Config", {}).get("Labels") != self.source.LABELS):
            raise Stop("container identity or stopped state changed")
        try:
            matched = self.source.digest(self.source.invariants(item)) == INVARIANTS_SHA256
        except Exception:
            matched = False
        if not matched:
            raise Stop("full container invariant digest changed")

    def run(self):
        info = self.call("GET", "/info", 200)
        if (not isinstance(info, dict) or not isinstance(info.get("ID"), str)
                or hashlib.sha256(info["ID"].encode()).hexdigest() != DAEMON_SHA256):
            raise Stop("reviewed daemon identity changed")
        self.evidence.open()
        self.container(CONTAINER_ID)
        self.container(self.source.NAMES[0])
        self.absent_b()
        self.volume()
        self.evidence.check()
        self.phase = "delete-container"
        self.call("DELETE", "/containers/" + CONTAINER_ID + "?v=false&force=false&link=false", 204)
        for ref in (CONTAINER_ID, self.source.NAMES[0]):
            self.call("GET", "/containers/" + ref + "/json", 404)
        self.absent_b()
        self.volume()
        self.evidence.check()
        self.phase = "delete-volume"
        self.call("DELETE", "/volumes/" + self.source.VOLUME + "?force=false", 204)
        self.call("GET", "/volumes/" + self.source.VOLUME, 404)
        self.phase = "remove-ram-evidence"
        self.evidence.cleanup()
        self.phase = "final-readback"
        for ref in (CONTAINER_ID,) + self.source.NAMES:
            self.call("GET", "/containers/" + ref + "/json", 404)
        self.call("GET", "/volumes/" + self.source.VOLUME, 404)
        self.evidence.assert_absent()
        self.phase = "complete"
        return {"status": "cleanup_verified", "operations": self.operations, "engine_wire_requests": self.engine.calls,
                "equivalence_verified": False, "started": False, "ram_absent": True}


def verify_release(args):
    root = Path(__file__).resolve().parents[2]
    plan = root / "docs/runbooks/engine-representation-stopped-cleanup-plan.md"
    original = root / "docs/runbooks/engine-representation-fixture-plan.md"
    own_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if (args.reviewed_cleanup_sha256 != own_hash or args.reviewed_plan_sha256 != PLAN_SHA256
            or hashlib.sha256(plan.read_bytes()).hexdigest() != PLAN_SHA256
            or hashlib.sha256(original.read_bytes()).hexdigest() != ORIGINAL_PLAN_SHA256):
        raise Stop("exact reviewed cleanup and plan bytes required")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-cleanup-sha256")
    parser.add_argument("--reviewed-plan-sha256")
    args = parser.parse_args(argv)
    if not args.execute:
        print(canonical({"mode": "offline_plan", "engine_calls": 0, "writes": 0,
                         "plan_sha256": PLAN_SHA256, "container_id": CONTAINER_ID}))
        return 0
    cleanup = evidence = None
    try:
        verify_release(args)
        source = load_reviewed_transport()
        evidence = ExistingEvidence(source)
        cleanup = Cleanup(source, CleanupEngine(source), evidence)
        print(canonical(cleanup.run()))
        return 0
    except Exception as error:
        print(canonical({"status": "stopped", "reason": str(error) if isinstance(error, Stop) else "unexpected failure; preserve remaining evidence",
                         "phase": cleanup.phase if cleanup else "review-fence", "operations": cleanup.operations if cleanup else [],
                         "remaining_resources_preserved": True, "ram_files_removed": evidence.removed if evidence else []}), file=sys.stderr)
        return 2
    finally:
        if evidence is not None:
            evidence.close()


if __name__ == "__main__":
    raise SystemExit(main())
