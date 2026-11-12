"""Finite exact-resource cleanup candidate; default makes no Engine/filesystem calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import types

ROOT = Path(__file__).resolve().parent
SOURCE_SHA = "61bd4888e72258b84f5d2480dd5effcfb651ea31d6acf4d691f1ee282d18f5b5"
MANIFEST_SHA = "6e724d1aa9fde8d340226281b597ba3608ed42f09871bbe44085e90e44e38a2d"
PLAN_SHA = "9221387107fb00878f8cba8a80a39d03301fc790008c1abf009c610e787ac373"
A = "c633b2ba5a0311f1b6b0247089bead952b5160f2861209da7b349c880b6108ee"
B = "2d9584b4261bb142716ce0e1b1730f3e82a126e6c1d4712ba55bd956cd5d54d5"


def reviewed_source():
    raw = (ROOT / "rehearse.py").read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA:
        raise RuntimeError("original reviewed source changed")
    module = types.ModuleType("approved_cleanup_primitives")
    module.__file__ = str(ROOT / "rehearse.py")
    exec(compile(raw, module.__file__, "exec"), module.__dict__)
    return module


def fingerprint(info):
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink]


class RAM:
    def __init__(self, p, manifest):
        self.p, self.m, self.value = p, manifest, p.RamEvidence()
        parent = os.open("/dev/shm", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.value.fd = os.open(p.BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        finally:
            os.close(parent)
        pin = manifest["directory"]
        self.value.identity = (pin[0], pin[1], pin[2])
        self.value.files = {name: ((row["stat"][0], row["stat"][1], row["stat"][2], row["stat"][5]), bytes.fromhex(row["sha256"]))
                            for name, row in manifest["files"].items()}

    def check(self):
        self.value.check()
        info = os.fstat(self.value.fd)
        if [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)] != self.m["directory"]:
            raise self.p.Stop("original RAM directory differs")
        for name, expected in self.m["files"].items():
            if fingerprint(os.stat(name, dir_fd=self.value.fd, follow_symlinks=False)) != expected["stat"]:
                raise self.p.Stop("RAM file changed from frozen cleanup inventory")

    def cleanup(self):
        self.check()
        self.value.cleanup()

    def close(self):
        self.value.close()


class Receipts:
    def __init__(self, p):
        self.p, self.fd = p, None

    def open(self):
        parent = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(parent)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise self.p.Stop("private cleanup custody changed")
            os.mkdir("cleanup-receipts-c4e91b27", 0o700, dir_fd=parent)
            os.fsync(parent)
            self.fd = os.open("cleanup-receipts-c4e91b27", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        finally:
            os.close(parent)

    def write(self, name, value):
        raw = self.p.canonical(value).encode()
        if not 0 < len(raw) <= self.p.MAX_BYTES:
            raise self.p.Stop("private cleanup receipt too large")
        fd = os.open(name + ".json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            offset = 0
            while offset < len(raw):
                count = os.write(fd, raw[offset:])
                if count <= 0:
                    raise self.p.Stop("private cleanup receipt write incomplete")
                offset += count
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.fd)
        fd = os.open(name + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(raw)
                    or os.read(fd, len(raw) + 1) != raw):
                raise self.p.Stop("private cleanup receipt readback mismatch")
        finally:
            os.close(fd)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class Cleanup:
    def __init__(self, p, manifest, engine, ram, receipts, *, clock=time.monotonic):
        if (manifest["source_sha256"] != SOURCE_SHA or manifest["ids"] != [A, B] or manifest["names"] != list(p.NAMES)
                or manifest["session"] != p.SESSION or manifest["daemon_sha256"] != p.DAEMON_SHA256
                or manifest["host_owner"] != list(p.HOST_OWNER) or manifest["volume"] != p.VOLUME or manifest["ram_root"] != p.RAM_ROOT
                or len(manifest["files"]) != 18):
            raise p.Stop("exact reviewed cleanup manifest required")
        self.p, self.m, self.engine, self.ram, self.receipts, self.clock = p, manifest, engine, ram, receipts, clock
        self.started, self.stage, self.wire = False, 0, 0
        self.routes = {("GET", "/info"), ("GET", "/version"), ("GET", "/volumes/" + p.VOLUME)}
        self.routes.update(("GET", "/containers/" + target + "/json") for target in [A, B, *p.NAMES])
        self.deletes = ["/containers/" + B + "?v=false&force=false&link=false", "/containers/" + A + "?v=false&force=false&link=false",
                        "/volumes/" + p.VOLUME + "?force=false"]
        self.mountpoints = []

    def call(self, method, route, expected=200):
        cost = 1 if route == "/info" else 2
        if self.clock() >= self.deadline or self.wire + cost > 40:
            raise self.p.Stop("finite cleanup deadline/request bound reached")
        if method == "DELETE":
            if self.stage >= 3 or route != self.deletes[self.stage]:
                raise self.p.Stop("cleanup deletion route/order refused")
            self.receipts.write("delete-" + str(self.stage) + "-intent", {"path": route})
        elif (method, route) not in self.routes:
            raise self.p.Stop("unlisted cleanup read route")
        self.wire += cost
        status, value = self.engine.request(method, route)
        if method == "DELETE":
            self.receipts.write("delete-" + str(self.stage) + "-response", {"status": status, "response": value})
        if status != expected or self.clock() >= self.deadline:
            raise self.p.Stop("cleanup response/deadline requires reconciliation")
        if method == "DELETE":
            self.stage += 1
        return value

    def container(self, identifier, name, *, by_name=False):
        item = self.call("GET", "/containers/" + identifier + "/json")
        self.p.owned(item, identifier, name)
        self.p.synthetic(item)
        self.mountpoints.append(next(row["Source"] for row in item["Mounts"] if row["Destination"] == "/data"))
        if by_name:
            named = self.call("GET", "/containers/" + name + "/json")
            self.p.owned(named, identifier, name)
            self.p.synthetic(named)

    def volume(self):
        value = self.call("GET", "/volumes/" + self.p.VOLUME)
        if (value.get("Name") != self.p.VOLUME or value.get("Driver") != "local" or value.get("Labels") != self.p.VOLUME_LABELS
                or value.get("Options") != self.p.VOLUME_OPTIONS or any(point != value.get("Mountpoint") for point in self.mountpoints)):
            raise self.p.Stop("exact fixture volume identity differs")

    def run(self):
        if self.started:
            raise self.p.Stop("cleanup instance cannot be retried")
        self.started, self.deadline = True, self.clock() + 120
        if (os.getuid(), os.getgid()) != self.p.HOST_OWNER:
            raise self.p.Stop("cleanup actor differs")
        info = self.call("GET", "/info")
        if hashlib.sha256(info["ID"].encode()).hexdigest() != self.p.DAEMON_SHA256 or info.get("CgroupVersion") != "2":
            raise self.p.Stop("exact cleanup daemon changed")
        version = self.call("GET", "/version")
        if not tuple(map(int, version["MinAPIVersion"].split("."))) <= (1, 53) <= tuple(map(int, version["ApiVersion"].split("."))):
            raise self.p.Stop("cleanup fixed API unavailable")
        for identifier, name in zip((A, B), self.p.NAMES):
            self.container(identifier, name, by_name=True)
        self.volume()
        self.ram.check()
        self.receipts.open()
        for identifier, name in ((B, self.p.NAMES[1]), (A, self.p.NAMES[0])):
            self.container(identifier, name)
            self.ram.check()
            self.call("DELETE", self.deletes[self.stage], 204)
            self.call("GET", "/containers/" + identifier + "/json", 404)
            self.call("GET", "/containers/" + name + "/json", 404)
        self.volume()
        for identifier in (A, B):
            self.call("GET", "/containers/" + identifier + "/json", 404)
        self.ram.check()
        self.call("DELETE", self.deletes[self.stage], 204)
        self.call("GET", "/volumes/" + self.p.VOLUME, 404)
        self.ram.check()
        if self.clock() >= self.deadline:
            raise self.p.Stop("cleanup deadline reached before RAM removal")
        self.receipts.write("ram-removal-intent", {"files": 18, "manifest_sha256": MANIFEST_SHA})
        self.ram.cleanup()
        if self.clock() >= self.deadline:
            raise self.p.Stop("cleanup deadline reached after RAM removal")
        self.receipts.write("complete", {"deleted_ids": [B, A], "volume": self.p.VOLUME, "ram_removed": True})
        return {"status": "exact_cleanup_completed", "wire_requests": self.wire, "deleted_ids": [B, A], "ram_removed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-executor-sha256")
    parser.add_argument("--reviewed-manifest-sha256")
    parser.add_argument("--reviewed-plan-sha256")
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({"mode": "offline_cleanup_plan", "engine_calls": 0, "writes": 0, "manifest_sha256": MANIFEST_SHA}))
        return
    ram = receipts = None
    try:
        raw = (ROOT / "cleanup-manifest.json").read_bytes()
        if (hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != args.reviewed_executor_sha256
                or hashlib.sha256(raw).hexdigest() != MANIFEST_SHA or args.reviewed_manifest_sha256 != MANIFEST_SHA
                or hashlib.sha256((ROOT / "cleanup-plan.md").read_bytes()).hexdigest() != PLAN_SHA or args.reviewed_plan_sha256 != PLAN_SHA):
            raise RuntimeError("exact independently reviewed cleanup hashes required")
        p, manifest = reviewed_source(), json.loads(raw)
        engine = p.FixtureEngine(armed=True, expected_daemon=p.DAEMON_SHA256)
        for identifier in (A, B):
            engine.permit_container(identifier)
        ram, receipts = RAM(p, manifest), Receipts(p)
        print(json.dumps(Cleanup(p, manifest, engine, ram, receipts).run(), sort_keys=True))
    except Exception:
        print(json.dumps({"status": "stopped", "reason": "cleanup refused or outcome unknown; reconcile exact remaining resources"}), file=sys.stderr)
        raise SystemExit(2) from None
    finally:
        if ram is not None:
            ram.close()
        if receipts is not None:
            receipts.close()


if __name__ == "__main__":
    main()
