"""Offline V2 deltas plus all 25 hash-pinned original synthetic tests."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import types
import unittest

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("v2_fixture", HERE / "probe-engine-representation-v2.py")
V = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(V)

# Reuse the independently reviewed tests against V2 without copying their logic.
RAW = (HERE / "test_probe_engine_representation.py").read_bytes()
assert hashlib.sha256(RAW).hexdigest() == "c9b52713c5ab0b1be72123ed34c099d48cfb06637ef108e82fd3d98f7857cdd6"
LEGACY = types.ModuleType("v2_reused_fixture_tests")
LEGACY.__file__ = str(HERE / "test_probe_engine_representation.py")
exec(compile(RAW, LEGACY.__file__, "exec"), LEGACY.__dict__)
ORIGINAL = LEGACY.P
LEGACY.P = V
OriginalEngine = LEGACY.FakeEngine


class FakeEngine(OriginalEngine):
    def __init__(self):
        super().__init__()
        self.cgroup_version = "2"

    def route(self, method, path, body):
        status, value = super().route(method, path, body)
        if path == "/info":
            value["CgroupVersion"] = self.cgroup_version
        return status, value


LEGACY.FakeEngine = FakeEngine


class V2Tests(unittest.TestCase):
    def candidate(self, engine=None):
        engine = engine or FakeEngine()
        evidence = LEGACY.MemoryEvidence()
        return V.Probe(engine, evidence, LEGACY.DAEMON), engine, evidence

    def test_original_reviewed_artifacts_unchanged_and_new_nonce_disjoint(self):
        self.assertEqual(hashlib.sha256((HERE / "probe-engine-representation.py").read_bytes()).hexdigest(),
                         "da431146b352cc047313624f04d2041073d7d093928308b6b6115217362f1b32")
        self.assertEqual(V.BASE, "um1654-repr-01a1a250-8e4a92f7")
        self.assertEqual(V.LABELS["com.simplewithus.fixture.nonce"], "8e4a92f7")
        self.assertTrue(set(V.NAMES).isdisjoint(ORIGINAL.NAMES))
        self.assertNotEqual(V.VOLUME, ORIGINAL.VOLUME)
        self.assertNotEqual(V.RAM_ROOT, ORIGINAL.RAM_ROOT)

    def test_payload_differences_are_only_nonce_null_swappiness_and_volume_false_omission(self):
        expected = ORIGINAL.source_payload()
        expected["Labels"] = copy.deepcopy(V.LABELS)
        expected["HostConfig"]["MemorySwappiness"] = None
        volume, bind = expected["HostConfig"]["Mounts"]
        volume["Source"] = V.VOLUME
        del volume["ReadOnly"]
        bind["Source"] = V.RAM_ROOT + "/config.json"
        self.assertEqual(V.source_payload(), expected)
        self.assertEqual(V.source_payload()["HostConfig"]["Memory"], 67108864)
        self.assertEqual(V.source_payload()["HostConfig"]["MemorySwap"], 67108864)
        self.assertEqual(V.source_payload()["HostConfig"]["NanoCpus"], 100000000)
        self.assertEqual(V.source_payload()["HostConfig"]["PidsLimit"], 16)

    def test_explicit_null_swappiness_is_required_before_io(self):
        V.validate_create_payload(V.source_payload())
        for value in ("absent", 0, -1, 50, False, True, "0", "null", []):
            with self.subTest(value=value):
                payload = V.source_payload()
                if value == "absent":
                    del payload["HostConfig"]["MemorySwappiness"]
                else:
                    payload["HostConfig"]["MemorySwappiness"] = value
                with self.assertRaises(V.Stop):
                    V.validate_create_payload(payload)
                transport = V.FixtureEngine(armed=True, expected_daemon=LEGACY.DAEMON)
                with self.assertRaises(V.Stop):
                    transport.permit_body(V.NAMES[0], payload)
                self.assertEqual(transport.calls, 0)

    def test_volume_readonly_omission_or_false_only_and_bind_stays_readonly(self):
        for value in (None, False):
            payload = V.source_payload()
            if value is False:
                payload["HostConfig"]["Mounts"][0]["ReadOnly"] = False
            V.validate_create_payload(payload)
        for index, values in ((0, (True, None, 0, "false")), (1, (False, None, 0, "true", "absent"))):
            for value in values:
                with self.subTest(index=index, value=value):
                    payload = V.source_payload()
                    declaration = payload["HostConfig"]["Mounts"][index]
                    if value == "absent":
                        del declaration["ReadOnly"]
                    else:
                        declaration["ReadOnly"] = value
                    with self.assertRaises(V.Stop):
                        V.validate_create_payload(payload)

    def test_wrong_or_missing_cgroup_version_stops_before_files_or_creates(self):
        for value in (None, "1", 2, "", "future"):
            engine = FakeEngine()
            engine.cgroup_version = value
            probe, _, evidence = self.candidate(engine)
            with self.assertRaisesRegex(V.Stop, "cgroup version"):
                probe.run()
            self.assertFalse(evidence.opened)
            self.assertEqual(engine.mutations, [])

    def test_observed_omitted_false_mount_defaults_reconstruct_and_compare_in_full(self):
        engine = FakeEngine()
        def serialized_defaults(item, index):
            self.assertIsNone(item["HostConfig"]["MemorySwappiness"])
            self.assertNotIn("ReadOnly", item["HostConfig"]["Mounts"][0])
            item["HostConfig"]["Mounts"][1]["BindOptions"].pop("CreateMountpoint", None)
        engine.created_change = serialized_defaults
        probe, _, evidence = self.candidate(engine)
        result = probe.run()
        self.assertTrue(result["cleanup_verified"])
        a, b = (evidence.files["container-" + str(index) + "-confirmed.json"] for index in (0, 1))
        self.assertEqual(V.invariants(a), V.invariants(b))
        self.assertIsNone(a["HostConfig"]["MemorySwappiness"])
        self.assertEqual(engine.bodies[V.NAMES[1]]["HostConfig"], a["HostConfig"])

    def test_swappiness_drift_after_create_is_not_coerced(self):
        for changed_index in (0, 1):
            engine = FakeEngine()
            def drift(item, index):
                if index == changed_index:
                    item["HostConfig"]["MemorySwappiness"] = 0
            engine.created_change = drift
            probe, _, evidence = self.candidate(engine)
            with self.assertRaises(V.Stop):
                probe.run()
            self.assertEqual(len(engine.containers), changed_index + 1)
            self.assertFalse(evidence.cleaned)

    def test_effectively_equal_b_mount_representation_still_fails_full_comparison(self):
        engine = FakeEngine()
        def drift(item, index):
            if index == 1:
                item["HostConfig"]["Mounts"][0]["ReadOnly"] = False
        engine.created_change = drift
        probe, _, evidence = self.candidate(engine)
        with self.assertRaisesRegex(V.Stop, "representation mismatch"):
            probe.run()
        self.assertEqual(evidence.files["mismatch.json"]["fields"], ["HostConfig"])
        self.assertFalse(evidence.cleaned)

    def test_every_warning_still_stops_without_interpreting_or_allowlisting_text(self):
        for warning in ("synthetic unknown warning", "synthetic swappiness warning", ""):
            engine = FakeEngine()
            engine.warnings = [warning]
            probe, _, evidence = self.candidate(engine)
            with self.assertRaisesRegex(V.Stop, "create warnings"):
                probe.run()
            self.assertEqual(len(engine.containers), 1)
            self.assertFalse(evidence.cleaned)


def load_tests(loader, tests, pattern):
    tests.addTests(loader.loadTestsFromModule(LEGACY))
    return tests


if __name__ == "__main__":
    unittest.main()
