#!/usr/bin/env python3
"""Synthetic UID-custody fixture; default performs no Engine or fixture I/O."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import time
import urllib.parse

ROOT = Path(__file__).resolve().parent
PINS = {"fixture-base.py": "4316fec020d46626c807c434add39ad6c1227109738d53ad7199a7cb91780ae7",
        "../../activate-kimi-zcode.py": "472b450cbe33a5a5f1e9bcd18e80a361b36fccd7babd367f8cfcada542b1e4f1",
        "../../finite-pinned-lifecycle.py": "efe0abf0ae8eabd1e1512b17fdb6afd6eb6db649ee38b21356d0cc6e6fb1fc9f",
        "../../offline-engine-runtime.py": "a08f41a0772e09a063ec88f01c004417c8e55562737836929a1b4481262c3e9b",
        "../../pinned-engine-lifecycle.py": "543ac3b3415c932d75a1d3900b708df3cf72652f96739d6d7daaf9853a6337a0",
        "../../sync-mounted-sources.py": "5104d3e47f7727e32ea33d3d694a0fcf85ddfc6aea2a4891d344d9cde5b16beb"}
for name, expected in PINS.items():
    if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError("fixed nonsecret dependency differs")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load("uid_fixture_base", ROOT / "fixture-base.py")
R = load("uid_fixture_runtime", ROOT / "../../offline-engine-runtime.py")
Stop = B.Stop
BASE = "um1654-uid-custody-73b4d9e0"
NAME = BASE + "-a"
RAM_ROOT = "/dev/shm/" + BASE
PAYLOAD_ROOT = RAM_ROOT + "/payload"
LABELS = {**B.LABELS, "com.simplewithus.fixture.nonce": "73b4d9e0", "com.simplewithus.fixture.role": "uid-custody"}
OPERATOR = (1001, 1001)
PAYLOAD_OWNER = (10001, 10001)
PLAN_SHA256 = "31065ff140aeb2d5bf976cdc8df161fc9a00b17710ace3109c1546c03e7c6d46"
UPLOAD_SHA256 = "8e77d113dcd3f374b4c474f3ab83a2467e8c3fa66ed275f085e0d0f2be4935ae"
UPLOAD_ROUTE = "/archive?" + urllib.parse.urlencode({"path": "/run/secrets", "noOverwriteDirNonDir": "true", "copyUIDGID": "true"})
SNAPSHOT_RAW = B.canonical(B.snapshot("old")).encode()
MAX_REQUESTS = 28
SIGNATURE_FIELDS = ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")


def signature(info):
    return tuple(getattr(info, key) for key in SIGNATURE_FIELDS)


def upload_tar():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:", format=tarfile.USTAR_FORMAT) as archive:
        item = tarfile.TarInfo("telemetry-hub.json")
        item.uid, item.gid, item.mode, item.size, item.mtime = *PAYLOAD_OWNER, 0o600, len(SNAPSHOT_RAW), 0
        archive.addfile(item, io.BytesIO(SNAPSHOT_RAW))
    return output.getvalue()


def validate_upload(raw):
    if (not isinstance(raw, bytes) or len(raw) != 10240 or len(raw) > 16384
            or hashlib.sha256(raw).hexdigest() != UPLOAD_SHA256 or raw != upload_tar()):
        raise Stop("exact bounded synthetic tar body required")
    if R.snapshot_archive(raw).encode() != SNAPSHOT_RAW:
        raise Stop("synthetic upload does not satisfy unchanged UID decoder")


def source_payload():
    payload = B.source_payload()
    payload["Labels"] = copy.deepcopy(LABELS)
    payload["HostConfig"].pop("Tmpfs")
    payload["HostConfig"]["Mounts"] = [{"Type": "bind", "Source": PAYLOAD_ROOT, "Target": "/run/secrets", "ReadOnly": False,
                                          "BindOptions": {"Propagation": "rprivate", "CreateMountpoint": False}}]
    return payload


def validate_resolved(item, identifier):
    state = item.get("State", {})
    if (item.get("Id") != identifier or item.get("Name") != "/" + NAME or item.get("Image") != B.IMAGE_ID
            or item.get("Config", {}).get("Labels") != LABELS or state.get("Running") is not False
            or state.get("Status") != "created" or type(state.get("Pid")) is not int or state["Pid"] != 0):
        raise Stop("exact fixture identity or stopped state changed")
    payload = copy.deepcopy(item["Config"])
    payload["HostConfig"] = copy.deepcopy(item["HostConfig"])
    host = payload["HostConfig"]
    if host.get("Tmpfs") not in (None, {}):
        raise Stop("no additional fixture tmpfs allowed")
    mounts = host.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != 1:
        raise Stop("exact single synthetic bind declaration required")
    row = mounts[0]
    if (not isinstance(row, dict) or set(row) - {"Type", "Source", "Target", "ReadOnly", "Consistency", "BindOptions"}
            or row.get("Type") != "bind" or row.get("Source") != PAYLOAD_ROOT or row.get("Target") != "/run/secrets"
            or row.get("ReadOnly", False) is not False or row.get("Consistency", "") != ""):
        raise Stop("unreviewed synthetic directory bind")
    options = row.get("BindOptions")
    if (not isinstance(options, dict) or options.get("Propagation") != "rprivate"
            or set(options) - {"Propagation", "CreateMountpoint", "NonRecursive", "ReadOnlyNonRecursive", "ReadOnlyForceRecursive"}
            or any(value is not False for key, value in options.items() if key != "Propagation")):
        raise Stop("unreviewed synthetic bind options")
    resolved = item.get("Mounts")
    if (not isinstance(resolved, list) or len(resolved) != 1 or not isinstance(resolved[0], dict)
            or resolved[0].get("Type") != "bind" or resolved[0].get("Destination") != "/run/secrets"
            or resolved[0].get("Source") != PAYLOAD_ROOT or resolved[0].get("RW") is not True):
        raise Stop("unreviewed resolved fixture mount")
    # Reuse the reviewed closed non-mount Config/HostConfig validator without
    # forwarding its original journal or snapshot mount into this fixture.
    shim = copy.deepcopy(payload)
    shim["Labels"] = copy.deepcopy(B.LABELS)
    shim["HostConfig"]["Mounts"] = B.source_payload()["HostConfig"]["Mounts"]
    shim["HostConfig"]["Tmpfs"] = B.source_payload()["HostConfig"]["Tmpfs"]
    B.validate_create_payload(shim)


class CustodyEngine:
    """Single synthetic create/upload/delete, exact paths and bytes, no start route."""
    def __init__(self, *, armed=False, expected_daemon=None, connection=B.UnixConnection, clock=time.monotonic):
        self.armed, self.expected_daemon, self.connection, self.clock = armed, expected_daemon, connection, clock
        self.identifier, self.calls, self.mutations = None, 0, set()
        self.failed = False

    def permit_container(self, identifier):
        if self.identifier is not None or not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise Stop("one fresh full fixture ID required")
        self.identifier = identifier

    def request(self, method, path, body=None):
        try:
            return self._request(method, path, body)
        except Exception:
            self.failed = True
            raise

    def _request(self, method, path, body):
        if self.failed:
            raise Stop("terminal fixture transport cannot be reused")
        readable = {"/info", "/version", "/images/" + urllib.parse.quote(B.IMAGE_REFERENCE, safe="") + "/json",
                    "/containers/" + NAME + "/json"}
        prefix = "/containers/" + self.identifier if self.identifier else None
        if prefix:
            readable |= {prefix + "/json", prefix + B.ARCHIVE_SUFFIX}
        allowed = method == "GET" and path in readable and body is None
        encoded, content_type = None, "application/json"
        if method != "GET":
            if not self.armed:
                raise Stop("synthetic custody mutations are not armed")
            if method == "POST" and path == "/containers/create?name=" + NAME:
                allowed = isinstance(body, dict) and B.same_json(body, source_payload())
                if allowed:
                    encoded = B.canonical(body).encode()
            elif method == "PUT" and prefix and path == prefix + UPLOAD_ROUTE:
                validate_upload(body)
                allowed, encoded, content_type = True, body, "application/x-tar"
            elif method == "DELETE" and prefix and path == prefix + "?v=false&force=false&link=false" and body is None:
                allowed = True
            if (method, path) in self.mutations:
                raise Stop("synthetic mutation already attempted")
            order = [("POST", "/containers/create?name=" + NAME), ("PUT", str(prefix) + UPLOAD_ROUTE),
                     ("DELETE", str(prefix) + "?v=false&force=false&link=false")]
            if len(self.mutations) >= len(order) or (method, path) != order[len(self.mutations)]:
                raise Stop("exact create/upload/delete order required")
        wire_calls = 1 if path == "/info" else 2
        if not allowed or self.calls + wire_calls > MAX_REQUESTS or self.expected_daemon != B.DAEMON_SHA256:
            raise Stop("exact synthetic route/body/daemon/budget required before socket access")
        if method != "GET":
            self.mutations.add((method, path))
        connection = self.connection()
        deadline = B.Deadline(self.clock)
        try:
            pinned = connection.begin(deadline)

            def exchange(verb, route, data=None, mime="application/json"):
                deadline.remaining()
                if connection.identity() != pinned:
                    raise Stop("pinned connection changed")
                self.calls += 1
                connection.request(verb, B.PREFIX + route, body=data, headers={"Accept": "application/json", "Content-Type": mime})
                if connection.identity() != pinned:
                    raise Stop("pinned connection changed after send")
                connection.reset_response_budget()
                response = connection.getresponse()
                raw = bytearray()
                while True:
                    deadline.remaining()
                    chunk = response.read1(min(65536, B.MAX_BYTES + 1 - len(raw)))
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > B.MAX_BYTES:
                        raise Stop("bounded response exceeded")
                deadline.remaining()
                if connection.identity() != pinned:
                    raise Stop("pinned connection changed after response")
                if route.endswith(B.ARCHIVE_SUFFIX):
                    if (response.getheader("Content-Type") != "application/x-tar"
                            or response.getheader("Content-Encoding") not in (None, "identity")):
                        raise Stop("exact archive response type required")
                    value = bytes(raw)
                else:
                    value = B.decode(raw) if raw else None
                return response.status, value, response.will_close

            if path != "/info":
                status, info, closing = exchange("GET", "/info")
                if (status != 200 or closing or not isinstance(info, dict) or not isinstance(info.get("ID"), str)
                        or hashlib.sha256(info["ID"].encode()).hexdigest() != self.expected_daemon):
                    raise Stop("same-connection daemon verification failed")
            if method == "PUT":
                validate_upload(encoded)
            elif method == "POST" and not B.same_json(B.decode(encoded), source_payload()):
                raise Stop("create body changed before send")
            status, value, _closing = exchange(method, path, encoded, content_type)
            return status, value
        except Exception:
            raise Stop("Engine outcome unavailable; preserve evidence without retry") from None
        finally:
            connection.close()


def bounded_effect(method):
    def run(self, *args, **kwargs):
        outer = self.effect_deadline is None
        if outer:
            self.effect_deadline = B.Deadline(self.clock)
        try:
            self.check_deadline()
            value = method(self, *args, **kwargs)
            self.check_deadline()
            return value
        finally:
            if outer:
                self.effect_deadline = None
    return run


class Evidence:
    """Operator-owned receipts and separate UID-10001 payload, no host content read."""
    def __init__(self, clock=time.monotonic):
        self.fd = self.payload_fd = None
        self.directory_identity = self.payload_identity = None
        self.receipts, self.payload_signature = {}, None
        self.clock, self.effect_deadline = clock, None

    def check_deadline(self):
        if self.effect_deadline is not None:
            self.effect_deadline.remaining()

    @staticmethod
    def directory_pin(info):
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != OPERATOR or stat.S_IMODE(info.st_mode) != 0o700:
            raise Stop("operator directory custody changed")
        return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode

    @bounded_effect
    def open(self):
        with open("/proc/self/mountinfo", "rb") as handle:
            mounts = handle.read(B.MAX_BYTES + 1)
        if len(mounts) > B.MAX_BYTES or not any(b" /dev/shm " in row and b" - tmpfs " in row for row in mounts.splitlines()):
            raise Stop("exact RAM parent is not tmpfs")
        parent = os.open("/dev/shm", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir(BASE, 0o700, dir_fd=parent)
            self.fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            self.directory_identity = self.directory_pin(os.fstat(self.fd))
            os.mkdir("payload", 0o700, dir_fd=self.fd)
            self.payload_fd = os.open("payload", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
            self.payload_identity = self.directory_pin(os.fstat(self.payload_fd))
            os.fsync(self.fd)
        finally:
            os.close(parent)
        self.check()

    def check_directories(self):
        self.check_deadline()
        if (self.directory_pin(os.lstat(RAM_ROOT)) != self.directory_identity
                or self.directory_pin(os.fstat(self.fd)) != self.directory_identity
                or self.directory_pin(os.stat("payload", dir_fd=self.fd, follow_symlinks=False)) != self.payload_identity
                or self.directory_pin(os.fstat(self.payload_fd)) != self.payload_identity):
            raise Stop("exact synthetic directories changed")

    def payload_metadata(self):
        info = os.stat("telemetry-hub.json", dir_fd=self.payload_fd, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != PAYLOAD_OWNER
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size != len(SNAPSHOT_RAW)):
            raise Stop("actual UID-10001 payload custody differs")
        return signature(info)

    @bounded_effect
    def capture_payload(self):
        self.check_directories()
        if self.payload_signature is not None or set(os.listdir(self.payload_fd)) != {"telemetry-hub.json"}:
            raise Stop("exact new synthetic payload required")
        self.payload_signature = self.payload_metadata()
        self.check()

    def check_receipt(self, name):
        expected, digest = self.receipts[name]
        info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != OPERATOR
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or signature(info) != expected):
            raise Stop("operator receipt custody changed")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            if signature(os.fstat(descriptor)) != expected:
                raise Stop("operator receipt changed before readback")
            raw = bytearray()
            while len(raw) < info.st_size:
                self.check_deadline()
                chunk = os.read(descriptor, info.st_size - len(raw))
                if not chunk:
                    raise Stop("operator receipt readback incomplete")
                raw.extend(chunk)
            if (hashlib.sha256(raw).hexdigest() != digest or signature(os.fstat(descriptor)) != expected
                    or signature(os.stat(name, dir_fd=self.fd, follow_symlinks=False)) != expected):
                raise Stop("operator receipt readback changed")
        finally:
            os.close(descriptor)

    def check_operator(self):
        self.check_directories()
        if set(os.listdir(self.fd)) != set(self.receipts) | {"payload"}:
            raise Stop("untracked synthetic receipt entry")
        for name in self.receipts:
            self.check_deadline()
            self.check_receipt(name)

    @bounded_effect
    def check(self):
        self.check_operator()
        expected = set() if self.payload_signature is None else {"telemetry-hub.json"}
        if set(os.listdir(self.payload_fd)) != expected:
            raise Stop("untracked synthetic payload entry")
        if self.payload_signature is not None and self.payload_metadata() != self.payload_signature:
            raise Stop("actual synthetic payload identity changed")

    @bounded_effect
    def write(self, name, value):
        if self.fd is None or not re.fullmatch(r"[a-z0-9-]+\.json", name) or name in self.receipts:
            raise Stop("exact exclusive receipt name required")
        # Preserve an upload response before interpreting the newly created
        # payload; its custody is accepted only by capture_payload().
        self.check_operator()
        raw = B.canonical(value).encode()
        if len(raw) > B.MAX_BYTES:
            raise Stop("bounded receipt exceeded")
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            os.fchmod(descriptor, 0o600)
            data = memoryview(raw)
            while data:
                self.check_deadline()
                count = os.write(descriptor, data)
                if count <= 0:
                    raise Stop("receipt write incomplete")
                data = data[count:]
            os.fsync(descriptor)
            self.receipts[name] = signature(os.fstat(descriptor)), hashlib.sha256(raw).hexdigest()
        finally:
            os.close(descriptor)
        os.fsync(self.fd)
        self.check_receipt(name)

    @bounded_effect
    def cleanup(self):
        self.check()
        if self.payload_signature is None or self.payload_metadata() != self.payload_signature:
            raise Stop("archive-attested payload required before cleanup")
        os.unlink("telemetry-hub.json", dir_fd=self.payload_fd)
        self.payload_signature = None
        for name in self.receipts:
            self.check_deadline()
            self.check_directories()
            self.check_receipt(name)
            os.unlink(name, dir_fd=self.fd)
        self.check_directories()
        os.rmdir("payload", dir_fd=self.fd)
        parent = os.open("/dev/shm", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if self.directory_pin(os.stat(BASE, dir_fd=parent, follow_symlinks=False)) != self.directory_identity:
                raise Stop("original RAM path changed before removal")
            os.rmdir(BASE, dir_fd=parent)
        finally:
            os.close(parent)
        self.close()

    def close(self):
        for name in ("payload_fd", "fd"):
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)


class Probe:
    def __init__(self, engine, evidence, clock=time.monotonic):
        self.engine, self.evidence, self.clock = engine, evidence, clock
        self.phase, self.identifier, self.used = "preflight", None, False
        self.response_count = self.inspect_count = self.archive_count = 0
        self.deadline = None

    def remaining(self):
        if self.deadline is None or self.clock() >= self.deadline:
            raise Stop("whole custody rehearsal deadline exceeded")

    def call(self, method, path, body=None, expected=200):
        self.remaining()
        try:
            status, value = self.engine.request(method, path, body)
        except Exception:
            raise Stop("unknown synthetic operation; preserve evidence without retry") from None
        if method != "GET":
            self.evidence.write("response-" + str(self.response_count) + ".json", {"method": method, "path": path, "status": status, "response": value})
            self.response_count += 1
        self.remaining()
        if status != expected:
            raise Stop("unexpected operation status; preserve evidence")
        if method in ("PUT", "DELETE") and value is not None:
            raise Stop("unexpected upload/delete body or warning; preserve evidence")
        return value

    def inspect(self):
        value = self.call("GET", "/containers/" + self.identifier + "/json")
        self.evidence.write("inspect-" + str(self.inspect_count) + ".json", {"response_sha256": B.digest(value)})
        self.inspect_count += 1
        validate_resolved(value, self.identifier)
        return value

    def archive(self, baseline):
        index = self.archive_count
        self.evidence.write("archive-intent-" + str(index) + ".json", {"id": self.identifier, "path": B.SNAPSHOT_TARGET})
        raw = self.call("GET", "/containers/" + self.identifier + B.ARCHIVE_SUFFIX)
        self.evidence.write("archive-response-" + str(index) + ".json", {"response_sha256": hashlib.sha256(raw).hexdigest()})
        if R.snapshot_archive(raw).encode() != SNAPSHOT_RAW:
            raise Stop("actual UID-10001 archive bytes differ")
        self.evidence.check()
        checked = self.inspect()
        projections = [B.invariants(baseline), B.invariants(checked)]
        fields = [key for key in ("Config", "HostConfig", "Mounts", "Image") if not B.same_json(projections[0][key], projections[1][key])]
        if fields:
            self.evidence.write("mismatch.json", {"fields": fields, "left_sha256": B.digest(projections[0]), "right_sha256": B.digest(projections[1])})
            raise Stop("complete stopped configuration changed")
        self.evidence.write("archive-proof-" + str(index) + ".json", {"uid": 10001, "gid": 10001, "mode": 0o600,
                            "snapshot_sha256": hashlib.sha256(SNAPSHOT_RAW).hexdigest(), "payload_signature": self.evidence.payload_signature})
        self.archive_count += 1

    def run(self):
        if self.used:
            raise Stop("custody rehearsal instance already attempted")
        self.used = True
        if (os.getuid(), os.getgid()) != OPERATOR:
            raise Stop("exact reviewed operating actor required")
        self.deadline = self.clock() + 180
        validate_upload(upload_tar())
        info = self.call("GET", "/info")
        if (info.get("CgroupVersion") != "2" or not isinstance(info.get("ID"), str)
                or hashlib.sha256(info["ID"].encode()).hexdigest() != B.DAEMON_SHA256):
            raise Stop("reviewed daemon identity/cgroup required")
        version = self.call("GET", "/version")
        if not tuple(map(int, version["MinAPIVersion"].split("."))) <= (1, 53) <= tuple(map(int, version["ApiVersion"].split("."))):
            raise Stop("fixed API unsupported")
        image = self.call("GET", "/images/" + urllib.parse.quote(B.IMAGE_REFERENCE, safe="") + "/json")
        if (image.get("Id") != B.IMAGE_ID or B.IMAGE_REFERENCE not in image.get("RepoDigests", [])
                or sorted(row.split("=", 1)[0] for row in image.get("Config", {}).get("Env", [])) != sorted(row.split("=", 1)[0] for row in B.ENV[:-1])
                or image.get("Config", {}).get("Volumes")):
            raise Stop("exact cached public fixture image required")
        self.call("GET", "/containers/" + NAME + "/json", expected=404)
        self.evidence.open()
        self.phase = "create"
        self.evidence.write("create-intent.json", {"name": NAME, "body_sha256": B.digest(source_payload())})
        created = self.call("POST", "/containers/create?name=" + NAME, source_payload(), expected=201)
        if (not isinstance(created, dict) or set(created) - {"Id", "Warnings"} or not isinstance(created.get("Id"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", created["Id"])):
            raise Stop("fresh full create identity required")
        self.identifier = created["Id"]
        self.engine.permit_container(self.identifier)
        if created.get("Warnings") not in (None, []):
            raise Stop("create warning requires reconciliation")
        baseline = self.inspect()
        self.evidence.write("baseline.json", baseline)
        self.phase = "upload"
        self.evidence.check()
        self.evidence.write("upload-intent.json", {"id": self.identifier, "tar_sha256": UPLOAD_SHA256})
        self.call("PUT", "/containers/" + self.identifier + UPLOAD_ROUTE, upload_tar())
        self.evidence.capture_payload()
        self.evidence.write("payload-created.json", {"signature": self.evidence.payload_signature})
        self.archive(baseline)
        self.phase = "precleanup"
        self.archive(baseline)
        self.evidence.check()
        self.evidence.write("delete-intent.json", {"id": self.identifier})
        self.call("DELETE", "/containers/" + self.identifier + "?v=false&force=false&link=false", expected=204)
        self.call("GET", "/containers/" + self.identifier + "/json", expected=404)
        self.call("GET", "/containers/" + NAME + "/json", expected=404)
        result = {"status": "synthetic_uid_custody_verified", "container_id": self.identifier, "archive_owner": [10001, 10001],
                  "production_resource_custody_verified": False, "started": False, "wire_requests": self.engine.calls,
                  "snapshot_sha256": hashlib.sha256(SNAPSHOT_RAW).hexdigest(), "invariant_sha256": B.digest(B.invariants(baseline))}
        self.evidence.write("comparison.json", result)
        self.remaining()
        self.evidence.cleanup()
        self.remaining()
        result["cleanup_verified"] = True
        self.phase = "complete"
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-plan-sha256")
    parser.add_argument("--reviewed-executor-sha256")
    parser.add_argument("--expected-daemon-sha256")
    args = parser.parse_args()
    if not args.execute:
        print(B.canonical({"mode": "offline_plan", "engine_calls": 0, "fixture_writes": 0, "container": NAME, "plan_sha256": PLAN_SHA256}))
        return
    evidence = probe = None
    try:
        plan_sha = hashlib.sha256(Path(__file__).with_name("plan.md").read_bytes()).hexdigest()
        source_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        if (plan_sha != PLAN_SHA256 or args.reviewed_plan_sha256 != plan_sha or args.reviewed_executor_sha256 != source_sha
                or args.expected_daemon_sha256 != B.DAEMON_SHA256 or (os.getuid(), os.getgid()) != OPERATOR):
            raise Stop("exact reviewed plan/source/daemon/actor required before fixture access")
        evidence = Evidence()
        probe = Probe(CustodyEngine(armed=True, expected_daemon=B.DAEMON_SHA256), evidence)
        print(B.canonical(probe.run()))
    except Exception as error:
        print(B.canonical({"status": "stopped", "reason": str(error) if isinstance(error, Stop) else "unexpected failure; preserve evidence",
                           "phase": probe.phase if probe else "review-fence", "known_container_id": probe.identifier if probe else None,
                           "remaining_resources_require_reconciliation": True}), file=sys.stderr)
        raise SystemExit(2) from None
    finally:
        if evidence is not None:
            evidence.close()


if __name__ == "__main__":
    main()
