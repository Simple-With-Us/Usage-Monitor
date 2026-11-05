"""Synthetic offline Engine only; never open Docker sockets or invoke Docker CLI."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import struct
import sys
import unittest
import urllib.parse
import uuid
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("probe-engine-representation.py"))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
DAEMON = hashlib.sha256(b"synthetic-daemon").hexdigest()


class MemoryEvidence:
    def __init__(self):
        self.opened = self.cleaned = False
        self.files = {}
        self.fail_name = None

    def open(self):
        self.opened = True
        self.write("config.json", {"fixture": "synthetic"})

    def write(self, name, value):
        if name == self.fail_name:
            raise P.Stop("synthetic evidence failure")
        if name in self.files:
            raise AssertionError("evidence overwritten")
        self.files[name] = copy.deepcopy(value)

    def check(self):
        if not self.opened:
            raise AssertionError("evidence not opened")

    def cleanup(self):
        self.cleaned = True


class FakeEngine:
    def __init__(self):
        self.containers, self.volume_data = {}, None
        self.ids, self.bodies, self.calls, self.mutations = set(), {}, [], []
        self.fail = None
        self.land_unknown = False
        self.warnings = []
        self.created_change = lambda item, index: None
        self.collision = False
        self.tmpfs_in_mounts = False
        self.cleanup_change = lambda item: None
        self.daemon_change_after = None

    def permit_body(self, name, body):
        self.bodies[name] = copy.deepcopy(body)

    def permit_container(self, identifier):
        self.ids.add(identifier)

    def request(self, method, path, body=None):
        if method != "GET":
            self.calls.append(("GET", "/info"))
            _, info = self.route("GET", "/info", None)
            if hashlib.sha256(info["ID"].encode()).hexdigest() != DAEMON:
                raise P.Stop("same-connection daemon mismatch")
        self.calls.append((method, path))
        mutation = method != "GET"
        if mutation:
            self.mutations.append((method, path))
            if self.fail == len(self.mutations) and not self.land_unknown:
                raise TimeoutError("synthetic unconfirmed operation")
        result = self.route(method, path, body)
        if mutation and self.fail == len(self.mutations) and self.land_unknown:
            raise TimeoutError("synthetic landed operation with lost response")
        return result

    def route(self, method, path, body):
        if path == "/info":
            changed = self.daemon_change_after is not None and len(self.mutations) >= self.daemon_change_after
            return 200, {"ID": "different-daemon" if changed else "synthetic-daemon"}
        if path == "/version":
            return 200, {"MinAPIVersion": "1.40", "ApiVersion": "1.55"}
        if path.startswith("/images/"):
            return 200, {"Id": P.IMAGE_ID, "RepoDigests": [P.IMAGE_REFERENCE],
                         "Config": {"Env": [name + "=public-fixture-default" for name in ("PATH", "LANG", "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256")]}}
        if path == "/volumes/create":
            self.volume_data = {"Name": body["Name"], "Driver": body["Driver"],
                                "Labels": copy.deepcopy(body["Labels"]), "Options": copy.deepcopy(body["DriverOpts"]),
                                "Mountpoint": "/synthetic/volume/" + P.VOLUME}
            return 201, copy.deepcopy(self.volume_data)
        if path == "/volumes/" + P.VOLUME:
            return (200, copy.deepcopy(self.volume_data)) if self.volume_data else (404, None)
        if path == "/volumes/" + P.VOLUME + "?force=false":
            if self.containers:
                return 409, None
            self.volume_data = None
            return 204, None
        if path.startswith("/containers/create?"):
            name = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)["name"][0]
            index = P.NAMES.index(name)
            identifier = ("a" if index == 0 else "b") * 64
            config = copy.deepcopy({key: value for key, value in body.items() if key != "HostConfig"})
            config.setdefault("Hostname", identifier[:12])
            # Simulate extra resolved defaults without seeding B from old inspect.
            config.setdefault("Domainname", "")
            host = copy.deepcopy(body["HostConfig"])
            host.setdefault("ConsoleSize", [0, 0])
            mounts = []
            for declaration in host["Mounts"]:
                mount = {"Destination": declaration["Target"], "Type": declaration["Type"],
                         "RW": not declaration.get("ReadOnly", False), "Propagation": "rprivate"}
                if mount["Type"] == "volume":
                    mount.update(Name=declaration["Source"], Source=self.volume_data["Mountpoint"])
                else:
                    mount["Source"] = declaration["Source"]
                mounts.append(mount)
            if self.tmpfs_in_mounts:
                mounts.append({"Destination": "/tmp", "Type": "tmpfs", "Source": "", "RW": True})
            inspected = {"Id": identifier, "Name": "/" + name, "Image": P.IMAGE_ID,
                         "Config": config, "HostConfig": host, "Mounts": mounts, "State": {"Running": False}}
            self.created_change(inspected, index)
            self.containers[identifier] = inspected
            return 201, {"Id": identifier, "Warnings": self.warnings}
        if path.startswith("/containers/") and path.endswith("/json"):
            target = path.split("/")[2]
            item = self.containers.get(target)
            if item is None:
                item = next((item for item in self.containers.values() if item["Name"] == "/" + target), None)
            if item is None and self.collision and target == P.NAMES[0]:
                return 200, {"Id": "e" * 64}
            if item is not None and len(self.mutations) >= 3:
                self.cleanup_change(item)
            return (200, copy.deepcopy(item)) if item else (404, None)
        if method == "DELETE" and path.startswith("/containers/"):
            identifier = path.split("/")[2].split("?", 1)[0]
            if self.containers[identifier]["State"]["Running"]:
                return 409, None
            del self.containers[identifier]
            return 204, None
        raise AssertionError("unexpected fake fixture route")


class ProbeTests(unittest.TestCase):
    def candidate(self, engine=None, evidence=None):
        engine, evidence = engine or FakeEngine(), evidence or MemoryEvidence()
        return P.Probe(engine, evidence, DAEMON), engine, evidence

    def test_complete_actual_payload_reconstruction_and_exact_cleanup(self):
        probe, engine, evidence = self.candidate()
        result = probe.run()
        self.assertTrue(result["cleanup_verified"])
        self.assertFalse(result["started"])
        self.assertEqual(result["network_mode"], "none")
        self.assertEqual(len(engine.mutations), 6)
        self.assertLessEqual(len(engine.calls), P.MAX_REQUESTS)
        self.assertEqual(engine.containers, {})
        self.assertIsNone(engine.volume_data)
        self.assertTrue(evidence.cleaned)
        a = evidence.files["container-0-confirmed.json"]
        b = evidence.files["container-1-confirmed.json"]
        self.assertEqual(a["Config"]["Image"], P.IMAGE_REFERENCE)
        self.assertEqual(b["Config"]["Image"], P.IMAGE_ID)
        self.assertEqual(engine.bodies[P.NAMES[1]]["HostConfig"], a["HostConfig"])
        self.assertEqual(P.invariants(a), P.invariants(b))
        self.assertFalse(any(any(word in path for word in ("/start", "/stop", "/exec", "/prune", "/networks")) for _, path in engine.calls))

    def test_both_tmpfs_inspect_representations_are_compared_without_dropping_fields(self):
        for present in (False, True):
            engine = FakeEngine()
            engine.tmpfs_in_mounts = present
            probe, _, evidence = self.candidate(engine)
            probe.run()
            a = evidence.files["container-0-confirmed.json"]
            self.assertEqual(any(row["Type"] == "tmpfs" for row in a["Mounts"]), present)

    def test_every_unknown_mutation_stops_and_preserves_without_cleanup_or_retry(self):
        for landed in (False, True):
            for index in range(1, 7):
                with self.subTest(landed=landed, index=index):
                    engine = FakeEngine()
                    engine.fail, engine.land_unknown = index, landed
                    probe, _, evidence = self.candidate(engine)
                    with self.assertRaisesRegex(P.Stop, "outcome unknown"):
                        probe.run()
                    self.assertEqual(len(engine.mutations), index)
                    self.assertFalse(evidence.cleaned)

    def test_collision_or_daemon_mismatch_precedes_files_or_mutations(self):
        engine = FakeEngine()
        engine.collision = True
        probe, _, evidence = self.candidate(engine)
        with self.assertRaises(P.Stop):
            probe.run()
        self.assertFalse(evidence.opened)
        self.assertEqual(engine.mutations, [])
        probe, engine, evidence = self.candidate()
        probe.expected_daemon = "0" * 64
        with self.assertRaisesRegex(P.Stop, "daemon"):
            probe.run()
        self.assertEqual(len(engine.calls), 1)
        self.assertFalse(evidence.opened)

    def test_unexpected_created_environment_or_host_access_never_creates_b(self):
        for mutate in (lambda item: item["Config"].update(Env=["TOKEN=synthetic"]),
                       lambda item: item["HostConfig"].update(NetworkMode="host"),
                       lambda item: item["HostConfig"].update(Privileged=True),
                       lambda item: item["HostConfig"].update(Binds=["/unrelated:/other"]),
                       lambda item: item["Mounts"][0].update(Name="unrelated-volume")):
            engine = FakeEngine()
            engine.created_change = lambda item, index: mutate(item) if index == 0 else None
            probe, _, evidence = self.candidate(engine)
            with self.assertRaises(P.Stop):
                probe.run()
            self.assertEqual(len(engine.mutations), 2)
            self.assertFalse(evidence.cleaned)

    def test_warning_retains_known_id_and_never_creates_b(self):
        engine = FakeEngine()
        engine.warnings = ["synthetic warning"]
        probe, _, evidence = self.candidate(engine)
        with self.assertRaisesRegex(P.Stop, "warnings"):
            probe.run()
        self.assertEqual(probe.ids, ["a" * 64])
        self.assertEqual(len(engine.mutations), 2)
        self.assertFalse(evidence.cleaned)

    def test_daemon_change_blocks_next_mutation_and_preserves_fixture(self):
        engine = FakeEngine()
        engine.daemon_change_after = 1
        probe, _, evidence = self.candidate(engine)
        with self.assertRaisesRegex(P.Stop, "outcome unknown"):
            probe.run()
        self.assertEqual(len(engine.mutations), 1)
        self.assertFalse(evidence.cleaned)

    def test_unexplained_inspect_default_stops_without_silent_normalization(self):
        engine = FakeEngine()
        engine.created_change = lambda item, index: item["HostConfig"].update(Dns=[]) if index == 1 else None
        probe, _, evidence = self.candidate(engine)
        with self.assertRaisesRegex(P.Stop, "representation mismatch"):
            probe.run()
        self.assertEqual(evidence.files["mismatch.json"]["fields"], ["HostConfig"])
        self.assertEqual(len(engine.mutations), 3)
        self.assertFalse(evidence.cleaned)

    def test_every_unapproved_host_access_field_blocks_a_and_presend_b(self):
        changes = {
            "uts": lambda host: host.update(UTSMode="host"),
            "userns": lambda host: host.update(UsernsMode="host"),
            "pid": lambda host: host.update(PidMode="host"),
            "ipc": lambda host: host.update(IpcMode="host"),
            "cgroupns": lambda host: host.update(CgroupnsMode="host"),
            "cgroup-parent": lambda host: host.update(CgroupParent="/unrelated"),
            "cid-file": lambda host: host.update(ContainerIDFile="/unrelated/file"),
            "runtime": lambda host: host.update(Runtime="unreviewed"),
            "device-rules": lambda host: host.update(DeviceCgroupRules=["a"]),
            "device-request": lambda host: host.update(DeviceRequests=[{"Driver": "unreviewed"}]),
            "sysctls": lambda host: host.update(Sysctls={"kernel.example": "synthetic"}),
            "annotations": lambda host: host.update(Annotations={"hook": "synthetic"}),
            "storage": lambda host: host.update(StorageOpt={"unreviewed": "synthetic"}),
            "groups": lambda host: host.update(GroupAdd=["0"]),
            "unknown": lambda host: host.update(FutureHostPrivilege=True),
            "bind-propagation": lambda host: host["Mounts"][1]["BindOptions"].update(Propagation="rshared"),
            "bind-create": lambda host: host["Mounts"][1]["BindOptions"].update(CreateMountpoint=True),
            "volume-driver": lambda host: host["Mounts"][0]["VolumeOptions"].update(DriverConfig={"Name": "unreviewed"}),
            "volume-subpath": lambda host: host["Mounts"][0]["VolumeOptions"].update(Subpath="unreviewed"),
            "volume-copy": lambda host: host["Mounts"][0]["VolumeOptions"].update(NoCopy=False),
            "mount-option": lambda host: host["Mounts"][0].update(FutureMountPrivilege=True),
        }
        for name, change in changes.items():
            for stage in ("a-inspect", "b-presend"):
                with self.subTest(field=name, stage=stage):
                    engine, evidence = FakeEngine(), MemoryEvidence()
                    if stage == "a-inspect":
                        engine.created_change = lambda item, index: change(item["HostConfig"]) if index == 0 else None
                    else:
                        write = evidence.write
                        def changed_after_validation(name, value):
                            write(name, value)
                            if name == "container-0-confirmed.json":
                                change(value["HostConfig"])
                        evidence.write = changed_after_validation
                    probe, _, _ = self.candidate(engine, evidence)
                    with self.assertRaises(P.Stop):
                        probe.run()
                    self.assertEqual(len(engine.mutations), 2)
                    self.assertFalse(evidence.cleaned)

    def test_unreviewed_config_or_nested_healthcheck_cannot_be_forwarded(self):
        for change in (lambda item: item["Config"].update(NetworkingConfig={"EndpointsConfig": {"host": {}}}),
                       lambda item: item["Config"]["Healthcheck"].update(Interval=1),
                       lambda item: item["Config"].update(Volumes={"/unrelated": {}})):
            engine = FakeEngine()
            engine.created_change = lambda item, index: change(item) if index == 0 else None
            probe, _, evidence = self.candidate(engine)
            with self.assertRaises(P.Stop):
                probe.run()
            self.assertEqual(len(engine.mutations), 2)
            self.assertFalse(evidence.cleaned)

    def test_cleanup_fresh_ownership_recheck_blocks_deleting_changed_container(self):
        probe, engine, evidence = self.candidate()
        original = probe.inspect
        calls = 0
        def inspect(identifier):
            nonlocal calls
            calls += 1
            if calls == 3:
                engine.containers[identifier]["Config"]["Labels"] = {"unrelated": "owner"}
            return original(identifier)
        probe.inspect = inspect
        with self.assertRaisesRegex(P.Stop, "ownership"):
            probe.run()
        self.assertEqual(len(engine.mutations), 3)
        self.assertFalse(evidence.cleaned)

    def test_evidence_intent_failure_precedes_corresponding_engine_mutation(self):
        for name, writes in (("volume-intent.json", 0), ("container-0-intent.json", 1),
                             ("container-1-intent.json", 2), ("delete-1-intent.json", 3),
                             ("volume-delete-intent.json", 5)):
            evidence = MemoryEvidence()
            evidence.fail_name = name
            probe, engine, _ = self.candidate(evidence=evidence)
            with self.assertRaisesRegex(P.Stop, "evidence"):
                probe.run()
            self.assertEqual(len(engine.mutations), writes)
            self.assertFalse(evidence.cleaned)

    def test_default_and_unreviewed_execute_never_construct_engine_or_evidence(self):
        for args in (["probe"], ["probe", "--execute"]):
            with patch.object(sys, "argv", args), patch.object(P, "FixtureEngine") as engine, patch.object(P, "RamEvidence") as evidence, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if "--execute" in args:
                    with self.assertRaises(SystemExit):
                        P.main()
                else:
                    P.main()
                engine.assert_not_called()
                evidence.assert_not_called()


class Response:
    def __init__(self, raw=b"{}", status=200, will_close=False, after_read=None):
        self.raw, self.status = raw, status
        self.will_close, self.after_read = will_close, after_read

    def read1(self, length):
        chunk, self.raw = self.raw[:length], self.raw[length:]
        if not chunk and self.after_read:
            self.after_read()
        return chunk


class Connection:
    def __init__(self, response, *, daemon_info=False):
        self.response, self.sock, self.sent, self.closed = response, Mock(), [], False
        self.daemon_info, self.token, self.info_closing, self.after_info = daemon_info, "original", False, None
        self.daemon_id = "synthetic-daemon"

    def begin(self, deadline):
        self.closed = False
        deadline.remaining()
        return self.identity()

    def identity(self):
        return self.token

    def reset_response_budget(self):
        pass

    def request(self, *args, **kwargs):
        self.sent.append((args, kwargs))

    def getresponse(self):
        if self.daemon_info and self.sent[-1][0][1] == "/v1.53/info":
            return Response(P.canonical({"ID": self.daemon_id}).encode(), 200,
                            will_close=self.info_closing, after_read=self.after_info)
        return self.response

    def close(self):
        self.closed = True


class TransportTests(unittest.TestCase):
    def test_no_start_stop_exec_production_or_unarmed_mutation_reaches_connection(self):
        factory = Mock()
        for armed in (False, True):
            engine = P.FixtureEngine(armed=armed, connection=factory)
            for method, path in (("POST", "/containers/a/start"), ("POST", "/containers/a/stop"),
                                 ("POST", "/containers/a/exec"), ("GET", "/containers/production/json"),
                                 ("POST", "/networks/create"), ("DELETE", "/volumes/unrelated?force=false"),
                                 ("POST", "/images/create"), ("POST", "/containers/prune")):
                with self.assertRaises(P.Stop):
                    engine.request(method, path)
        factory.assert_not_called()

    def test_request_budget_fixed_prefix_and_malformed_response_redaction(self):
        connection = Connection(Response())
        engine = P.FixtureEngine(connection=lambda: connection)
        for _ in range(P.MAX_REQUESTS):
            engine.request("GET", "/info")
        with self.assertRaisesRegex(P.Stop, "budget"):
            engine.request("GET", "/info")
        self.assertTrue(all(args[1] == "/v1.53/info" for args, _ in connection.sent))
        for raw in (b"not-json-secret-shaped-fixture", b'{"duplicate":1,"duplicate":2}', b"x" * (P.MAX_BYTES + 1)):
            connection = Connection(Response(raw))
            engine = P.FixtureEngine(connection=lambda: connection)
            with self.assertRaises(P.Stop) as error:
                engine.request("GET", "/info")
            self.assertNotIn("secret-shaped", str(error.exception))
            self.assertTrue(connection.closed)

    def test_container_delete_requires_exact_registered_id_and_no_force(self):
        connection = Connection(Response(b"", 204))
        connection.daemon_info = True
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=lambda: connection)
        identifier = "a" * 64
        with self.assertRaises(P.Stop):
            engine.request("DELETE", f"/containers/{identifier}?v=false&force=false&link=false")
        engine.permit_container(identifier)
        for query in ("v=true&force=false&link=false", "v=false&force=true&link=false"):
            with self.assertRaises(P.Stop):
                engine.request("DELETE", f"/containers/{identifier}?{query}")
        self.assertEqual(engine.request("DELETE", f"/containers/{identifier}?v=false&force=false&link=false"), (204, None))

    def test_changed_create_body_refuses_before_io(self):
        factory = Mock()
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=factory)
        body = P.source_payload()
        engine.permit_body(P.NAMES[0], body)
        changed = copy.deepcopy(body)
        changed["HostConfig"]["NetworkMode"] = "host"
        with self.assertRaises(P.Stop):
            engine.request("POST", "/containers/create?name=" + P.NAMES[0], changed)
        factory.assert_not_called()

    def test_mutation_is_never_repeated_and_deadline_is_terminal(self):
        connection = Connection(Response(b"{}", 201))
        connection.daemon_info = True
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=lambda: connection)
        body = P.source_payload()
        engine.permit_body(P.NAMES[0], body)
        route = "/containers/create?name=" + P.NAMES[0]
        engine.request("POST", route, body)
        with self.assertRaisesRegex(P.Stop, "already attempted"):
            engine.request("POST", route, body)
        self.assertEqual(len(connection.sent), 2)
        ticks = iter([0, 16])
        connection = Connection(Response())
        engine = P.FixtureEngine(connection=lambda: connection, clock=lambda: next(ticks))
        with self.assertRaises(P.Stop):
            engine.request("GET", "/info")
        self.assertTrue(connection.closed)

    def test_info_and_mutation_share_one_connection_despite_socket_path_replacement(self):
        verified = Connection(Response(b"{}", 201), daemon_info=True)
        replacement = Connection(Response(b"{}", 201), daemon_info=True)
        replacement.daemon_id = "unreviewed-daemon"
        replaced = []
        verified.after_info = lambda: replaced.append(True)
        factory = Mock(side_effect=[verified, replacement])
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=factory)
        body = P.source_payload()
        engine.permit_body(P.NAMES[0], body)
        engine.request("POST", "/containers/create?name=" + P.NAMES[0], body)
        self.assertEqual(factory.call_count, 1)
        self.assertTrue(replaced)
        self.assertEqual([args[0] for args, _ in verified.sent], ["GET", "POST"])
        self.assertEqual(replacement.sent, [])

    def test_changed_connection_closing_or_wrong_daemon_blocks_before_mutation_send(self):
        for change in (lambda connection: setattr(connection, "after_info", lambda: setattr(connection, "token", "replacement")),
                       lambda connection: setattr(connection, "info_closing", True),
                       lambda connection: setattr(connection, "daemon_id", "unreviewed-daemon")):
            connection = Connection(Response(b"{}", 201), daemon_info=True)
            change(connection)
            factory = Mock(return_value=connection)
            engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=factory)
            body = P.source_payload()
            engine.permit_body(P.NAMES[0], body)
            with self.assertRaises(P.Stop):
                engine.request("POST", "/containers/create?name=" + P.NAMES[0], body)
            self.assertEqual([args[0] for args, _ in connection.sent], ["GET"])
            self.assertEqual(factory.call_count, 1)
            self.assertTrue(connection.closed)

    def test_closed_host_policy_is_checked_before_create_registration_or_io(self):
        factory = Mock()
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=factory)
        body = P.source_payload()
        body["HostConfig"]["UTSMode"] = "host"
        with self.assertRaisesRegex(P.Stop, "HostConfig"):
            engine.permit_body(P.NAMES[0], body)
        self.assertEqual(engine.bodies, {})
        factory.assert_not_called()


class TickClock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class RawSocket:
    def __init__(self, raw=b"", *, clock=None, drip=False):
        self.raw, self.clock, self.drip = raw, clock, drip
        self.receives, self.timeouts, self.sent, self.connects = 0, [], [], []
        self.closed = False

    def settimeout(self, value):
        self.timeouts.append(value)

    def recv_into(self, buffer):
        # Return status line together, then deliver a header one byte per read.
        limit = self.raw.index(b"\n") + 1 if self.drip and self.receives == 0 else 1 if self.drip else len(buffer)
        count = min(len(buffer), len(self.raw), limit)
        buffer[:count], self.raw = self.raw[:count], self.raw[count:]
        self.receives += 1
        if self.clock is not None:
            self.clock.now += 1
        return count

    def sendall(self, data):
        self.sent.append(data)

    def connect(self, path):
        self.connects.append(path)

    def getsockopt(self, *args):
        return struct.pack("3i", 12345, 0, 0)

    def fileno(self):
        return -1 if self.closed else 7

    def close(self):
        self.closed = True


class MutationOutcomeHonestyTests(unittest.TestCase):
    def test_daemon_verification_failure_reports_before_mutation_distinctly(self):
        connection = Connection(Response(b"", 204), daemon_info=True)
        connection.daemon_id = "unreviewed-daemon"
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=lambda: connection)
        identifier = "a" * 64
        engine.permit_container(identifier)
        with self.assertRaisesRegex(P.Stop, "same-connection daemon verification failed before mutation"):
            engine.request("DELETE", "/containers/" + identifier + "?v=false&force=false&link=false")
        self.assertEqual([args[0] for args, _ in connection.sent], ["GET"])
        self.assertTrue(connection.closed)

    def test_post_mutation_send_failure_reports_after_mutation_sent(self):
        class DroppedResponse:
            status, will_close = 204, False
            def read1(self, length):
                raise OSError("synthetic dropped connection")
        connection = Connection(Response(b"", 204), daemon_info=True)
        connection.response = DroppedResponse()
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=lambda: connection)
        identifier = "b" * 64
        engine.permit_container(identifier)
        with self.assertRaisesRegex(P.Stop, "Engine response unavailable after mutation sent"):
            engine.request("DELETE", "/containers/" + identifier + "?v=false&force=false&link=false")
        self.assertEqual([args[0] for args, _ in connection.sent], ["GET", "DELETE"])
        self.assertTrue(connection.closed)

    def test_pre_socket_refusal_keeps_its_fixed_reason(self):
        factory = Mock()
        engine = P.FixtureEngine(armed=True, expected_daemon=DAEMON, connection=factory)
        identifier = "c" * 64
        engine.permit_container(identifier)
        with self.assertRaisesRegex(P.Stop, "before socket access"):
            engine.request("DELETE", "/containers/" + identifier + "?v=false&force=true&link=false")
        factory.assert_not_called()


class AbsoluteDeadlineTests(unittest.TestCase):
    def test_incremental_headers_cannot_extend_total_deadline(self):
        clock = TickClock()
        raw = RawSocket(b"HTTP/1.1 200 OK\r\nX-Synthetic: " + b"x" * 100 + b"\r\nContent-Length: 0\r\n\r\n", clock=clock, drip=True)
        wrapped = P.DeadlineSocket(raw, P.Deadline(clock))
        response = http.client.HTTPResponse(wrapped)
        with self.assertRaisesRegex(P.Stop, "absolute"):
            response.begin()
        self.assertLessEqual(clock.now, 15)
        self.assertGreater(raw.receives, 1)
        self.assertEqual(raw.timeouts, sorted(raw.timeouts, reverse=True))
        response.close()
        wrapped.close()

    def test_real_http_connection_never_reopens_a_closed_pinned_socket(self):
        raw = RawSocket()
        fake_stat = type("Info", (), {"st_mode": stat.S_IFSOCK | 0o600, "st_uid": 0})()
        with patch.object(P.os, "lstat", return_value=fake_stat), patch.object(P.socket, "socket", return_value=raw) as factory:
            connection = P.UnixConnection()
            connection.begin(P.Deadline(lambda: 0))
            original = connection.sock
            connection.sock = None
            with self.assertRaises(http.client.NotConnected):
                connection.request("POST", "/v1.53/containers/create", body=b"{}")
            self.assertEqual(factory.call_count, 1)
            self.assertEqual(raw.connects, [P.SOCKET])
            with self.assertRaisesRegex(P.Stop, "reconnect"):
                connection.connect()
            original.close()

    def test_header_and_body_share_wire_limit(self):
        raw = RawSocket(b"HTTP/1.1 200 OK\r\nX-Synthetic: " + b"x" * 100 + b"\r\n\r\n")
        wrapped = P.DeadlineSocket(raw, P.Deadline(lambda: 0))
        with patch.object(P, "MAX_BYTES", 32):
            response = http.client.HTTPResponse(wrapped)
            with self.assertRaisesRegex(P.Stop, "wire"):
                response.begin()
            response.close()
        wrapped.close()


@unittest.skipUnless(Path("/proc/self/mountinfo").exists() and Path("/dev/shm").is_dir(), "Linux RAM fixture required")
class RamEvidenceTests(unittest.TestCase):
    def test_exclusive_ram_custody_cleanup_and_changed_entry_preservation(self):
        name = "um1654-offline-" + uuid.uuid4().hex
        root = "/dev/shm/" + name
        with patch.object(P, "BASE", name), patch.object(P, "RAM_ROOT", root):
            evidence = P.RamEvidence()
            try:
                evidence.open()
                self.assertEqual(os.stat(root).st_mode & 0o777, 0o700)
                self.assertEqual(os.stat(root + "/config.json").st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    P.RamEvidence().open()
                extra = Path(root) / "unrelated"
                extra.write_text("synthetic")
                with self.assertRaisesRegex(P.Stop, "unexpected"):
                    evidence.cleanup()
                self.assertTrue(extra.exists())
                extra.unlink()
                config = Path(root) / "config.json"
                original = config.read_bytes()
                config.write_bytes(b"x" * len(original))
                with self.assertRaisesRegex(P.Stop, "readback"):
                    evidence.check()
                config.write_bytes(original)
                evidence.cleanup()
                self.assertFalse(Path(root).exists())
            finally:
                evidence.close()
                if Path(root).exists():
                    shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
