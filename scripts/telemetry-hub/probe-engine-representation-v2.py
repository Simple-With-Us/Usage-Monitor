#!/usr/bin/env python3
"""V2 synthetic stopped-container candidate; default performs no Engine I/O."""
from __future__ import annotations
import argparse
import copy
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import time
import urllib.parse

PREFIX = "/v1.53"
SOCKET = "/var/run/docker.sock"
IMAGE_ID = "sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"
IMAGE_REFERENCE = "python@" + IMAGE_ID
SESSION = "01a1a250-33bb-7a52-b3e9-32f1a80699a8"
BASE = "um1654-repr-01a1a250-8e4a92f7"
NAMES = (BASE + "-a", BASE + "-b")
VOLUME = BASE + "-journal"
RAM_ROOT = "/dev/shm/" + BASE
PLAN_SHA256 = "57b22012ea25be07eba29b148f177801ca463ac6ca3292553ba6f39ee13e6027"
LABELS = {"com.simplewithus.fixture.task": "UM-1654", "com.simplewithus.fixture.session": SESSION,
          "com.simplewithus.fixture.nonce": "8e4a92f7", "com.simplewithus.fixture.role": "container"}
VOLUME_LABELS = {**LABELS, "com.simplewithus.fixture.role": "journal"}
VOLUME_OPTIONS = {"type": "tmpfs", "device": "tmpfs", "o": "size=1m,uid=10001,gid=10001"}
ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "GPG_KEY=", "PYTHON_VERSION=",
       "PYTHON_SHA256=", "FIXTURE_MARKER=synthetic-um1654"]
MAX_BYTES = 1024 * 1024
MAX_REQUESTS = 30
MASKED_PATHS = ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys",
                "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list",
                "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"]
READONLY_PATHS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"]
HOST_ZERO_FIELDS = {"BlkioWeight", "CpuShares", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod", "CpuRealtimeRuntime",
                    "MemoryReservation", "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth"}
HOST_EMPTY_LIST_FIELDS = {"Binds", "Links", "Dns", "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "VolumesFrom",
                         "CapAdd", "Devices", "DeviceRequests", "DeviceCgroupRules", "Ulimits", "BlkioWeightDevice",
                         "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps"}
HOST_EMPTY_MAP_FIELDS = {"Annotations", "StorageOpt", "Sysctls"}
HOST_EMPTY_STRING_FIELDS = {"CpusetCpus", "CpusetMems"}


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
            "NetworkDisabled": True, "Domainname": "", "StopSignal": "SIGTERM", "StopTimeout": 1,
            "AttachStdin": False, "AttachStdout": False, "AttachStderr": False,
            "OpenStdin": False, "StdinOnce": False, "Tty": False, "ExposedPorts": {},
            "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "AutoRemove": False,
                "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
                "Memory": 67108864, "NanoCpus": 100000000, "PidsLimit": 16,
                "MemorySwap": 67108864, "MemorySwappiness": None, "OomKillDisable": False, "OomScoreAdj": 0,
                "LogConfig": {"Type": "none", "Config": {}}, "IpcMode": "private", "PidMode": "",
                "CgroupnsMode": "private", "UTSMode": "", "UsernsMode": "", "CgroupParent": "", "Cgroup": "",
                "ContainerIDFile": "", "VolumeDriver": "", "Isolation": "", "Runtime": "runc", "Init": False,
                "PublishAllPorts": False, "ShmSize": 1048576, "PortBindings": {},
                "MaskedPaths": list(MASKED_PATHS), "ReadonlyPaths": list(READONLY_PATHS),
                "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=1m"},
                "Mounts": [{"Type": "volume", "Source": VOLUME, "Target": "/data", "VolumeOptions": {"NoCopy": True}},
                           {"Type": "bind", "Source": RAM_ROOT + "/config.json", "Target": "/run/fixture/config.json", "ReadOnly": True,
                            "BindOptions": {"Propagation": "rprivate", "CreateMountpoint": False}}]}}


def same_json(left, right):
    return canonical(left) == canonical(right)


def validate_create_payload(payload, resolved=False):
    """Closed API-1.53 Config/HostConfig policy; no unreviewed field is forwarded.

    With resolved=True the payload is a daemon-resolved inspection of an
    already-created container, so the one normalization recorded in
    docs/runbooks/engine-representation-stopped-cleanup-plan.md (requested
    MemorySwappiness 0 resolved to null by the cgroup-v2 daemon) is accepted;
    an outbound create body stays byte-exact.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("HostConfig"), dict):
        raise Stop("invalid fixture create shape")
    expected = source_payload()
    optional_config = {"Hostname", "ArgsEscaped", "Volumes", "OnBuild", "Shell"}
    if set(payload) - set(expected) - optional_config:
        raise Stop("unreviewed fixture Config field")
    for key, value in expected.items():
        if key in ("HostConfig", "Image", "Healthcheck", "ExposedPorts"):
            continue
        if key not in payload or not same_json(payload[key], value):
            raise Stop("synthetic Config mismatch; preserve resources")
    if payload.get("Image") not in (IMAGE_REFERENCE, IMAGE_ID):
        raise Stop("unexpected fixture image reference")
    hostname = payload.get("Hostname")
    if hostname is not None and not re.fullmatch(r"[0-9a-f]{12}", hostname):
        raise Stop("unexpected fixture hostname")
    if (payload.get("ArgsEscaped") is not None and payload.get("ArgsEscaped") is not False
            or payload.get("OnBuild") not in (None, []) or payload.get("Shell") not in (None, [])):
        raise Stop("unexpected executable Config default")
    if payload.get("ExposedPorts") not in (None, {}):
        raise Stop("unexpected exposed ports")
    hints = payload.get("Volumes")
    if hints is not None and (not isinstance(hints, dict) or set(hints) - {"/data", "/run/fixture/config.json", "/tmp"}
                              or any(value != {} for value in hints.values())):
        raise Stop("unexpected anonymous volume hint")
    health = payload.get("Healthcheck")
    if (not isinstance(health, dict) or health.get("Test") != ["NONE"]
            or set(health) - {"Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"}
            or any(type(value) is not int or value != 0 for key, value in health.items() if key != "Test")):
        raise Stop("unexpected fixture healthcheck")
    host, required = payload["HostConfig"], expected["HostConfig"]
    allowed = set(required) | HOST_ZERO_FIELDS | HOST_EMPTY_LIST_FIELDS | HOST_EMPTY_MAP_FIELDS | HOST_EMPTY_STRING_FIELDS | {"ConsoleSize"}
    if set(host) - allowed:
        raise Stop("unreviewed fixture HostConfig field")
    for key, value in required.items():
        if key in ("Mounts", "LogConfig"):
            continue
        if key not in host or not same_json(host[key], value):
            raise Stop("synthetic HostConfig mismatch; preserve resources")
    for key in HOST_ZERO_FIELDS & set(host):
        if type(host[key]) is not int or host[key] != 0:
            raise Stop("unreviewed fixture resource default")
    for key in HOST_EMPTY_LIST_FIELDS & set(host):
        if host[key] is not None and host[key] != []:
            raise Stop("unexpected fixture host access")
    for key in HOST_EMPTY_MAP_FIELDS & set(host):
        if host[key] is not None and host[key] != {}:
            raise Stop("unexpected fixture host options")
    for key in HOST_EMPTY_STRING_FIELDS & set(host):
        if host[key] != "":
            raise Stop("unexpected fixture CPU affinity")
    if "ConsoleSize" in host and not same_json(host["ConsoleSize"], [0, 0]):
        raise Stop("unexpected fixture console default")
    logging = host.get("LogConfig")
    if (not isinstance(logging, dict) or set(logging) - {"Type", "Config"}
            or logging.get("Type") != "none" or logging.get("Config") not in (None, {})):
        raise Stop("unexpected fixture logging")
    declarations = host.get("Mounts")
    if not isinstance(declarations, list) or len(declarations) != 2:
        raise Stop("unexpected fixture mount declarations")
    seen = set()
    for declaration in declarations:
        if not isinstance(declaration, dict) or set(declaration) - {"Type", "Source", "Target", "ReadOnly", "Consistency", "BindOptions", "VolumeOptions"}:
            raise Stop("unreviewed fixture mount option")
        target = declaration.get("Target")
        desired = next((row for row in required["Mounts"] if row["Target"] == target), None)
        if (desired is None or target in seen or declaration.get("Type") != desired["Type"]
                or declaration.get("Source") != desired["Source"] or declaration.get("ReadOnly", False) is not desired.get("ReadOnly", False)
                or declaration.get("Consistency", "") != ""):
            raise Stop("unexpected fixture mount declaration")
        if declaration["Type"] == "bind":
            options = declaration.get("BindOptions")
            if (not isinstance(options, dict) or set(options) - {"Propagation", "CreateMountpoint", "NonRecursive", "ReadOnlyNonRecursive", "ReadOnlyForceRecursive"}
                    or options.get("Propagation") != "rprivate"
                    or any(value is not False for key, value in options.items() if key != "Propagation")
                    or declaration.get("VolumeOptions") not in (None, {})):
                raise Stop("unexpected fixture bind propagation or access")
        else:
            options = declaration.get("VolumeOptions")
            if (not isinstance(options, dict) or options.get("NoCopy") is not True
                    or set(options) - {"NoCopy", "Subpath"} or options.get("Subpath", "") != ""
                    or declaration.get("BindOptions") not in (None, {})):
                raise Stop("unexpected fixture volume options")
        seen.add(target)


class Deadline:
    def __init__(self, clock, seconds=15):
        self.clock, self.end = clock, clock() + seconds

    def remaining(self):
        remaining = self.end - self.clock()
        if remaining <= 0:
            raise Stop("absolute Engine deadline exceeded")
        return remaining


class DeadlineReader(io.RawIOBase):
    """Buffered HTTP header parsing must check the deadline on every recv."""
    def __init__(self, sock):
        self.sock = sock

    def readable(self):
        return True

    def readinto(self, buffer):
        return self.sock.recv_into(buffer)


class DeadlineBufferedReader(io.BufferedReader):
    def __init__(self, raw, deadline):
        super().__init__(raw)
        self.deadline = deadline

    def readline(self, size=-1):
        self.deadline.remaining()
        result = super().readline(size)
        self.deadline.remaining()
        return result


class DeadlineSocket:
    def __init__(self, raw, deadline):
        self.raw, self.deadline, self.wire_bytes = raw, deadline, 0

    def recv_into(self, buffer):
        self.raw.settimeout(self.deadline.remaining())
        count = self.raw.recv_into(memoryview(buffer)[:min(len(buffer), MAX_BYTES + 1 - self.wire_bytes)])
        self.deadline.remaining()
        self.wire_bytes += count
        if self.wire_bytes > MAX_BYTES:
            raise Stop("Engine wire response exceeds limit")
        return count

    def sendall(self, data):
        self.raw.settimeout(self.deadline.remaining())
        self.raw.sendall(data)
        self.deadline.remaining()

    def makefile(self, mode):
        if mode != "rb":
            raise Stop("unsupported Engine socket file mode")
        return DeadlineBufferedReader(DeadlineReader(self), self.deadline)

    def fileno(self):
        return self.raw.fileno()

    def peer(self):
        return struct.unpack("3i", self.raw.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))

    def close(self):
        self.raw.close()


class UnixConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=15)
        self.auto_open = 0
        self.deadline = None
        self.begun = False
        self.connect_attempted = False

    def begin(self, deadline):
        if self.begun:
            raise Stop("Engine connection cannot reconnect")
        self.begun, self.deadline = True, deadline
        self.connect()
        return self.identity()

    def connect(self):
        if self.connect_attempted or self.sock is not None or self.deadline is None:
            raise Stop("unreviewed Engine reconnect")
        self.connect_attempted = True
        info = os.lstat(SOCKET)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise Stop("fixed Engine socket custody mismatch")
        raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            raw.settimeout(self.deadline.remaining())
            raw.connect(SOCKET)
            wrapped = DeadlineSocket(raw, self.deadline)
            if wrapped.peer()[1] != 0:
                raise Stop("Engine peer is not root")
            self.sock = wrapped
        except Exception:
            raw.close()
            raise

    def identity(self):
        if not isinstance(self.sock, DeadlineSocket) or self.sock.fileno() < 0:
            raise Stop("pinned Engine connection closed")
        return (id(self.sock), self.sock.fileno(), self.sock.peer())

    def reset_response_budget(self):
        if not isinstance(self.sock, DeadlineSocket):
            raise Stop("pinned Engine socket unavailable")
        self.sock.wire_bytes = 0


class FixtureEngine:
    """Fixed fixture routes only; even an armed instance has no start/exec route."""
    def __init__(self, *, armed=False, expected_daemon=None, connection=UnixConnection, clock=time.monotonic):
        self.armed, self.connection, self.clock = armed, connection, clock
        self.expected_daemon = expected_daemon
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
        validate_create_payload(body)
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
                    if allowed:
                        validate_create_payload(body)
        if method == "DELETE" and body is None:
            allowed = path == "/volumes/" + VOLUME + "?force=false" or any(
                path == "/containers/" + identifier + "?v=false&force=false&link=false" for identifier in self.ids)
        wire_calls = 1 if method == "GET" else 2
        if not allowed or self.calls + wire_calls > MAX_REQUESTS:
            raise Stop("route, payload or request budget refused before socket access")
        if method != "GET":
            if not re.fullmatch(r"[a-f0-9]{64}", self.expected_daemon or ""):
                raise Stop("reviewed daemon fingerprint required before mutation")
            mutation = (method, path)
            if mutation in self.mutations:
                raise Stop("fixture mutation already attempted; preserve evidence")
            self.mutations.add(mutation)
        connection = self.connection()
        deadline = Deadline(self.clock)
        try:
            encoded = None if body is None else canonical(body).encode()
            if encoded is not None and len(encoded) > MAX_BYTES:
                raise Stop("create body exceeds limit")
            pinned = connection.begin(deadline)

            def exchange(verb, route, data=None):
                if connection.identity() != pinned:
                    raise Stop("Engine connection identity changed")
                deadline.remaining()
                self.calls += 1
                connection.request(verb, PREFIX + route, body=data,
                                   headers={"Accept": "application/json", "Content-Type": "application/json"})
                if connection.identity() != pinned:
                    raise Stop("Engine connection identity changed")
                connection.reset_response_budget()
                response = connection.getresponse()
                raw = bytearray()
                while True:
                    deadline.remaining()
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - len(raw)))
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > MAX_BYTES:
                        raise Stop("Engine response exceeds limit")
                return response.status, decode(raw) if raw else None, response.will_close

            if method != "GET":
                status, info, closing = exchange("GET", "/info")
                if (status != 200 or closing or connection.identity() != pinned
                        or not isinstance(info, dict) or not isinstance(info.get("ID"), str)
                        or hashlib.sha256(info["ID"].encode()).hexdigest() != self.expected_daemon):
                    raise Stop("same-connection daemon verification failed before mutation")
                if method == "POST" and path.startswith("/containers/create?"):
                    validate_create_payload(decode(encoded))
            if method != "GET":
                # Only the mutation exchange itself is outcome-unknown on
                # failure; every earlier failure is provably pre-send.
                try:
                    status, value, _closing = exchange(method, path, encoded)
                except Exception:
                    raise Stop("Engine response unavailable after mutation sent; reconcile without retry") from None
                return status, value
            status, value, _closing = exchange(method, path, encoded)
            return status, value
        except Stop:
            raise
        except Exception:
            raise Stop("Engine response unavailable before mutation; no mutation was sent") from None
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
    payload = copy.deepcopy(inspected["Config"])
    payload["HostConfig"] = copy.deepcopy(inspected["HostConfig"])
    validate_create_payload(payload, resolved=True)
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
        if (not isinstance(identifier, str) or hashlib.sha256(identifier.encode()).hexdigest() != self.expected_daemon
                or info.get("CgroupVersion") != "2"):
            raise Stop("reviewed local daemon identity or cgroup version mismatch")

    def mutate(self, method, path, body=None, expected=200):
        # The transport verifies /info and sends this mutation on one pinned socket.
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
            validate_create_payload(payload)
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
        plan = Path(__file__).resolve().parents[2] / "docs/runbooks/engine-representation-fixture-v2-plan.md"
        actual_plan = hashlib.sha256(plan.read_bytes()).hexdigest()
        actual_executor = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        if (actual_plan != PLAN_SHA256 or args.reviewed_plan_sha256 != actual_plan
                or args.reviewed_executor_sha256 != actual_executor
                or not re.fullmatch(r"[0-9a-f]{64}", args.expected_daemon_sha256 or "")):
            raise Stop("exact reviewed plan, executor and daemon fingerprints required")
        evidence = RamEvidence()
        probe = Probe(FixtureEngine(armed=True, expected_daemon=args.expected_daemon_sha256), evidence, args.expected_daemon_sha256)
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
