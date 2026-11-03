"""Synthetic offline Engine only; never open Docker sockets or invoke Docker CLI."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
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
        with self.assertRaisesRegex(P.Stop, "daemon"):
            probe.run()
        self.assertEqual(len(engine.mutations), 1)
        self.assertFalse(evidence.cleaned)

    def test_unexplained_inspect_default_stops_without_silent_normalization(self):
        engine = FakeEngine()
        engine.created_change = lambda item, index: item["HostConfig"].update(UnexpectedDefault=True) if index == 1 else None
        probe, _, evidence = self.candidate(engine)
        with self.assertRaisesRegex(P.Stop, "representation mismatch"):
            probe.run()
        self.assertEqual(evidence.files["mismatch.json"]["fields"], ["HostConfig"])
        self.assertEqual(len(engine.mutations), 3)
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
    def __init__(self, raw=b"{}", status=200):
        self.raw, self.status = raw, status

    def read1(self, length):
        chunk, self.raw = self.raw[:length], self.raw[length:]
        return chunk


class Connection:
    def __init__(self, response):
        self.response, self.sock, self.sent, self.closed = response, Mock(), [], False

    def request(self, *args, **kwargs):
        self.sent.append((args, kwargs))

    def getresponse(self):
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
        engine = P.FixtureEngine(armed=True, connection=lambda: connection)
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
        engine = P.FixtureEngine(armed=True, connection=factory)
        body = P.source_payload()
        engine.permit_body(P.NAMES[0], body)
        changed = copy.deepcopy(body)
        changed["HostConfig"]["NetworkMode"] = "host"
        with self.assertRaises(P.Stop):
            engine.request("POST", "/containers/create?name=" + P.NAMES[0], changed)
        factory.assert_not_called()

    def test_mutation_is_never_repeated_and_deadline_is_terminal(self):
        connection = Connection(Response(b"{}", 201))
        engine = P.FixtureEngine(armed=True, connection=lambda: connection)
        body = P.source_payload()
        engine.permit_body(P.NAMES[0], body)
        route = "/containers/create?name=" + P.NAMES[0]
        engine.request("POST", route, body)
        with self.assertRaisesRegex(P.Stop, "already attempted"):
            engine.request("POST", route, body)
        self.assertEqual(len(connection.sent), 1)
        ticks = iter([0, 16])
        connection = Connection(Response())
        engine = P.FixtureEngine(connection=lambda: connection, clock=lambda: next(ticks))
        with self.assertRaises(P.Stop):
            engine.request("GET", "/info")
        self.assertTrue(connection.closed)


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
