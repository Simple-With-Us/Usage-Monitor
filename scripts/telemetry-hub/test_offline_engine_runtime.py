"""Fake-wire and synthetic-tar tests only; no live socket or resource is used."""
import contextlib
import copy
import gzip
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


R = module("runtime_candidate", "offline-engine-runtime.py")
T = module("runtime_finite_fixtures", "test_finite_pinned_lifecycle.py")
H = module("runtime_host_fixtures", "test_host_proof_adapter.py")
P = module("runtime_socket_fixtures", "test_pinned_engine_transport.py")


def archive(raw, *, name="telemetry-hub.json", uid=10001, mode=0o600, kind=tarfile.REGTYPE, extra=False, pax=None, format=tarfile.USTAR_FORMAT):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:", format=format) as tar:
        info = tarfile.TarInfo(name)
        info.uid = info.gid = uid
        info.mode, info.type, info.size = mode, kind, len(raw.encode())
        info.pax_headers = pax or {}
        tar.addfile(info, io.BytesIO(raw.encode()))
        if extra:
            tar.addfile(tarfile.TarInfo("extra"), io.BytesIO())
    return output.getvalue()


class Response:
    def __init__(self, status, value, *, binary=False, closing=False):
        self.status, self.will_close = status, closing
        self.raw = value if binary else (b"" if value is None else json.dumps(value).encode())
        self.content_type = "application/x-tar" if binary else "application/json"

    def read1(self, maximum):
        result, self.raw = self.raw[:maximum], self.raw[maximum:]
        return result

    def getheader(self, name):
        return self.content_type if name == "Content-Type" else None


class Wire:
    def __init__(self, engine, snapshot):
        self.engine, self.snapshot = engine, snapshot
        self.calls, self.connections = [], []
        self.bad_daemon = False
        self.fail_mutation = None
        self.mutations = 0
        self.closed_info = False
        self.changed_identity = False
        self.archive_change = lambda value: value

    def connection(self):
        wire = self
        class Connection:
            def __init__(self):
                self.closed = False
                self.response = None
                self.pinned = (id(self), 90, (111, 0, 0))

            def begin(self, deadline):
                self.deadline = deadline
                return self.pinned

            def identity(self):
                return ("changed", 91, (111, 0, 0)) if wire.changed_identity and self.response is not None else self.pinned

            def request(self, method, path, body=None, **kwargs):
                wire.calls.append((method, path, body))
                if method != "GET":
                    wire.mutations += 1
                    if wire.fail_mutation == wire.mutations:
                        raise TimeoutError("synthetic lost mutation response")
                if path.endswith(R.F.ARCHIVE_QUERY):
                    raw = wire.archive_change(archive(wire.snapshot))
                    self.response = Response(200, raw, binary=True)
                else:
                    value = None if body is None else json.loads(body)
                    status, result = wire.engine.request(method, path, value)
                    if path == R.E.PREFIX + "/info" and wire.bad_daemon:
                        result = {"ID": "wrong-daemon"}
                    self.response = Response(status, result, closing=path == R.E.PREFIX + "/info" and wire.closed_info)

            def reset_response_budget(self):
                pass

            def getresponse(self):
                return self.response

            def close(self):
                self.closed = True
        result = Connection()
        self.connections.append(result)
        return result


class RuntimeTests(unittest.TestCase):
    def candidate(self):
        plan, engine, old, new = T.fixture()
        receipts = T.Receipts()
        wire = Wire(engine, new)
        transport = R.FiniteMutationTransport(plan, receipt=receipts, connection=wire.connection, clock=lambda: engine.time)
        return plan, engine, wire, receipts, transport

    def test_archive_accepts_only_the_exact_regular_snapshot_without_extraction(self):
        _, _, _, new = T.fixture()
        with patch.object(tarfile.TarFile, "extract", side_effect=AssertionError("filesystem extraction forbidden")), \
                patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError("filesystem extraction forbidden")):
            self.assertEqual(R.snapshot_archive(archive(new)), new)
            self.assertEqual(R.snapshot_archive(archive(new, format=tarfile.PAX_FORMAT, pax={"mtime": "1.25"})), new)

    def test_archive_rejects_paths_links_devices_wrong_custody_and_extra_data(self):
        _, _, _, new = T.fixture()
        cases = [archive(new, name=name) for name in ("../telemetry-hub.json", "/telemetry-hub.json", "other.json", "./telemetry-hub.json")]
        cases += [archive(new, kind=kind) for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.GNUTYPE_SPARSE)]
        cases += [archive(new, uid=0), archive(new, mode=0o644), archive(new, extra=True), gzip.compress(archive(new)),
                  archive(new, format=tarfile.PAX_FORMAT, pax={"path": "telemetry-hub.json"}),
                  archive(new)[:((512 + len(new.encode()) + 511) // 512) * 512 + 512], archive(new) + b"x" * 512]
        for index, raw in enumerate(cases):
            with self.subTest(case=index), self.assertRaises(R.Stop):
                R.snapshot_archive(raw)

    def test_default_transport_and_real_route_have_no_live_mutation_path(self):
        plan, _, _, _ = T.fixture()
        with patch.object(R, "RuntimeConnection") as connection:
            default = R.FiniteMutationTransport(plan, receipt=T.Receipts())
            with self.assertRaises(R.Stop):
                default.request("POST", R.E.PREFIX + "/containers/" + plan["lifecycle"]["old_id"] + "/stop?t=15")
            for method in ("GET", "POST", "DELETE", "PUT", "PATCH"):
                with self.assertRaises(R.Stop):
                    R.RealMutationRoute().request(method, R.E.PREFIX + "/info")
            connection.assert_not_called()
        with patch.object(R.socket, "socket") as socket:
            candidate = R.FiniteMutationTransport(plan, receipt=T.Receipts(), connection=R.RuntimeConnection)
            with self.assertRaises(R.Stop):
                candidate.request("POST", R.E.PREFIX + "/containers/" + plan["lifecycle"]["old_id"] + "/stop?t=15")
            socket.assert_not_called()

    def test_finite_wire_mutation_probes_daemon_on_same_connection_and_records_intent(self):
        plan, engine, wire, receipts, transport = self.candidate()
        route = R.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15"
        self.assertEqual(transport.request("POST", route), (204, None))
        self.assertEqual([(method, path) for method, path, _ in wire.calls], [("GET", R.E.PREFIX + "/info"), ("POST", route)])
        self.assertEqual(len(wire.connections), 1)
        self.assertTrue(wire.connections[0].closed)
        self.assertIn("wire-intent-0", receipts.values)
        self.assertIn("wire-mutation-response-0", receipts.values)

    def test_bad_daemon_closed_info_or_changed_socket_prevents_mutation(self):
        for fault in ("bad_daemon", "closed_info", "changed_identity"):
            plan, engine, wire, _, transport = self.candidate()
            setattr(wire, fault, True)
            with self.assertRaises(R.Stop):
                transport.request("POST", R.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15")
            self.assertEqual(wire.mutations, 0)
            self.assertEqual(len(wire.connections), 1)

    def test_lost_mutation_reply_is_terminal_without_reconnect_or_retry(self):
        _, engine, wire, receipts, transport = self.candidate()
        wire.fail_mutation = 1
        route = R.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15"
        with self.assertRaises(R.Stop):
            transport.request("POST", route)
        with self.assertRaises(R.Stop):
            transport.request("POST", route)
        self.assertEqual(wire.mutations, 1)
        self.assertEqual(len(wire.connections), 1)
        self.assertIn("wire-intent-0", receipts.values)

    def test_unlisted_route_and_wrong_mutation_order_never_construct_connection(self):
        for method, route in (("DELETE", "/volumes/existing-journal?force=false"),
                              ("POST", "/containers/" + "b" * 64 + "/start"),
                              ("GET", "/containers/" + "a" * 64 + "/archive?path=/etc/passwd")):
            _, _, wire, _, transport = self.candidate()
            with self.assertRaises(R.Stop):
                transport.request(method, R.E.PREFIX + route)
            self.assertEqual(wire.connections, [])

    def test_wire_deadline_includes_intent_and_response_receipt(self):
        for slow_phase, expected_connections, expected_mutations in (("wire-intent-0", 0, 0), ("wire-mutation-response-0", 1, 1)):
            plan, engine, _, new = T.fixture()
            original = T.Receipts()
            def receipt(phase, data):
                ack = original(phase, data)
                if phase == slow_phase:
                    engine.time += 15
                return ack
            wire = Wire(engine, new)
            transport = R.FiniteMutationTransport(plan, receipt=receipt, connection=wire.connection, clock=lambda: engine.time)
            with self.assertRaises(R.Stop):
                transport.request("POST", R.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15")
            self.assertEqual(len(wire.connections), expected_connections)
            self.assertEqual(wire.mutations, expected_mutations)

    def test_total_wire_budget_refuses_target_after_one_daemon_probe(self):
        _, _, wire, _, transport = self.candidate()
        transport.wire.wire_limit = 1
        with self.assertRaises(R.Stop):
            transport.request("GET", R.E.PREFIX + "/version")
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][1], R.E.PREFIX + "/info")
        self.assertTrue(wire.connections[0].closed)

    def test_runtime_socket_counts_headers_and_chunk_framing_and_rejects_nonroot_peer(self):
        cases = [b"HTTP/1.1 200 OK\r\nX-Fill: " + b"a" * 300 + b"\r\nContent-Length: 2\r\n\r\n{}",
                 b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + b"1\r\nx\r\n" * 50 + b"0\r\n\r\n"]
        for raw in cases:
            clock = P.Clock()
            with patch.object(R, "WIRE_LIMIT", 256), self.assertRaises(R.Stop):
                response = http.client.HTTPResponse(R.RuntimeSocket(P.RawSocket(raw), R.E.Deadline(clock)))
                response.begin()
                while response.read1(65536):
                    pass
        raw = P.RawSocket(uid=10001)
        with patch.object(R.E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), \
                patch.object(R.socket, "socket", return_value=raw):
            with self.assertRaises(R.Stop):
                R.RuntimeConnection().begin(R.E.Deadline(P.Clock()))
        self.assertTrue(raw.closed)

    def test_snapshot_reader_rechecks_state_after_archive(self):
        plan, engine, _, new = T.fixture()
        reader = R.SnapshotArchiveReader(plan)
        inspected = copy.deepcopy(engine.old)
        inspected["Id"], inspected["State"]["Running"] = engine.new_id, False
        changed = copy.deepcopy(inspected)
        changed["State"]["Running"] = True
        gate = Mock()
        gate.request.side_effect = [(200, inspected), (200, {"content_type": "application/x-tar", "body": archive(new)}), (200, changed)]
        reader.bind_engine(gate, plan["lifecycle"])
        with self.assertRaises(R.Stop):
            reader.read(engine.new_id, running=False, budget=R.E.Deadline(lambda: 0))
        self.assertEqual(gate.request.call_count, 3)
        with self.assertRaises(R.Stop):
            reader.read(engine.new_id, running=False, budget=R.E.Deadline(lambda: 0))
        self.assertEqual(gate.request.call_count, 3)

    def test_snapshot_parsing_deadline_prevents_postread_inspect(self):
        plan, engine, _, new = T.fixture()
        reader, clock = R.SnapshotArchiveReader(plan), P.Clock()
        inspected = copy.deepcopy(engine.old)
        inspected["Id"], inspected["State"]["Running"] = engine.new_id, False
        gate = Mock()
        gate.request.side_effect = [(200, inspected), (200, {"content_type": "application/x-tar", "body": archive(new)})]
        reader.bind_engine(gate, plan["lifecycle"])
        original = R.snapshot_archive
        def parse(raw):
            result = original(raw)
            clock.now += 15
            return result
        with patch.object(R, "snapshot_archive", side_effect=parse), self.assertRaises(R.Stop):
            reader.read(engine.new_id, running=False, budget=R.E.Deadline(clock))
        self.assertEqual(gate.request.call_count, 2)

    def test_full_host_flow_uses_registered_snapshot_reader_and_shared_request_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            files = H.Files(directory)
            try:
                wire = Wire(files.engine, files.new)
                transport = R.FiniteMutationTransport(files.plan, receipt=files.sink, connection=wire.connection, clock=lambda: files.engine.time)
                files.adapter.reader = R.SnapshotArchiveReader(files.plan)
                class FixtureLifecycle(R.F.FiniteLifecycle):
                    def identity(self, value, raw):
                        if (value["uid"], value["gid"]) != (os.getuid(), os.getgid()):
                            raise R.Stop("synthetic owner differs")
                        super().identity(dict(value, uid=10001, gid=10001), raw)
                candidate = FixtureLifecycle(files.plan, transport, proofs=files.adapter, receipt=files.sink,
                                              clock=lambda: files.engine.time, pause=lambda seconds: None)
                result = candidate.run()
                self.assertEqual(result["logical_engine_requests"], 32)
                self.assertEqual(result["logical_engine_request_limit"], 36)
                self.assertEqual(transport.wire.wire_calls, 63)
                self.assertEqual(len(wire.calls), 63)
                self.assertTrue(all(connection.closed for connection in wire.connections))
                self.assertTrue(transport.failed)
                self.assertEqual(files.snapshot.read_text(), files.new)
                archives = [route for method, route, _ in wire.calls if route.endswith(R.F.ARCHIVE_QUERY)]
                self.assertEqual(len(archives), 2)
                self.assertTrue(all(files.engine.new_id in route for route in archives))
            finally:
                files.close()

    def test_reader_wrong_state_id_and_digest_stop_without_retry(self):
        plan, engine, _, new = T.fixture()
        reader = R.SnapshotArchiveReader(plan)
        gate = Mock()
        reader.bind_engine(gate, plan["lifecycle"])
        for identifier, running in ((engine.old_id, False), (engine.new_id, True)):
            with self.assertRaises(R.Stop):
                reader.read(identifier, running=running, budget=R.E.Deadline(lambda: 0))
            gate.request.assert_not_called()
            reader = R.SnapshotArchiveReader(plan)
            reader.bind_engine(gate, plan["lifecycle"])
        engine.old["State"]["Running"] = False
        inspected = copy.deepcopy(engine.old)
        inspected["Id"] = engine.new_id
        changed = json.loads(new)
        changed["SENTRY_PUBLIC_KEY"] = "other-synthetic-key"
        gate.request.side_effect = [(200, inspected), (200, {"content_type": "application/x-tar", "body": archive(json.dumps(changed, separators=(",", ":")))})]
        with self.assertRaises(R.Stop):
            reader.read(engine.new_id, running=False, budget=R.E.Deadline(lambda: 0))
        self.assertEqual(gate.request.call_count, 2)

    def test_runtime_cli_never_constructs_a_connection(self):
        for execute in (False, True):
            with patch.object(R.sys, "argv", ["offline-engine-runtime.py"] + (["--execute"] if execute else [])), \
                    patch.object(R, "RuntimeConnection") as connection, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if execute:
                    with self.assertRaises(SystemExit):
                        R.main()
                else:
                    R.main()
                connection.assert_not_called()


if __name__ == "__main__":
    unittest.main()
