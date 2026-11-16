#!/usr/bin/env python3
"""Offline-tested pinned Engine lifecycle candidate; real transport is GET-only."""
from __future__ import annotations
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time
import urllib.parse

spec = importlib.util.spec_from_file_location("mounted_snapshot", Path(__file__).with_name("sync-mounted-sources.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
Stop = M.Stop
PREFIX = "/v1.53"
SOCKET = "/var/run/docker.sock"
MAX_RESPONSE = 1024 * 1024
REQUEST_SECONDS = 15


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def daemon_fingerprint(identifier):
    """Match V2's SHA256 of the exact raw UTF-8 daemon ID, without JSON quotes."""
    if not isinstance(identifier, str) or not identifier:
        raise Stop("invalid Engine daemon identity")
    return hashlib.sha256(identifier.encode("utf-8")).hexdigest()


class Deadline:
    def __init__(self, clock, seconds=REQUEST_SECONDS):
        self.clock, self.end = clock, clock() + seconds

    def remaining(self):
        remaining = self.end - self.clock()
        if remaining <= 0:
            raise Stop("absolute Engine deadline exceeded")
        return remaining


class DeadlineReader(io.RawIOBase):
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

    def close(self):
        """Response close must not discard bytes prefetched for the next response."""


class DeadlineSocket:
    """Bound all received wire bytes, including HTTP headers and chunk framing."""
    def __init__(self, raw, deadline):
        self.raw, self.deadline, self.wire_bytes = raw, deadline, 0
        self._file = None

    def recv_into(self, buffer):
        self.raw.settimeout(self.deadline.remaining())
        count = self.raw.recv_into(memoryview(buffer)[:min(len(buffer), MAX_RESPONSE + 1 - self.wire_bytes)])
        self.deadline.remaining()
        self.wire_bytes += count
        if self.wire_bytes > MAX_RESPONSE:
            raise Stop("Engine wire response exceeds limit")
        return count

    def sendall(self, data):
        self.raw.settimeout(self.deadline.remaining())
        self.raw.sendall(data)
        self.deadline.remaining()

    def makefile(self, mode):
        if mode != "rb":
            raise Stop("unsupported Engine socket file mode")
        if self._file is None:
            self._file = DeadlineBufferedReader(DeadlineReader(self), self.deadline)
        return self._file

    def fileno(self):
        return self.raw.fileno()

    def peer(self):
        return struct.unpack("3i", self.raw.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))

    def close(self):
        self.raw.close()


class UnixConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=REQUEST_SECONDS)
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
            raise Stop("fixed local Engine socket custody mismatch")
        raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            raw.settimeout(self.deadline.remaining())
            raw.connect(SOCKET)
            self.deadline.remaining()
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


class ReadOnlyEngine:
    """There is deliberately no production mutation switch or remote Docker context."""
    def __init__(self, *, expected_daemon=None, connection=None, clock=time.monotonic):
        self.expected_daemon = expected_daemon
        self.connection = UnixConnection if connection is None else connection
        self.clock = clock

    def request(self, method, path, body=None):
        if method != "GET" or body is not None:
            raise Stop("live Engine mutations are disabled")
        if (not isinstance(path, str) or not path.startswith(PREFIX + "/")
                or any(character in path for character in ("\r", "\n", "#"))):
            raise Stop("unsupported fixed Engine route")
        if not re.fullmatch(r"[0-9a-f]{64}", self.expected_daemon or ""):
            raise Stop("reviewed raw daemon fingerprint required before socket access")
        deadline = Deadline(self.clock)
        connection = self.connection()
        try:
            pinned = connection.begin(deadline)

            def exchange(route):
                if connection.identity() != pinned:
                    raise Stop("Engine connection identity changed")
                deadline.remaining()
                connection.request("GET", route, headers={"Accept": "application/json"})
                if connection.identity() != pinned:
                    raise Stop("Engine connection identity changed")
                connection.reset_response_budget()
                response = connection.getresponse()
                raw = bytearray()
                while True:
                    deadline.remaining()
                    chunk = response.read1(min(65536, MAX_RESPONSE + 1 - len(raw)))
                    deadline.remaining()
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > MAX_RESPONSE:
                        raise Stop("Engine metadata response exceeds limit")
                # Close explicitly: some supported runtimes only mark a fully read
                # response closed via close(), and reuse requires it.
                response.close()
                if connection.identity() != pinned:
                    raise Stop("Engine connection identity changed")
                return response.status, M.C.decode(raw) if raw else None, response.will_close

            status, info, closing = exchange(PREFIX + "/info")
            if (status != 200 or closing or not isinstance(info, dict)
                    or daemon_fingerprint(info.get("ID")) != self.expected_daemon):
                raise Stop("same-connection daemon verification failed")
            if path == PREFIX + "/info":
                return status, info
            status, value, _closing = exchange(path)
            return status, value
        except Exception:
            raise Stop("read-only Engine request failed; no raw response exposed") from None
        finally:
            connection.close()


class PrivateReceipts:
    """Exclusive owner-only fsynced receipts with exact private readback."""
    def __init__(self, prefix):
        self.prefix = prefix

    def __call__(self, phase, data):
        if not re.fullmatch(r"[a-z0-9-]{1,100}", phase):
            raise Stop("invalid receipt phase")
        path = self.prefix + "." + phase + ".json"
        raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
        M.C.exclusive_write(path, raw)
        if M.C.private_read(path) != raw:
            raise Stop("private lifecycle receipt readback failed")


class Lifecycle:
    """Single-attempt lifecycle with injectable fake transport and durable private receipts.

    This class is not connected to any enabled live executor.  Mutation methods
    reach only test transports because ReadOnlyEngine refuses them before I/O.
    """
    def __init__(self, manifest, transport, *, receipt, clock=time.monotonic, pause=time.sleep):
        self.m = manifest
        self.transport = transport
        self.receipt = receipt
        self.clock = clock
        self.pause = pause
        self.sequence = 0
        self.old = None
        self.payload = None
        self.new_id = None

    def call(self, method, path, body=None, expected=200):
        try:
            status, value = self.transport.request(method, PREFIX + path, body)
        except Exception:
            raise Stop("Engine request outcome unavailable; reconcile, never retry") from None
        if status != expected:
            raise Stop("unexpected Engine response; reconcile, never retry")
        return value

    def record(self, phase, data=None):
        # The sink must exclusively create, fsync and read back each private receipt.
        self.receipt(f"{self.sequence:02d}-{phase}", {} if data is None else data)
        self.sequence += 1

    def inspect(self, identifier):
        if not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise Stop("exact container ID required")
        return self.call("GET", "/containers/" + identifier + "/json")

    def sole(self, expected_id, *, running):
        filters = json.dumps({"label": ["com.docker.compose.project=" + self.m["project"],
                                        "com.docker.compose.service=" + self.m["service"]]}, separators=(",", ":"))
        rows = self.call("GET", "/containers/json?" + urllib.parse.urlencode({"all": "true", "filters": filters}))
        if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("Id") != expected_id:
            raise Stop("selected service no longer has exactly one reviewed container")
        inspected = self.inspect(expected_id)
        if inspected.get("Id") != expected_id or inspected.get("Name") != "/" + self.m["old_name"]:
            raise Stop("inspected container identity or reviewed name changed")
        if bool(inspected["State"].get("Running")) != running:
            raise Stop("unexpected running state or competing writer")
        if sha(M.resolved_invariants(inspected)) != self.m["resolved_sha256"]:
            raise Stop("resolved configuration changed before lifecycle boundary")
        return inspected

    def preflight(self):
        required = {"old_id", "old_name", "project", "service", "resolved_sha256", "payload_sha256", "daemon_sha256", "volume_name", "volume_sha256", "image_id"}
        if set(self.m) != required or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}", self.m["old_name"]):
            raise Stop("invalid exact lifecycle manifest")
        info = self.call("GET", "/info")
        if daemon_fingerprint(info.get("ID")) != self.m["daemon_sha256"]:
            raise Stop("local daemon identity changed")
        version = self.call("GET", "/version")
        def number(value):
            return tuple(int(part) for part in value.split("."))
        if not number(version["MinAPIVersion"]) <= (1, 53) <= number(version["ApiVersion"]):
            raise Stop("reviewed fixed API version is unsupported")
        self.old = self.sole(self.m["old_id"], running=True)
        if (self.old["Name"] != "/" + self.m["old_name"] or self.old["Image"] != self.m["image_id"]
                or self.old["State"].get("Health", {}).get("Status") != "healthy"):
            raise Stop("old name, image or health changed")
        self.payload = M.pinned_create_payload(self.old)
        if sha(self.payload) != self.m["payload_sha256"]:
            raise Stop("pinned create payload changed")
        self.verify_image_volume()
        self.record("private-inspect-backup", self.old)
        self.record("private-create-payload", self.payload)

    def verify_image_volume(self):
        image = self.call("GET", "/images/" + urllib.parse.quote(self.m["image_id"], safe="") + "/json")
        if image.get("Id") != self.m["image_id"]:
            raise Stop("immutable local image unavailable")
        volume = self.call("GET", "/volumes/" + urllib.parse.quote(self.m["volume_name"], safe=""))
        stable = {key: volume.get(key) for key in ("Name", "Driver", "Mountpoint", "Labels", "Options", "Scope")}
        if sha(stable) != self.m["volume_sha256"]:
            raise Stop("named journal volume changed")
        mount = [row for row in self.old["Mounts"] if row.get("Destination") == "/data"]
        if len(mount) != 1 or mount[0].get("Name") != volume["Name"] or mount[0].get("Source") != volume["Mountpoint"]:
            raise Stop("reviewed journal is not the selected named volume")

    def run(self, *, stopped_snapshot_transition, before_start_verify, after_start_verify):
        self.preflight()
        self.sole(self.m["old_id"], running=True)
        self.record("stop-intent")
        self.call("POST", "/containers/" + self.m["old_id"] + "/stop?t=15", expected=204)
        self.sole(self.m["old_id"], running=False)
        self.record("stop-confirmed")
        # Callback must back up/read back config and journal, compare old snapshot,
        # and refuse any noncooperating writer before one host-file rename.
        stopped_snapshot_transition()
        self.sole(self.m["old_id"], running=False)
        self.verify_image_volume()
        self.record("remove-stopped-container-intent")
        self.call("DELETE", "/containers/" + self.m["old_id"] + "?v=false&force=false&link=false", expected=204)
        self.record("remove-confirmed")
        # Unknown removal/create results are terminal; no repair loop can delete a new owner.
        self.record("create-intent")
        created = self.call("POST", "/containers/create?" + urllib.parse.urlencode({"name": self.m["old_name"]}), self.payload, expected=201)
        if (not isinstance(created, dict) or not re.fullmatch(r"[0-9a-f]{64}", created.get("Id", "")) or created.get("Id") == self.m["old_id"]
                or created.get("Warnings") not in (None, [])):
            raise Stop("created container identity or warnings require reconciliation before start")
        self.new_id = created["Id"]
        self.record("create-confirmed-private-id", {"new_id": self.new_id})
        self.sole(self.new_id, running=False)
        self.verify_image_volume()
        before_start_verify()
        # Recheck immediately before start; a post-start rejection is insufficient.
        self.sole(self.new_id, running=False)
        self.record("start-intent")
        self.call("POST", "/containers/" + self.new_id + "/start", expected=204)
        deadline = self.clock() + 60
        while True:
            current = self.sole(self.new_id, running=True)
            health = current["State"].get("Health", {}).get("Status")
            if health == "healthy":
                break
            if health != "starting" or self.clock() >= deadline:
                raise Stop("finite startup health verification failed; no automatic restart")
            self.pause(1)
        after_start_verify()
        self.record("complete", {"status": "pinned-runtime-verified"})
        return {"status": "pinned-runtime-verified", "volume_deleted": False, "image_pulled": False}
