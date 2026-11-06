"""Offline fake-socket coverage; no real Engine socket or Docker operation runs."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import stat
import struct
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("transport_candidate", Path(__file__).with_name("pinned-engine-lifecycle.py"))
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)
DAEMON_ID = "synthetic-daemon"
DAEMON_SHA = hashlib.sha256(DAEMON_ID.encode("utf-8")).hexdigest()


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class Response:
    def __init__(self, value, *, status=200, closing=False, clock=None, tick=0):
        self.raw = json.dumps(value).encode()
        self.status, self.will_close = status, closing
        self.clock, self.tick = clock, tick

    def read1(self, count):
        if self.clock is not None:
            self.clock.now += self.tick
        chunk, self.raw = self.raw[:count], self.raw[count:]
        return chunk

    def close(self):
        self.raw = b""
        self.closed = True


class Connection:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.closed = False
        self.identity_calls = 0
        self.change_at = None
        self.deadline = None

    def begin(self, deadline):
        self.deadline = deadline
        return self.identity()

    def identity(self):
        self.identity_calls += 1
        changed = self.change_at is not None and self.identity_calls >= self.change_at
        return ("changed" if changed else "same", 90, (111, 0, 0))

    def request(self, method, path, **kwargs):
        self.requests.append((method, path))

    def reset_response_budget(self):
        pass

    def getresponse(self):
        return self.responses.pop(0)

    def close(self):
        self.closed = True


class RawSocket:
    def __init__(self, raw=b"", *, clock=None, tick=0, chunk=8192, uid=0):
        self.raw = raw
        self.clock, self.tick, self.chunk = clock, tick, chunk
        self.uid = uid
        self.closed = False
        self.timeouts = []
        self.sent = []
        self.connect_tick = self.send_tick = 0

    def settimeout(self, remaining):
        self.timeouts.append(remaining)

    def connect(self, path):
        if self.clock:
            self.clock.now += self.connect_tick

    def recv_into(self, buffer):
        if self.clock:
            self.clock.now += self.tick
        count = min(len(buffer), len(self.raw), self.chunk)
        buffer[:count], self.raw = self.raw[:count], self.raw[count:]
        return count

    def sendall(self, raw):
        self.sent.append(raw)
        if self.clock:
            self.clock.now += self.send_tick

    def getsockopt(self, *args):
        return struct.pack("3i", 111, self.uid, 0)

    def fileno(self):
        return -1 if self.closed else 90

    def close(self):
        self.closed = True


class WireSocket(RawSocket):
    def __init__(self, responses):
        super().__init__()
        self.responses = list(responses)

    def sendall(self, raw):
        super().sendall(raw)
        if self.raw:
            raise AssertionError("previous HTTP response was not consumed")
        self.raw = self.responses.pop(0)


class PipelinedSocket(RawSocket):
    """Both responses delivered up front: worst-case prefetch exposure."""
    def __init__(self, blob):
        super().__init__()
        self.raw = blob
        self.chunk = len(blob)


class TransportTests(unittest.TestCase):
    def engine(self, connection, clock=None):
        factory = Mock(return_value=connection)
        return E.ReadOnlyEngine(expected_daemon=DAEMON_SHA, connection=factory, clock=clock or Clock()), factory

    def test_daemon_fingerprint_uses_raw_utf8_and_rejects_missing_identity(self):
        for identity in (DAEMON_ID, "synthetic-\u03bb"):
            self.assertEqual(E.daemon_fingerprint(identity), hashlib.sha256(identity.encode("utf-8")).hexdigest())
            self.assertNotEqual(E.daemon_fingerprint(identity), E.sha(identity))
        for identity in (None, "", 1, False):
            with self.assertRaises(E.Stop):
                E.daemon_fingerprint(identity)

    def test_mutations_and_unreviewed_daemon_never_construct_connection(self):
        factory = Mock(side_effect=AssertionError("socket must not be accessed"))
        engine = E.ReadOnlyEngine(expected_daemon=DAEMON_SHA, connection=factory)
        for method in ("POST", "DELETE", "PUT", "PATCH", "HEAD"):
            with self.assertRaisesRegex(E.Stop, "disabled"):
                engine.request(method, E.PREFIX + "/containers/create", {})
        with self.assertRaisesRegex(E.Stop, "disabled"):
            engine.request("GET", E.PREFIX + "/info", {})
        for fingerprint in (None, "", "x" * 64, "A" * 64):
            with self.assertRaisesRegex(E.Stop, "fingerprint"):
                E.ReadOnlyEngine(expected_daemon=fingerprint, connection=factory).request("GET", E.PREFIX + "/info")
        factory.assert_not_called()

    def test_daemon_probe_and_selected_read_share_one_connection_and_deadline(self):
        clock = Clock()
        connection = Connection([Response({"ID": DAEMON_ID}, clock=clock, tick=1), Response({"ApiVersion": "1.55"}, clock=clock, tick=1)])
        engine, factory = self.engine(connection, clock)
        self.assertEqual(engine.request("GET", E.PREFIX + "/version"), (200, {"ApiVersion": "1.55"}))
        self.assertEqual(connection.requests, [("GET", E.PREFIX + "/info"), ("GET", E.PREFIX + "/version")])
        factory.assert_called_once_with()
        self.assertEqual(connection.deadline.end, E.REQUEST_SECONDS)
        self.assertEqual(clock.now, 4)
        self.assertTrue(connection.closed)

    def test_info_read_returns_its_verified_probe_without_second_request(self):
        connection = Connection([Response({"ID": DAEMON_ID})])
        engine, _ = self.engine(connection)
        self.assertEqual(engine.request("GET", E.PREFIX + "/info"), (200, {"ID": DAEMON_ID}))
        self.assertEqual(len(connection.requests), 1)

    def test_bad_or_closing_daemon_response_never_sends_selected_read(self):
        for response in (Response({"ID": "wrong-daemon"}), Response({}), Response({"ID": DAEMON_ID}, status=500),
                         Response({"ID": DAEMON_ID}, closing=True)):
            connection = Connection([response])
            engine, _ = self.engine(connection)
            with self.assertRaisesRegex(E.Stop, "no raw response") as stopped:
                engine.request("GET", E.PREFIX + "/version")
            self.assertNotIn("wrong-daemon", str(stopped.exception))
            self.assertEqual(len(connection.requests), 1)
            self.assertTrue(connection.closed)

    def test_identity_change_at_every_exchange_boundary_stops_without_reconnect(self):
        for change_at in range(2, 8):
            with self.subTest(boundary=change_at):
                connection = Connection([Response({"ID": DAEMON_ID}), Response({"ok": True})])
                connection.change_at = change_at
                engine, factory = self.engine(connection)
                with self.assertRaisesRegex(E.Stop, "no raw response"):
                    engine.request("GET", E.PREFIX + "/version")
                factory.assert_called_once_with()
                self.assertLessEqual(len(connection.requests), 2)
                self.assertTrue(connection.closed)

    def test_absolute_deadline_is_not_reset_between_daemon_and_target(self):
        clock = Clock()
        connection = Connection([Response({"ID": DAEMON_ID}, clock=clock, tick=4), Response({"ok": True}, clock=clock, tick=4)])
        engine, factory = self.engine(connection, clock)
        with self.assertRaisesRegex(E.Stop, "no raw response"):
            engine.request("GET", E.PREFIX + "/version")
        self.assertEqual(clock.now, 16)
        self.assertTrue(connection.closed)
        factory.assert_called_once_with()

    def test_oversized_decoded_body_stops_without_retry(self):
        connection = Connection([Response({"ID": DAEMON_ID}), Response({"large": "x" * E.MAX_RESPONSE})])
        engine, factory = self.engine(connection)
        with self.assertRaisesRegex(E.Stop, "no raw response"):
            engine.request("GET", E.PREFIX + "/version")
        factory.assert_called_once_with()
        self.assertTrue(connection.closed)

    def read_http(self, raw, *, clock=None, tick=0, chunk=8192):
        clock = clock or Clock()
        sock = RawSocket(raw, clock=clock, tick=tick, chunk=chunk)
        wrapped = E.DeadlineSocket(sock, E.Deadline(clock))
        response = http.client.HTTPResponse(wrapped)
        response.begin()
        while response.read1(65536):
            pass
        return sock, wrapped

    def test_wire_budget_counts_headers_and_chunk_framing(self):
        oversized_headers = b"HTTP/1.1 200 OK\r\nX-Fill: " + b"a" * 300 + b"\r\nContent-Length: 2\r\n\r\n{}"
        oversized_framing = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + b"1\r\nx\r\n" * 50 + b"0\r\n\r\n"
        with patch.object(E, "MAX_RESPONSE", 256):
            for raw in (oversized_headers, oversized_framing):
                with self.assertRaisesRegex(E.Stop, "wire response"):
                    self.read_http(raw)

    def test_slow_drip_headers_exhaust_absolute_deadline(self):
        raw = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
        clock = Clock()
        with self.assertRaisesRegex(E.Stop, "absolute Engine deadline"):
            self.read_http(raw, clock=clock, tick=1, chunk=1)
        self.assertEqual(clock.now, E.REQUEST_SECONDS)

    def test_socket_send_and_connect_share_absolute_deadline(self):
        clock, raw = Clock(), RawSocket()
        raw.clock, raw.send_tick = clock, E.REQUEST_SECONDS
        with self.assertRaisesRegex(E.Stop, "absolute Engine deadline"):
            E.DeadlineSocket(raw, E.Deadline(clock)).sendall(b"GET /info")
        clock = Clock()
        raw = RawSocket(clock=clock)
        raw.connect_tick = E.REQUEST_SECONDS
        with patch.object(E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), patch.object(E.socket, "socket", return_value=raw):
            with self.assertRaisesRegex(E.Stop, "absolute Engine deadline"):
                E.UnixConnection().begin(E.Deadline(clock))
        self.assertTrue(raw.closed)

    def test_root_socket_peer_and_reconnect_checks(self):
        for mode, uid in ((stat.S_IFLNK, 0), (stat.S_IFSOCK, 10001)):
            with patch.object(E.os, "lstat", return_value=Mock(st_mode=mode, st_uid=uid)), patch.object(E.socket, "socket") as factory:
                with self.assertRaisesRegex(E.Stop, "custody"):
                    E.UnixConnection().begin(E.Deadline(Clock()))
                factory.assert_not_called()
        raw = RawSocket(uid=10001)
        with patch.object(E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), patch.object(E.socket, "socket", return_value=raw):
            with self.assertRaisesRegex(E.Stop, "peer is not root"):
                E.UnixConnection().begin(E.Deadline(Clock()))
        self.assertTrue(raw.closed)
        raw = RawSocket()
        with patch.object(E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), patch.object(E.socket, "socket", return_value=raw) as factory:
            connection = E.UnixConnection()
            self.assertEqual(connection.begin(E.Deadline(Clock()))[2], (111, 0, 0))
            with self.assertRaisesRegex(E.Stop, "reconnect"):
                connection.connect()
            with self.assertRaisesRegex(E.Stop, "reconnect"):
                connection.begin(E.Deadline(Clock()))
            factory.assert_called_once_with(E.socket.AF_UNIX, E.socket.SOCK_STREAM)
            connection.close()

    def test_pipelined_second_response_survives_response_close(self):
        def wire(value):
            body = json.dumps(value).encode()
            return (b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode()
                    + b"\r\n\r\n" + body)
        def wire_chunked(value):
            body = json.dumps(value).encode()
            return (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                    + ("%x\r\n" % len(body)).encode() + body + b"\r\n0\r\n\r\n")
        for first, second in ((wire({"ID": DAEMON_ID}), wire({"ApiVersion": "1.55"})),
                              (wire_chunked({"ID": DAEMON_ID}), wire_chunked({"ApiVersion": "1.55"})),
                              (wire({"ID": DAEMON_ID}), wire_chunked({"ApiVersion": "1.55"}))):
            raw = PipelinedSocket(first + second)
            with patch.object(E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), \
                    patch.object(E.socket, "socket", return_value=raw):
                engine = E.ReadOnlyEngine(expected_daemon=DAEMON_SHA, clock=Clock())
                self.assertEqual(engine.request("GET", E.PREFIX + "/version"), (200, {"ApiVersion": "1.55"}))
                self.assertEqual(len(raw.sent), 2)
                self.assertTrue(raw.closed)

    def test_real_http_parser_sends_daemon_and_target_on_one_fake_socket(self):
        def wire(value, closing=False):
            body = json.dumps(value).encode()
            return (b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode()
                    + (b"\r\nConnection: close" if closing else b"") + b"\r\n\r\n" + body)
        for closing in (False, True):
            raw = WireSocket([wire({"ID": DAEMON_ID}, closing), wire({"ApiVersion": "1.55"})])
            with patch.object(E.os, "lstat", return_value=Mock(st_mode=stat.S_IFSOCK, st_uid=0)), \
                    patch.object(E.socket, "socket", return_value=raw) as factory:
                engine = E.ReadOnlyEngine(expected_daemon=DAEMON_SHA, clock=Clock())
                if closing:
                    with self.assertRaisesRegex(E.Stop, "no raw response"):
                        engine.request("GET", E.PREFIX + "/version")
                    self.assertEqual(len(raw.sent), 1)
                else:
                    self.assertEqual(engine.request("GET", E.PREFIX + "/version"), (200, {"ApiVersion": "1.55"}))
                    self.assertEqual(len(raw.sent), 2)
                    self.assertTrue(raw.sent[0].startswith(b"GET /v1.53/info HTTP/1.1\r\n"))
                    self.assertTrue(raw.sent[1].startswith(b"GET /v1.53/version HTTP/1.1\r\n"))
                factory.assert_called_once_with(E.socket.AF_UNIX, E.socket.SOCK_STREAM)
                self.assertTrue(raw.closed)


if __name__ == "__main__":
    unittest.main()
