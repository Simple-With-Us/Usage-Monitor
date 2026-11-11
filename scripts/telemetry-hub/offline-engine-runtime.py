#!/usr/bin/env python3
"""Offline finite HTTP/archive candidate; real mutations are always refused."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import socket
import stat
import sys
import tarfile
import time

SPEC = importlib.util.spec_from_file_location("finite_runtime_model", Path(__file__).with_name("finite-pinned-lifecycle.py"))
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
E, Stop = F.E, F.Stop
WIRE_LIMIT = F.ARCHIVE_LIMIT


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class RuntimeSocket(E.DeadlineSocket):
    """Same deadline/framing protection, with an explicit 2 MiB archive wire cap."""
    def recv_into(self, buffer):
        self.raw.settimeout(self.deadline.remaining())
        count = self.raw.recv_into(memoryview(buffer)[:min(len(buffer), WIRE_LIMIT + 1 - self.wire_bytes)])
        self.deadline.remaining()
        self.wire_bytes += count
        if self.wire_bytes > WIRE_LIMIT:
            raise Stop("runtime response wire budget exceeded")
        return count


class RuntimeConnection(E.UnixConnection):
    def connect(self):
        if self.connect_attempted or self.sock is not None or self.deadline is None:
            raise Stop("runtime reconnect refused")
        self.connect_attempted = True
        info = E.os.lstat(E.SOCKET)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise Stop("runtime socket custody mismatch")
        raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            raw.settimeout(self.deadline.remaining())
            raw.connect(E.SOCKET)
            self.deadline.remaining()
            wrapped = RuntimeSocket(raw, self.deadline)
            if wrapped.peer()[1] != 0:
                raise Stop("runtime peer is not root")
            self.sock = wrapped
        except Exception:
            raw.close()
            raise


class WireProtocol:
    """No default connection exists; only an explicitly injected offline seam runs."""
    def __init__(self, daemon, receipt, *, connection=None, clock=time.monotonic, wire_limit):
        self.daemon, self.receipt, self.connection, self.clock = daemon, receipt, connection, clock
        self.wire_limit, self.wire_calls, self.mutations, self.failed = wire_limit, 0, 0, False
        self.policy = None
        self.deadline = None

    def request(self, method, path, body=None):
        connection = None
        try:
            if self.failed or self.connection is None:
                raise Stop("offline wire candidate has no production connection")
            key, spec = (method, path), self.policy.routes.get((method, path))
            if spec is None:
                raise Stop("unlisted wire route")
            encoded = None if body is None else canonical(body)
            if ((spec[2] is None and encoded is not None) or (spec[2] is not None and hashlib.sha256(encoded or b"").hexdigest() != spec[2])
                    or encoded is not None and len(encoded) > E.MAX_RESPONSE):
                raise Stop("wire body differs from exact reviewed body")
            deadline = E.Deadline(self.clock)
            self.deadline = deadline
            if method != "GET":
                self.receipt("wire-intent-" + str(self.mutations), {"method": method, "path": path,
                             "body_sha256": None if encoded is None else hashlib.sha256(encoded).hexdigest()}, deadline)
                self.mutations += 1
            deadline.remaining()
            connection = self.connection()
            if isinstance(connection, E.http.client.HTTPConnection):
                raise Stop("real HTTP connections are refused by the offline mutation candidate")
            pinned = connection.begin(deadline)

            def exchange(verb, route, data=None, *, archive=False):
                if connection.identity() != pinned or self.wire_calls >= self.wire_limit:
                    raise Stop("pinned connection or total wire-call bound changed")
                deadline.remaining()
                if route == path and (self.policy.routes.get(key) != spec
                        or data != encoded):
                    raise Stop("wire route/body changed immediately before send")
                self.wire_calls += 1
                connection.request(verb, route, body=data, headers={"Accept": "application/x-tar" if archive else "application/json",
                                                                  "Content-Type": "application/json"})
                if connection.identity() != pinned:
                    raise Stop("runtime connection identity changed")
                connection.reset_response_budget()
                response = connection.getresponse()
                raw = bytearray()
                limit = F.ARCHIVE_LIMIT if archive else E.MAX_RESPONSE
                while True:
                    deadline.remaining()
                    chunk = response.read1(min(65536, limit + 1 - len(raw)))
                    deadline.remaining()
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > limit:
                        raise Stop("runtime response body exceeds bound")
                if connection.identity() != pinned:
                    raise Stop("runtime connection changed after response")
                if archive:
                    if response.getheader("Content-Encoding") not in (None, "identity"):
                        raise Stop("compressed archive response refused")
                    value = {"content_type": response.getheader("Content-Type"), "body": bytes(raw)}
                else:
                    value = E.M.C.decode(raw) if raw else None
                return response.status, value, response.will_close

            status, info, closing = exchange("GET", E.PREFIX + "/info")
            if (status != 200 or closing or not isinstance(info, dict) or E.daemon_fingerprint(info.get("ID")) != self.daemon):
                raise Stop("same-connection daemon verification failed")
            if method == "GET" and path == E.PREFIX + "/info":
                return status, info
            status, value, _ = exchange(method, path, encoded, archive=key in self.policy.archive_routes)
            return status, value
        except Exception:
            self.failed = True
            raise Stop("offline runtime wire outcome unavailable; preserve receipts and never retry") from None
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    self.failed = True
                    raise Stop("runtime connection close failed; reconcile without retry") from None


class FiniteMutationTransport:
    """Offline exact-policy/HTTP candidate; no production connection is installed."""
    def __init__(self, plan, *, receipt, connection=None, clock=time.monotonic):
        F.validate_plan(plan)
        self.clock, self.receipt, self.failed = clock, receipt, False
        self.wire = WireProtocol(plan["lifecycle"]["daemon_sha256"], self.private_receipt, connection=connection, clock=clock,
                                 wire_limit=2 * (30 + 2 * plan["limits"]["health_checks"]) - 1)
        self.policy = F.ExactEngine(plan["lifecycle"], self.wire, plan["limits"]["health_checks"],
                                    receipt=lambda phase, data: self.private_receipt("wire-" + phase, data, self.wire.deadline),
                                    check=lambda: None)
        self.wire.policy = self.policy

    def private_receipt(self, phase, data, budget):
        budget.remaining()
        writer = getattr(self.receipt, "write", None)
        ack = writer(phase, copy.deepcopy(data), budget) if writer else self.receipt(phase, copy.deepcopy(data))
        budget.remaining()
        if (not isinstance(ack, dict) or set(ack) != {"sha256", "durable_readback"}
                or ack["sha256"] != E.sha(data) or ack["durable_readback"] is not True):
            raise Stop("durable wire receipt readback required")

    def request(self, method, path, body=None):
        try:
            if self.failed:
                raise Stop("runtime transport is terminal")
            if method != "GET":
                self.policy.release_next()
            return self.policy.request(method, path, body)
        except Exception:
            self.failed = True
            raise Stop("offline finite runtime transport stopped; reconcile without retry") from None

    def close(self):
        self.failed = self.policy.failed = self.wire.failed = True


class RealMutationRoute:
    """There is no live mutation release flag, callback or connection fallback."""
    def request(self, method, path, body=None):
        raise Stop("live runtime route is unconditionally disabled")


def snapshot_archive(raw):
    """Read one bounded regular member in memory; never extract a filesystem path."""
    try:
        if not isinstance(raw, bytes) or not 1024 <= len(raw) <= F.ARCHIVE_LIMIT or len(raw) % 512:
            raise Stop("invalid bounded archive shape")
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            member = archive.next()
            if (member is None or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or member.name != "telemetry-hub.json" or member.linkname or member.issparse()
                    or (member.uid, member.gid, member.mode) != (10001, 10001, 0o600)
                    or not 0 < member.size <= E.MAX_RESPONSE or member.offset_data > 4096
                    or set(member.pax_headers) - {"mtime", "atime", "ctime"}
                    or any(not re.fullmatch(r"[0-9]{1,20}(?:\.[0-9]{1,20})?", value) for value in member.pax_headers.values())):
                raise Stop("unreviewed archive member or custody")
            cursor, extended = 0, False
            while cursor < member.offset_data:
                header = tarfile.TarInfo.frombuf(raw[cursor:cursor + 512], "utf-8", "strict")
                if header.type == tarfile.XHDTYPE and not extended and cursor == 0 and 0 < header.size <= 2048:
                    extended = True
                    cursor += 512 + ((header.size + 511) // 512) * 512
                elif header.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and cursor + 512 == member.offset_data:
                    cursor += 512
                else:
                    raise Stop("unreviewed tar prefix record")
            source = archive.extractfile(member)
            if source is None:
                raise Stop("missing regular archive member")
            with source:
                body = source.read(member.size + 1)
            end = ((member.offset_data + member.size + 511) // 512) * 512
            if (len(body) != member.size or len(raw) < end + 1024 or any(raw[end:]) or archive.next() is not None):
                raise Stop("extra, truncated or trailing archive content")
            result = body.decode("utf-8")
            E.M.snapshot(result)
            return result
    except Exception:
        raise Stop("bounded snapshot archive rejected; no content exposed") from None


class SnapshotArchiveReader:
    """Exactly one stopped and one healthy read from the registered replacement ID."""
    def __init__(self, plan):
        F.validate_plan(plan)
        self.plan, self.engine, self.calls, self.failed, self.identifier = copy.deepcopy(plan), None, 0, False, None

    def bind_engine(self, engine, manifest):
        if self.engine is not None or manifest != self.plan["lifecycle"]:
            raise Stop("snapshot reader binding differs from reviewed lifecycle")
        self.engine = engine

    def inspect(self, identifier, running, budget):
        budget.remaining()
        status, item = self.engine.request("GET", E.PREFIX + "/containers/" + identifier + "/json")
        budget.remaining()
        m = self.plan["lifecycle"]
        if (status != 200 or not isinstance(item, dict) or item.get("Id") != identifier or item.get("Name") != "/" + m["old_name"]
                or item.get("Image") != m["image_id"] or item.get("State", {}).get("Running") is not running
                or running and item.get("State", {}).get("Health", {}).get("Status") != "healthy"
                or E.sha(E.M.resolved_invariants(item)) != m["resolved_sha256"]):
            raise Stop("snapshot reader inspect identity/state/config changed")

    def read(self, container_id, *, running, budget):
        try:
            budget.remaining()
            if (self.failed or self.engine is None or self.calls >= 2 or type(running) is not bool or running != (self.calls == 1)
                    or not isinstance(container_id, str) or not re.fullmatch(r"[0-9a-f]{64}", container_id)
                    or container_id == self.plan["lifecycle"]["old_id"]
                    or self.identifier is not None and self.identifier != container_id):
                raise Stop("snapshot read phase or full replacement ID refused")
            self.calls += 1
            self.identifier = container_id
            self.inspect(container_id, running, budget)
            budget.remaining()
            status, value = self.engine.request("GET", E.PREFIX + "/containers/" + container_id + F.ARCHIVE_QUERY)
            budget.remaining()
            if (status != 200 or not isinstance(value, dict) or set(value) != {"content_type", "body"}
                    or value["content_type"] != "application/x-tar"):
                raise Stop("snapshot archive response refused")
            raw = snapshot_archive(value["body"])
            if E.M.C.digest(raw) != self.plan["snapshot"]["new_sha256"]:
                raise Stop("actual archive snapshot digest differs")
            budget.remaining()
            self.inspect(container_id, running, budget)
            budget.remaining()
            return raw
        except Exception:
            self.failed = True
            raise Stop("snapshot archive read failed; no retry or content exposure") from None

    def close(self):
        self.failed = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.execute:
        print(json.dumps({"status": "stopped", "reason": "live runtime execution is unconditionally disabled"}), file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps({"mode": "offline_candidate", "engine_calls": 0, "filesystem_calls": 0, "live_execution_enabled": False}))


if __name__ == "__main__":
    main()
