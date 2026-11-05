"""Synthetic cleanup tests; sockets are forbidden throughout every test."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("cleanup_fixture", Path(__file__).with_name("cleanup-engine-representation.py"))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
P = C.load_reviewed_transport()
DAEMON = hashlib.sha256(b"synthetic-daemon").hexdigest()


def inspected():
    payload = P.source_payload()
    host = payload.pop("HostConfig")
    host["MemorySwappiness"] = None
    return {"Id": C.CONTAINER_ID, "Name": "/" + P.NAMES[0], "Image": P.IMAGE_ID,
            "Config": payload, "HostConfig": host, "Mounts": [],
            "State": {"Status": "created", "Running": False, "Paused": False,
                      "Restarting": False, "Dead": False, "Pid": 0}}


class Evidence:
    def __init__(self):
        self.opened = self.cleaned = False
        self.removed = []
        self.checks = 0
        self.fail_check = None

    def open(self):
        self.opened = True
        self.check()

    def check(self):
        self.checks += 1
        if self.checks == self.fail_check:
            raise C.Stop("synthetic evidence mismatch")

    def cleanup(self):
        self.check()
        self.cleaned = True

    def assert_absent(self):
        if not self.cleaned:
            raise AssertionError("RAM unexpectedly remains")


class Engine:
    def __init__(self):
        self.item = inspected()
        self.volume = {"Name": P.VOLUME, "Driver": "local", "Options": copy.deepcopy(P.VOLUME_OPTIONS),
                       "Labels": copy.deepcopy(P.VOLUME_LABELS)}
        self.calls = 0
        self.routes = []
        self.operations = []
        self.fail = None
        self.landed = False
        self.conflict = None
        self.ghost = None
        self.refuse = None
        self.before = lambda method, path: None
        self.daemon = "synthetic-daemon"

    def request(self, method, path):
        self.before(method, path)
        self.calls += 2 if method == "DELETE" else 1
        self.routes.append((method, path))
        if method == "DELETE":
            if self.refuse == len(self.operations) + 1:
                raise C.Stop("cleanup route refused before socket access")
            if hashlib.sha256(self.daemon.encode()).hexdigest() != C.DAEMON_SHA256:
                raise C.Stop("synthetic pinned daemon mismatch")
            self.operations.append(path)
            if self.fail == len(self.operations) and not self.landed:
                raise TimeoutError("synthetic unknown before landing")
            if self.conflict == len(self.operations):
                return 409, None
            if path.startswith("/containers/"):
                self.item = None
            else:
                self.volume = None
            if self.fail == len(self.operations) and self.landed:
                raise TimeoutError("synthetic unknown after landing")
            return 204, None
        if path == "/info":
            return 200, {"ID": self.daemon}
        if path == "/volumes/" + P.VOLUME:
            return (200, copy.deepcopy(self.volume)) if self.volume is not None else (404, None)
        ref = path.split("/")[2]
        if ref == P.NAMES[1]:
            return (200, {}) if self.ghost == "b" else (404, None)
        if self.item is not None:
            return 200, copy.deepcopy(self.item)
        if self.ghost == ref:
            return 200, inspected()
        return 404, None


class Tests(unittest.TestCase):
    def setUp(self):
        self.socket_guard = patch("socket.socket", side_effect=AssertionError("offline tests must not open sockets"))
        self.socket_guard.start()
        self.addCleanup(self.socket_guard.stop)
        self.daemon = patch.object(C, "DAEMON_SHA256", DAEMON)
        self.daemon.start()
        self.addCleanup(self.daemon.stop)
        self.projection = patch.object(C, "INVARIANTS_SHA256", P.digest(P.invariants(inspected())))
        self.projection.start()
        self.addCleanup(self.projection.stop)

    def candidate(self):
        engine, evidence = Engine(), Evidence()
        return C.Cleanup(P, engine, evidence), engine, evidence

    def test_complete_exact_two_deletions_and_eighteen_wire_reads(self):
        cleanup, engine, evidence = self.candidate()
        result = cleanup.run()
        self.assertEqual(result["status"], "cleanup_verified")
        self.assertEqual(engine.calls, 18)
        self.assertEqual(len(engine.operations), 2)
        self.assertEqual(engine.operations, ["/containers/" + C.CONTAINER_ID + "?v=false&force=false&link=false",
                                             "/volumes/" + P.VOLUME + "?force=false"])
        self.assertTrue(evidence.cleaned)
        self.assertFalse(result["equivalence_verified"])
        self.assertFalse(result["started"])
        self.assertIsNone(engine.item)
        self.assertIsNone(engine.volume)

    def test_precondition_drifts_prevent_every_deletion(self):
        changes = [lambda e: setattr(e, "daemon", "foreign"), lambda e: setattr(e, "ghost", "b"),
                   lambda e: e.item.update(Id="e" * 64), lambda e: e.item.update(Name="/foreign"),
                   lambda e: e.item.update(Image="foreign"), lambda e: e.item["Config"].update(Labels={}),
                   lambda e: e.item["HostConfig"].update(UTSMode="host"),
                   lambda e: e.item["HostConfig"].update(MemorySwappiness=0),
                   lambda e: e.item.update(Mounts=[{"unexpected": True}]),
                   lambda e: e.volume.update(Driver="foreign"), lambda e: e.volume.update(Options={}),
                   lambda e: e.volume.update(Labels={}), lambda e: e.volume.update(Name="foreign")]
        for key, value in (("Status", "exited"), ("Running", True), ("Paused", True),
                           ("Restarting", True), ("Dead", True), ("Pid", 1), ("Pid", False)):
            changes.append(lambda e, key=key, value=value: e.item["State"].update({key: value}))
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                cleanup, engine, evidence = self.candidate()
                change(engine)
                with self.assertRaises(C.Stop):
                    cleanup.run()
                self.assertEqual(engine.operations, [])
                self.assertFalse(evidence.cleaned)

    def test_every_unknown_deletion_preserves_remaining_resources_without_retry(self):
        for landed in (False, True):
            for index in (1, 2):
                with self.subTest(landed=landed, index=index):
                    cleanup, engine, evidence = self.candidate()
                    engine.fail, engine.landed = index, landed
                    with self.assertRaisesRegex(C.Stop, "outcome unknown"):
                        cleanup.run()
                    self.assertEqual(len(engine.operations), index)
                    self.assertEqual(cleanup.operations[-1]["outcome"], "unknown")
                    self.assertFalse(evidence.cleaned)

    def test_presend_refusal_records_not_sent_and_stops_without_retry(self):
        for index in (1, 2):
            with self.subTest(index=index):
                cleanup, engine, evidence = self.candidate()
                engine.refuse = index
                with self.assertRaisesRegex(C.Stop, "refused before socket access"):
                    cleanup.run()
                self.assertEqual(len(engine.operations), index - 1)
                self.assertEqual(cleanup.operations[-1]["outcome"], "not_sent")
                self.assertEqual(cleanup.operations[-1]["reason"], "cleanup route refused before socket access")
                self.assertFalse(evidence.cleaned)

    def test_conflict_at_each_deletion_stops_without_force_or_ram_cleanup(self):
        for index in (1, 2):
            cleanup, engine, evidence = self.candidate()
            engine.conflict = index
            with self.assertRaises(C.Stop):
                cleanup.run()
            self.assertEqual(len(engine.operations), index)
            self.assertEqual(cleanup.operations[-1]["http_status"], 409)
            self.assertFalse(evidence.cleaned)

    def test_each_a_absence_check_is_required_before_volume_deletion(self):
        for ref in (C.CONTAINER_ID, P.NAMES[0]):
            cleanup, engine, evidence = self.candidate()
            engine.ghost = ref
            with self.assertRaises(C.Stop):
                cleanup.run()
            self.assertEqual(len(engine.operations), 1)
            self.assertFalse(evidence.cleaned)

    def test_volume_and_b_are_rechecked_after_a_deletion(self):
        for kind in ("volume", "b", "daemon"):
            cleanup, engine, evidence = self.candidate()
            def drift(method, path):
                if engine.item is None:
                    if kind == "volume":
                        engine.volume["Labels"] = {}
                    elif kind == "b":
                        engine.ghost = "b"
                    else:
                        engine.daemon = "foreign"
            engine.before = drift
            with self.assertRaises(C.Stop):
                cleanup.run()
            self.assertEqual(len(engine.operations), 1)
            self.assertFalse(evidence.cleaned)

    def test_ram_is_checked_before_each_mutation_and_before_file_cleanup(self):
        for check in (1, 2, 3, 4):
            cleanup, engine, evidence = self.candidate()
            evidence.fail_check = check
            with self.assertRaises(C.Stop):
                cleanup.run()
            self.assertEqual(len(engine.operations), max(0, check - 2))
            self.assertFalse(evidence.cleaned)

    def test_outer_allowlist_rejects_all_unrelated_or_force_routes_before_transport(self):
        with patch.object(P, "FixtureEngine") as factory:
            engine = C.CleanupEngine(P)
            transport = factory.return_value
            transport.request.return_value = (404, None)
            self.assertEqual(factory.call_args.kwargs, {"armed": True, "expected_daemon": DAEMON})
            forbidden = [("POST", "/volumes/create"), ("POST", "/containers/create?name=" + P.NAMES[0]),
                         ("POST", "/containers/" + C.CONTAINER_ID + "/start"), ("GET", "/containers/json"),
                         ("GET", "/version"), ("GET", "/containers/foreign/json"),
                         ("DELETE", "/containers/" + C.CONTAINER_ID + "?force=true"),
                         ("DELETE", "/containers/" + P.NAMES[0] + "?v=false&force=false&link=false"),
                         ("DELETE", "/volumes/" + P.VOLUME + "?force=true")]
            for method, route in forbidden:
                with self.assertRaises(C.Stop):
                    engine.request(method, route)
            with self.assertRaises(C.Stop):
                engine.request("GET", "/info", {})
            transport.request.assert_not_called()
            route = "/containers/" + C.CONTAINER_ID + "?v=false&force=false&link=false"
            engine.request("DELETE", route)
            with self.assertRaises(C.Stop):
                engine.request("DELETE", route)
            self.assertEqual(transport.request.call_count, 1)
            engine.calls = C.MAX_REQUESTS
            with self.assertRaises(C.Stop):
                engine.request("GET", "/info")
            self.assertEqual(transport.request.call_count, 1)

    def test_default_and_failed_review_fence_never_construct_engine(self):
        with patch.object(C, "CleanupEngine") as engine, patch.object(C, "ExistingEvidence") as evidence:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(C.main([]), 0)
            self.assertEqual(json.loads(output.getvalue())["engine_calls"], 0)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(C.main(["--execute", "--reviewed-cleanup-sha256", "wrong"]), 2)
            engine.assert_not_called()
            evidence.assert_not_called()

    def test_transport_hash_mismatch_prevents_loading_changed_source(self):
        with patch.object(C, "SOURCE_SHA256", "0" * 64):
            with self.assertRaises(C.Stop):
                C.load_reviewed_transport()

    def test_exact_release_hashes_are_required_without_engine_io(self):
        args = types.SimpleNamespace(reviewed_cleanup_sha256=hashlib.sha256(Path(C.__file__).read_bytes()).hexdigest(),
                                     reviewed_plan_sha256=C.PLAN_SHA256)
        C.verify_release(args)
        for key in ("reviewed_cleanup_sha256", "reviewed_plan_sha256"):
            changed = copy.copy(args)
            setattr(changed, key, "0" * 64)
            with self.assertRaises(C.Stop):
                C.verify_release(changed)
        with patch.object(C, "ORIGINAL_PLAN_SHA256", "0" * 64):
            with self.assertRaises(C.Stop):
                C.verify_release(args)

    @contextlib.contextmanager
    def ram_fixture(self):
        with tempfile.TemporaryDirectory(prefix="um1654-offline-") as parent:
            root = Path(parent) / "fixture"
            root.mkdir(mode=0o700)
            files = {}
            for name in C.RAM_FILES:
                path = root / name
                raw = ("synthetic-" + name).encode()
                path.write_bytes(raw)
                path.chmod(0o600)
                st = path.stat()
                files[name] = (st.st_ino, len(raw), hashlib.sha256(raw).hexdigest())
            st = root.stat()
            source = types.SimpleNamespace(BASE="fixture")
            original_open = os.open
            def fixture_open(path, *args, **kwargs):
                return original_open(parent if path == "/dev/shm" else path, *args, **kwargs)
            with patch.object(C, "RAM_IDENTITY", (st.st_dev, st.st_ino, st.st_uid)), patch.object(C, "RAM_FILES", files), patch.object(C.os, "open", side_effect=fixture_open):
                evidence = C.ExistingEvidence(source)
                try:
                    yield evidence, root
                finally:
                    evidence.close()

    def test_actual_filesystem_exact_cleanup_removes_only_the_four_files(self):
        with self.ram_fixture() as (evidence, root):
            evidence.open()
            evidence.cleanup()
            evidence.assert_absent()
            self.assertFalse(root.exists())
            self.assertEqual(set(evidence.removed), set(C.RAM_FILES))

    def test_actual_ram_identity_content_mode_and_unexpected_entries_refuse_cleanup(self):
        changes = [lambda root: (root / "extra").write_text("synthetic"),
                   lambda root: (root / "config.json").write_bytes(b"x" * (root / "config.json").stat().st_size),
                   lambda root: (root / "config.json").chmod(0o644),
                   lambda root: root.chmod(0o755),
                   lambda root: (root / "config.json").rename(root / "replacement"),
                   lambda root: os.link(root / "config.json", root.parent / "hardlink")]
        for index, change in enumerate(changes):
            with self.subTest(index=index), self.ram_fixture() as (evidence, root):
                evidence.open()
                change(root)
                with self.assertRaises(C.Stop):
                    evidence.cleanup()
                self.assertEqual(evidence.removed, [])
                self.assertTrue(root.exists())

    def test_actual_ram_symlink_refused_without_following_target(self):
        with self.ram_fixture() as (evidence, root):
            evidence.open()
            target = root.parent / "unrelated"
            target.write_text("untouched")
            (root / "config.json").unlink()
            (root / "config.json").symlink_to(target)
            with self.assertRaises(OSError):
                evidence.cleanup()
            self.assertEqual(target.read_text(), "untouched")
            self.assertEqual(evidence.removed, [])

    def test_actual_ram_path_replacement_preserves_original_and_replacement(self):
        with self.ram_fixture() as (evidence, root):
            evidence.open()
            root.rename(root.parent / "original")
            root.mkdir(mode=0o700)
            with self.assertRaises(C.Stop):
                evidence.cleanup()
            self.assertEqual(evidence.removed, [])
            self.assertTrue((root.parent / "original" / "config.json").exists())
            self.assertTrue(root.exists())

    def test_ram_failure_after_partial_unlink_stops_without_recursive_cleanup(self):
        with self.ram_fixture() as (evidence, root):
            evidence.open()
            original_unlink = os.unlink
            attempts = []
            def fail_second(name, **kwargs):
                attempts.append(name)
                if len(attempts) == 2:
                    raise OSError("synthetic unknown unlink")
                return original_unlink(name, **kwargs)
            with patch.object(C.os, "unlink", side_effect=fail_second):
                with self.assertRaises(OSError):
                    evidence.cleanup()
            self.assertEqual(evidence.removed, ["config.json"])
            self.assertEqual(len(list(root.iterdir())), 3)


if __name__ == "__main__":
    unittest.main()
