"""Offline mutation-boundary tests; all credentials and state are synthetic."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("activation", Path(__file__).with_name("activate-kimi-zcode.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class FakeAPI:
    def __init__(self):
        self.root = "existing:" + "r" * 43
        self.hub = json.dumps([{"id": "clutch.mac", "platform": "clutch", "token": "h" * 43}])
        self.state = {"/": {M.ROOT_MAP: self.root}, "/telemetry": {M.HUB_MAP: self.hub}}
        self.writes = []
        self.verify_count = 0
        self.before_verify = None
        self.fail_step = None
        self.corrupt_step = None

    def verify(self):
        self.verify_count += 1
        if self.before_verify:
            self.before_verify(self)

    def read(self, path, name=None):
        return set(self.state[path]) if name is None else self.state[path][name]

    def write(self, path, name, value, create):
        index = len(self.writes)
        self.writes.append((path, name, value, create))
        if self.fail_step == index:
            raise M.Stop("write outcome unknown; reconcile, never retry")
        self.state[path][name] = "corrupt" if self.corrupt_step == index else value


def manifest(api):
    return {"project": "fake-project", "grants": {
        key: {"path": "/fake/private/" + key, "id": "fake-id-" + key,
              "name": "um-" + key.replace("root", "runtime").replace("_", "-"),
              "expiresAt": "2099-01-01T00:00:00Z"}
        for key in ("root_read", "root_write", "telemetry_read", "telemetry_write")},
        "root_sha256": M.digest(api.root), "hub_sha256": M.digest(api.hub),
        "root_members": ["existing"], "hub_members": ["clutch.mac"],
        "custody_path": "/fake/private/generated.json", "receipt_prefix": "/fake/private/receipt",
        "reservation_receipts": [{"topic": topic, "receipt": "offline-test-only", "acknowledged": True} for topic in ("AFC-600", "Clutch")]}


class ReceiverContractTests(unittest.TestCase):
    def test_receiver_capacity_matches_receiver(self):
        # Parity guard: the controller's RECEIVER_MAX_SOURCES must equal the
        # receiver's own .max(N) in parseReceiverSources.
        receiver = Path(__file__).with_name("otlp-receiver.mjs").read_text()
        import re
        match = re.search(r"\.min\(1\)\.max\((\d+)\)", receiver)
        self.assertIsNotNone(match, "receiver source-capacity bound not found")
        self.assertEqual(int(match.group(1)), M.RECEIVER_MAX_SOURCES)


class ControllerTests(unittest.TestCase):
    def run_controller(self, api, plan=None, factory=None):
        files = {}
        def write(path, value):
            if path in files:
                raise M.Stop("prior custody exists")
            files[path] = value
        values = iter(character * 43 for character in "abcd")
        result = M.execute(plan or manifest(api), api, writer=write, reader=files.__getitem__,
                           factory=factory or (lambda: next(values)))
        return result, files

    def test_complete_preserves_every_existing_member_and_separates_tokens(self):
        api = FakeAPI()
        result, files = self.run_controller(api)
        self.assertEqual(result["status"], "canonical_read_back")
        self.assertEqual(len(api.writes), 6)
        self.assertTrue(api.state["/"][M.ROOT_MAP].startswith(api.root + ","))
        sources = json.loads(api.state["/telemetry"][M.HUB_MAP])
        self.assertEqual(sources[0], json.loads(api.hub)[0])
        self.assertEqual([item["id"] for item in sources], ["clutch.mac", "kimi-code", "zcode"])
        for key in M.KEYS:
            self.assertIn(key, api.state["/"])
            self.assertNotIn(key, api.state["/telemetry"])
        self.assertEqual(len(set(json.loads(files["/fake/private/generated.json"]).values())), 4)
        self.assertFalse(result["mounted_config_changed"])
        self.assertFalse(result["restart_performed"])

    def test_changed_baseline_refuses_before_custody_and_remote_writes(self):
        api = FakeAPI()
        plan = manifest(api)
        plan["hub_sha256"] = "0" * 64
        with self.assertRaisesRegex(M.Stop, "baseline"):
            self.run_controller(api, plan)
        self.assertEqual(api.writes, [])

    def test_unacknowledged_reservation_refuses_before_credentials_or_generation(self):
        api = FakeAPI()
        plan = manifest(api)
        plan["reservation_receipts"][1]["acknowledged"] = False
        with self.assertRaisesRegex(M.Stop, "acknowledgment missing"):
            self.run_controller(api, plan)
        self.assertEqual(api.verify_count, 0)
        self.assertEqual(api.writes, [])

    def test_any_existing_requested_key_refuses_partial_run(self):
        for scope in ("/", "/telemetry"):
            api = FakeAPI()
            api.state[scope][M.KEYS[0]] = "previous"
            with self.assertRaisesRegex(M.Stop, "already exists"):
                self.run_controller(api)
            self.assertEqual(api.writes, [])

    def test_collision_refuses_before_remote_write(self):
        api = FakeAPI()
        with self.assertRaisesRegex(M.Stop, "collision"):
            self.run_controller(api, factory=lambda: "x" * 43)
        self.assertEqual(api.writes, [])

    def test_changed_reservation_stops_before_first_remote_write(self):
        api = FakeAPI()
        def mutate(current):
            if current.verify_count == 2:
                current.state["/telemetry"]["COMPETING_NAME"] = "value"
        api.before_verify = mutate
        with self.assertRaisesRegex(M.Stop, "compare-before-write"):
            self.run_controller(api)
        self.assertEqual(api.writes, [])

    def test_every_unknown_write_stops_without_retry_or_rollback(self):
        for index in range(6):
            api = FakeAPI()
            api.fail_step = index
            with self.assertRaisesRegex(M.Stop, "unknown"):
                self.run_controller(api)
            self.assertEqual(len(api.writes), index + 1)

    def test_every_bad_readback_stops_without_later_write(self):
        for index in range(6):
            api = FakeAPI()
            api.corrupt_step = index
            with self.assertRaisesRegex(M.Stop, "readback mismatch"):
                self.run_controller(api)
            self.assertEqual(len(api.writes), index + 1)

    def test_created_key_mutation_blocks_next_write(self):
        api = FakeAPI()
        def mutate(current):
            if current.verify_count == 3:
                current.state["/"][M.KEYS[0]] = "changed"
        api.before_verify = mutate
        with self.assertRaisesRegex(M.Stop, "created key changed"):
            self.run_controller(api)
        self.assertEqual(len(api.writes), 1)

    def test_duplicate_json_and_missing_clutch_refused(self):
        with self.assertRaisesRegex(M.Stop, "duplicate"):
            M.decode('{"id":1,"id":2}')
        with self.assertRaisesRegex(M.Stop, "clutch.mac"):
            M.maps("old:" + "r" * 43, "[]")

    def test_exclusive_private_custody_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "token")
            M.exclusive_write(path, "synthetic")
            self.assertEqual(M.private_read(path), "synthetic")
            with self.assertRaises(FileExistsError):
                M.exclusive_write(path, "replacement")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                M.private_read(str(link))

    def test_exact_grant_scope_expiry_identity_and_permissions_are_enforced(self):
        plan = manifest(FakeAPI())
        for mutation in (lambda data: data.update(scopes=[{"environment": "prod", "secretPath": "/**"}]),
                         lambda data: data.update(permissions=["read", "write"]),
                         lambda data: data.update(id="other"),
                         lambda data: data.update(expiresAt="2000-01-01T00:00:00Z")):
            api = object.__new__(M.API)
            api.manifest = plan
            api.tokens = {key: "synthetic" for key in plan["grants"]}
            def request(method, path, key):
                spec = plan["grants"][key]
                data = {"id": spec["id"], "name": spec["name"], "expiresAt": spec["expiresAt"],
                        "projectId": plan["project"], "workspace": plan["project"],
                        "scopes": [{"environment": "prod", "secretPath": "/" if key.startswith("root") else "/telemetry"}],
                        "permissions": [key.split("_")[1]]}
                mutation(data)
                return data
            api.request = request
            with patch.object(M, "private_read", return_value="synthetic"):
                with self.assertRaisesRegex(M.Stop, "metadata mismatch"):
                    api.verify()

    def test_default_cli_plan_never_constructs_api_or_generates_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "manifest.json"
            plan.write_text(json.dumps(manifest(FakeAPI())))
            with patch.object(M.sys, "argv", ["controller", "--manifest", str(plan)]), patch.object(M, "API") as api, patch.object(M, "execute") as execute, patch("builtins.print"):
                M.main()
                api.assert_not_called()
                execute.assert_not_called()

    def test_unreviewed_execute_does_not_consume_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / "manifest.json"
            plan.write_text(json.dumps(manifest(FakeAPI())))
            with patch.object(M.sys, "argv", ["controller", "--manifest", str(plan), "--execute"]), patch.object(M, "API") as api, patch("builtins.print"):
                with self.assertRaises(SystemExit):
                    M.main()
                api.assert_not_called()

    def test_exact_manifest_without_reservation_ack_does_not_consume_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            plan = manifest(FakeAPI())
            plan["reservation_receipts"][1]["acknowledged"] = False
            raw = json.dumps(plan)
            path.write_text(raw)
            with patch.object(M.sys, "argv", ["controller", "--manifest", str(path), "--execute", "--reviewed-manifest-sha256", M.digest(raw)]), patch.object(M, "API") as api, patch("builtins.print"):
                with self.assertRaises(SystemExit):
                    M.main()
                api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
