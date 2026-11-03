#!/usr/bin/env python3
"""Finite synthetic stopped-container probe; default mode performs no Engine I/O."""
from __future__ import annotations
import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import time
import urllib.parse

PREFIX = "/v1.53"
SOCKET = "/var/run/docker.sock"
IMAGE_ID = "sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"
IMAGE_REFERENCE = "python@" + IMAGE_ID
SESSION = "01a1a250-33bb-7a52-b3e9-32f1a80699a8"
BASE = "um1654-repr-01a1a250-6bd2a7ec"
NAMES = (BASE + "-a", BASE + "-b")
VOLUME = BASE + "-journal"
RAM_ROOT = "/dev/shm/" + BASE
PLAN_SHA256 = "5b6d74c1d55106ce71ae010aec65e0d7968305f4306f1d77d5e94c76101d5bf4"
LABELS = {"com.simplewithus.fixture.task": "UM-1654", "com.simplewithus.fixture.session": SESSION,
          "com.simplewithus.fixture.nonce": "6bd2a7ec", "com.simplewithus.fixture.role": "container"}
VOLUME_LABELS = {**LABELS, "com.simplewithus.fixture.role": "journal"}
VOLUME_OPTIONS = {"type": "tmpfs", "device": "tmpfs", "o": "size=1m,uid=10001,gid=10001"}
ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "GPG_KEY=", "PYTHON_VERSION=",
       "PYTHON_SHA256=", "FIXTURE_MARKER=synthetic-um1654"]
MAX_BYTES = 1024 * 1024
MAX_REQUESTS = 30


class Stop(Exception):
    """Fixed sanitized reason; failures preserve owned resources and RAM evidence."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Stop("duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Stop("invalid JSON response") from None


def invariants(inspected):
    # Same projection as the separately reviewed offline mounted planner.
    config = copy.deepcopy(inspected["Config"])
    config.pop("Hostname", None)
    config["Image"] = inspected["Image"]
    return {"Config": config, "HostConfig": inspected["HostConfig"],
            "Mounts": inspected["Mounts"], "Image": inspected["Image"]}


def source_payload():
    return {"Image": IMAGE_REFERENCE, "User": "10001:10001", "Entrypoint": ["/usr/local/bin/python3"],
            "Cmd": ["-c", "raise SystemExit(97)"], "WorkingDir": "/", "Env": list(ENV),
            "Labels": dict(LABELS), "Healthcheck": {"Test": ["NONE"]},
            "AttachStdin": False, "AttachStdout": False, "AttachStderr": False,
            "OpenStdin": False, "StdinOnce": False, "Tty": False, "ExposedPorts": {},
            "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "AutoRemove": False,
                "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
                "Memory": 67108864, "NanoCpus": 100000000, "PidsLimit": 16,
                "LogConfig": {"Type": "none", "Config": {}}, "IpcMode": "private", "PidMode": "",
                "CgroupnsMode": "private", "PortBindings": {},
                "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=1m"},
                "Mounts": [{"Type": "volume", "Source": VOLUME, "Target": "/data", "ReadOnly": False},
                           {"Type": "bind", "Source": RAM_ROOT + "/config.json", "Target": "/run/fixture/config.json", "ReadOnly": True}]}}


class UnixConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=15)

    def connect(self):
        info = os.lstat(SOCKET)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise Stop("fixed Engine socket custody mismatch")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect(SOCKET)


class FixtureEngine:
    """Fixed fixture routes only; even an armed instance has no start/exec route."""
    def __init__(self, *, armed=False, connection=UnixConnection, clock=time.monotonic):
        self.armed, self.connection, self.clock = armed, connection, clock
        self.ids = set()
        self.bodies = {}
        self.calls = 0
        self.mutations = set()

    def permit_container(self, identifier):
        if not re.fullmatch(r"[0-9a-f]{64}", identifier) or identifier in self.ids:
            raise Stop("invalid or reused fixture ID")
        self.ids.add(identifier)

    def permit_body(self, name, body):
        if name not in NAMES or name in self.bodies:
            raise Stop("invalid or repeated create body")
        self.bodies[name] = digest(body)

    def request(self, method, path, body=None):
        image_path = "/images/" + urllib.parse.quote(IMAGE_REFERENCE, safe="") + "/json"
        readable = {"/info", "/version", image_path, "/volumes/" + VOLUME}
        readable.update("/containers/" + name + "/json" for name in NAMES)
        readable.update("/containers/" + identifier + "/json" for identifier in self.ids)
        allowed = method == "GET" and path in readable and body is None
        if method != "GET" and not self.armed:
            raise Stop("fixture mutations are not armed")
        if method == "POST" and path == "/volumes/create":
            allowed = body == {"Name": VOLUME, "Driver": "local", "DriverOpts": VOLUME_OPTIONS, "Labels": VOLUME_LABELS}
        if method == "POST" and path.startswith("/containers/create?"):
            for name in NAMES:
                if path == "/containers/create?name=" + name:
                    allowed = name in self.bodies and digest(body) == self.bodies[name]
        if method == "DELETE" and body is None:
            allowed = path == "/volumes/" + VOLUME + "?force=false" or any(
                path == "/containers/" + identifier + "?v=false&force=false&link=false" for identifier in self.ids)
        if not allowed or self.calls >= MAX_REQUESTS:
            raise Stop("route, payload or request budget refused before socket access")
        if method != "GET":
            mutation = (method, path)
            if mutation in self.mutations:
                raise Stop("fixture mutation already attempted; preserve evidence")
            self.mutations.add(mutation)
        self.calls += 1
        connection = self.connection()
        deadline = self.clock() + 15
        try:
            encoded = None if body is None else canonical(body).encode()
            if encoded is not None and len(encoded) > MAX_BYTES:
                raise Stop("create body exceeds limit")
            connection.request(method, PREFIX + path, body=encoded,
                               headers={"Accept": "application/json", "Content-Type": "application/json"})
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise Stop("Engine request deadline exceeded")
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            response = connection.getresponse()
            raw = bytearray()
            while True:
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise Stop("Engine request deadline exceeded")
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > MAX_BYTES:
                    raise Stop("Engine response exceeds limit")
            return response.status, decode(raw) if raw else None
        except Exception:
            raise Stop("Engine response unavailable; preserve evidence and reconcile without retry") from None
        finally:
            connection.close()


class RamEvidence:
    """Only the exact new RAM directory; no recursive or prefix cleanup."""
    def __init__(self):
        self.fd = None
        self.identity = None
        self.files = {}

    def open(self):
        with open("/proc/self/mountinfo", "rb") as handle:
            mounts = handle.read(MAX_BYTES + 1)
        if len(mounts) > MAX_BYTES or not any(
                b" /dev/shm " in line and b" - tmpfs " in line for line in mounts.splitlines()):
            raise Stop("reviewed RAM root is not tmpfs")
        parent = os.open("/dev/shm", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir(BASE, 0o700, dir_fd=parent)
            self.fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            info = os.fstat(self.fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise Stop("RAM evidence directory ownership mismatch")
            self.identity = (info.st_dev, info.st_ino, info.st_uid)
        finally:
            os.close(parent)
        self.write("config.json", {"fixture": "UM-1654 representation probe"})

    def write(self, name, value):
        if self.fd is None or not re.fullmatch(r"[a-z0-9-]+\.json", name) or name in self.files:
            raise Stop("invalid evidence file")
        raw = canonical(value).encode()
        if len(raw) > MAX_BYTES:
            raise Stop("evidence exceeds bound")
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            os.fchmod(descriptor, 0o600)
            data = memoryview(raw)
            while data:
                written = os.write(descriptor, data)
                if written <= 0:
                    raise Stop("evidence write incomplete")
                data = data[written:]
            os.fsync(descriptor)
            info = os.fstat(descriptor)
            self.files[name] = ((info.st_dev, info.st_ino, info.st_uid, info.st_size), hashlib.sha256(raw).digest())
        finally:
            os.close(descriptor)
        os.fsync(self.fd)

    def check(self):
        info = os.lstat(RAM_ROOT)
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino, info.st_uid) != self.identity:
            raise Stop("RAM directory changed; preserve evidence")
        if set(os.listdir(self.fd)) != set(self.files):
            raise Stop("unexpected RAM evidence entry; preserve evidence")
        for name, (identity, expected_hash) in self.files.items():
            info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino, info.st_uid, info.st_size) != identity or stat.S_IMODE(info.st_mode) != 0o600:
                raise Stop("RAM evidence file changed; preserve evidence")
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
            try:
                before = os.fstat(descriptor)
                if (before.st_dev, before.st_ino, before.st_uid, before.st_size) != identity or stat.S_IMODE(before.st_mode) != 0o600:
                    raise Stop("RAM evidence changed before readback")
                raw = bytearray()
                while len(raw) < before.st_size:
                    chunk = os.read(descriptor, before.st_size - len(raw))
                    if not chunk:
                        raise Stop("RAM evidence readback incomplete")
                    raw.extend(chunk)
                after = os.fstat(descriptor)
                if (any(getattr(before, key) != getattr(after, key) for key in ("st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_uid"))
                        or hashlib.sha256(raw).digest() != expected_hash):
                    raise Stop("RAM evidence readback changed; preserve evidence")
            finally:
                os.close(descriptor)

    def cleanup(self):
        self.check()
        for name in self.files:
            os.unlink(name, dir_fd=self.fd)
        os.rmdir(RAM_ROOT)
        self.close()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def owned(inspected, identifier, name):
    if (inspected.get("Id") != identifier or inspected.get("Name") != "/" + name
            or inspected.get("Image") != IMAGE_ID or inspected.get("Config", {}).get("Labels") != LABELS
            or inspected.get("State", {}).get("Running") is not False):
        raise Stop("fixture ownership, image or stopped state changed; preserve resources")


def synthetic(inspected):
    config, host = inspected["Config"], inspected["HostConfig"]
    expected = source_payload()
    for key in ("User", "Entrypoint", "Cmd", "WorkingDir", "Env", "Labels", "OpenStdin", "StdinOnce", "Tty"):
        if config.get(key) != expected[key]:
            raise Stop("synthetic Config mismatch; preserve resources")
    if config.get("Healthcheck", {}).get("Test") != ["NONE"] or config.get("ExposedPorts") not in (None, {}):
        raise Stop("synthetic healthcheck or ports mismatch")
    for key, value in expected["HostConfig"].items():
        if key in ("Mounts", "LogConfig"):
            continue
        if host.get(key) != value:
            raise Stop("synthetic HostConfig mismatch; preserve resources")
    if host.get("LogConfig", {}).get("Type") != "none" or host["LogConfig"].get("Config") not in (None, {}):
        raise Stop("unexpected fixture logging")
    declarations = host.get("Mounts")
    if not isinstance(declarations, list) or len(declarations) != 2:
        raise Stop("unexpected fixture mount declarations")
    targets = set()
    for declaration in declarations:
        target = declaration.get("Target")
        desired = next((row for row in expected["HostConfig"]["Mounts"] if row["Target"] == target), None)
        if (desired is None or target in targets or declaration.get("Type") != desired["Type"]
                or declaration.get("Source") != desired["Source"]
                or declaration.get("ReadOnly", False) is not desired["ReadOnly"]):
            raise Stop("unexpected fixture mount declaration")
        targets.add(target)
    if any(host.get(key) for key in ("Binds", "VolumesFrom", "Links", "ExtraHosts", "Devices", "DeviceRequests", "CapAdd")):
        raise Stop("unexpected fixture host access")
    mounts = inspected.get("Mounts")
    if not isinstance(mounts, list):
        raise Stop("invalid fixture mounts")
    targets = {row.get("Destination") for row in mounts}
    required = {"/data", "/run/fixture/config.json"}
    if len(targets) != len(mounts) or targets not in (required, required | {"/tmp"}):
        raise Stop("unexpected fixture mount targets")
    for row in mounts:
        if row["Destination"] == "/data":
            if row.get("Type") != "volume" or row.get("Name") != VOLUME or row.get("RW") is not True:
                raise Stop("unexpected fixture volume mount")
        elif row["Destination"] == "/tmp":
            if row.get("Type") != "tmpfs" or row.get("Source") not in (None, "") or row.get("RW") is not True:
                raise Stop("unexpected fixture tmpfs mount")
        elif row.get("Type") != "bind" or row.get("Source") != RAM_ROOT + "/config.json" or row.get("RW") is not False:
            raise Stop("unexpected fixture bind mount")


class Probe:
    def __init__(self, engine, evidence, expected_daemon):
        self.engine, self.evidence, self.expected_daemon = engine, evidence, expected_daemon
        self.ids = []
        self.phase = "preflight"

    def call(self, method, path, body=None, expected=200):
        try:
            status, data = self.engine.request(method, path, body)
        except Exception:
            raise Stop("request outcome unknown; preserve resources and evidence") from None
        if status != expected:
            raise Stop("unexpected response status; preserve resources and evidence")
        return data

    def inspect(self, identifier):
        return self.call("GET", "/containers/" + identifier + "/json")

    def verify_daemon(self):
        info = self.call("GET", "/info")
        identifier = info.get("ID")
        if not isinstance(identifier, str) or hashlib.sha256(identifier.encode()).hexdigest() != self.expected_daemon:
            raise Stop("reviewed local daemon identity mismatch")

    def mutate(self, method, path, body=None, expected=200):
        self.verify_daemon()
        return self.call(method, path, body, expected)

    def volume(self):
        value = self.call("GET", "/volumes/" + VOLUME)
        if (value.get("Name") != VOLUME or value.get("Labels") != VOLUME_LABELS
                or value.get("Driver") != "local" or value.get("Options") != VOLUME_OPTIONS):
            raise Stop("fixture volume ownership or options changed")
        return value

    def run(self):
        self.verify_daemon()
        version = self.call("GET", "/version")
        try:
            minimum = tuple(map(int, version["MinAPIVersion"].split(".")))
            maximum = tuple(map(int, version["ApiVersion"].split(".")))
        except Exception:
            raise Stop("invalid Engine API version") from None
        if not minimum <= (1, 53) <= maximum:
            raise Stop("fixed API version unsupported")
        image = self.call("GET", "/images/" + urllib.parse.quote(IMAGE_REFERENCE, safe="") + "/json")
        if image.get("Id") != IMAGE_ID or IMAGE_REFERENCE not in image.get("RepoDigests", []):
            raise Stop("reviewed cached image unavailable")
        image_names = [entry.split("=", 1)[0] for entry in image.get("Config", {}).get("Env", [])]
        if sorted(image_names) != sorted(entry.split("=", 1)[0] for entry in ENV[:-1]) or image.get("Config", {}).get("Volumes"):
            raise Stop("unexpected cached image environment or volume hints")
        for name in NAMES:
            self.call("GET", "/containers/" + name + "/json", expected=404)
        self.call("GET", "/volumes/" + VOLUME, expected=404)
        self.evidence.open()
        self.phase = "create-volume"
        self.evidence.write("volume-intent.json", {"name": VOLUME})
        self.mutate("POST", "/volumes/create", {"Name": VOLUME, "Driver": "local", "DriverOpts": VOLUME_OPTIONS, "Labels": VOLUME_LABELS}, expected=201)
        volume = self.volume()
        self.evidence.write("volume-confirmed.json", {"name": VOLUME, "metadata_sha256": digest(volume)})
        payload = source_payload()
        observed = []
        for index, name in enumerate(NAMES):
            self.phase = "create-" + str(index)
            self.engine.permit_body(name, payload)
            self.evidence.write(f"container-{index}-intent.json", {"name": name, "payload_sha256": digest(payload)})
            self.evidence.check()
            created = self.mutate("POST", "/containers/create?name=" + name, payload, expected=201)
            if (not isinstance(created, dict) or not isinstance(created.get("Id"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", created["Id"]) or created["Id"] in self.ids):
                raise Stop("create identity requires reconciliation")
            identifier = created["Id"]
            self.ids.append(identifier)
            self.engine.permit_container(identifier)
            if created.get("Warnings") not in (None, []):
                raise Stop("create warnings require reconciliation")
            item = self.inspect(identifier)
            owned(item, identifier, name)
            synthetic(item)
            journal_mount = next(row for row in item["Mounts"] if row["Destination"] == "/data")
            if journal_mount.get("Source") != volume.get("Mountpoint"):
                raise Stop("fixture volume mountpoint mismatch")
            observed.append(item)
            self.evidence.write(f"container-{index}-confirmed.json", item)
            payload = copy.deepcopy(item["Config"])
            payload["Image"] = item["Image"]
            payload["HostConfig"] = copy.deepcopy(item["HostConfig"])
        projections = [invariants(item) for item in observed]
        mismatch = [key for key in ("Config", "HostConfig", "Mounts", "Image") if projections[0][key] != projections[1][key]]
        if mismatch:
            self.evidence.write("mismatch.json", {"fields": mismatch})
            raise Stop("representation mismatch; preserve resources and evidence")
        result = {"status": "equivalent", "image_id": IMAGE_ID, "invariant_sha256": digest(projections[0]),
                  "container_ids": list(self.ids), "started": False, "network_mode": "none"}
        self.evidence.write("comparison.json", result)
        self.phase = "cleanup"
        for identifier, name in reversed(list(zip(self.ids, NAMES))):
            owned(self.inspect(identifier), identifier, name)
            self.evidence.write("delete-" + str(self.ids.index(identifier)) + "-intent.json", {"id": identifier})
            self.mutate("DELETE", "/containers/" + identifier + "?v=false&force=false&link=false", expected=204)
            self.call("GET", "/containers/" + identifier + "/json", expected=404)
            self.call("GET", "/containers/" + name + "/json", expected=404)
        self.volume()
        self.evidence.write("volume-delete-intent.json", {"name": VOLUME})
        self.mutate("DELETE", "/volumes/" + VOLUME + "?force=false", expected=204)
        self.call("GET", "/volumes/" + VOLUME, expected=404)
        self.evidence.cleanup()
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
        print(canonical({"mode": "offline_plan", "engine_calls": 0, "writes": 0, "image_id": IMAGE_ID,
                         "containers": list(NAMES), "volume": VOLUME, "plan_sha256": PLAN_SHA256}))
        return
    probe = None
    evidence = None
    try:
        plan = Path(__file__).resolve().parents[2] / "docs/runbooks/engine-representation-fixture-plan.md"
        actual_plan = hashlib.sha256(plan.read_bytes()).hexdigest()
        actual_executor = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        if (actual_plan != PLAN_SHA256 or args.reviewed_plan_sha256 != actual_plan
                or args.reviewed_executor_sha256 != actual_executor
                or not re.fullmatch(r"[0-9a-f]{64}", args.expected_daemon_sha256 or "")):
            raise Stop("exact reviewed plan, executor and daemon fingerprints required")
        evidence = RamEvidence()
        probe = Probe(FixtureEngine(armed=True), evidence, args.expected_daemon_sha256)
        print(canonical(probe.run()))
    except Exception as error:
        print(canonical({"status": "stopped", "reason": str(error) if isinstance(error, Stop) else "unexpected failure; preserve evidence",
                         "phase": probe.phase if probe else "review-fence", "known_container_ids": probe.ids if probe else [],
                         "resources_preserved": True}), file=sys.stderr)
        raise SystemExit(2) from None
    finally:
        if evidence is not None:
            evidence.close()


if __name__ == "__main__":
    main()
