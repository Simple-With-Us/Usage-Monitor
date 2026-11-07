"""Offline cleanup faults; never construct the actual Engine/RAM adapters."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("exact_cleanup_candidate", Path(__file__).with_name("cleanup.py"))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
P = C.reviewed_source()


class Engine:
    def __init__(self):
        self.containers, self.calls, self.mutations = {}, [], []
        self.volume = {"Name": P.VOLUME, "Driver": "local", "Labels": P.VOLUME_LABELS, "Options": P.VOLUME_OPTIONS,
                       "Mountpoint": "/synthetic/volume"}
        self.fail = None
        self.landed = False
        for identifier, name in zip((C.A, C.B), P.NAMES):
            payload = P.source_payload()
            config = {key: value for key, value in payload.items() if key != "HostConfig"}
            self.containers[identifier] = {"Id": identifier, "Name": "/" + name, "Image": P.IMAGE_ID, "Config": config,
                "HostConfig": payload["HostConfig"], "State": {"Running": False, "Status": "created", "Pid": 0},
                "Mounts": [{"Type": "volume", "Name": P.VOLUME, "Source": "/synthetic/volume", "Destination": "/data", "RW": True},
                           {"Type": "bind", "Source": P.RAM_ROOT + "/config.json", "Destination": P.SNAPSHOT_TARGET, "RW": False}]}

    def request(self, method, route):
        if route != "/info": self.calls.append(("GET", "/info"))
        self.calls.append((method, route))
        if method == "DELETE":
            self.mutations.append((method, route))
            if self.fail == len(self.mutations) and not self.landed:
                raise TimeoutError("synthetic unknown delete")
            if route.startswith("/containers/"):
                del self.containers[route.split("/")[2].split("?", 1)[0]]
            else:
                if self.containers: return 409, None
                self.volume = None
            if self.fail == len(self.mutations):
                raise TimeoutError("synthetic landed delete with lost response")
            return 204, None
        if route == "/info": return 200, {"ID": "synthetic-daemon", "CgroupVersion": "2"}
        if route == "/version": return 200, {"MinAPIVersion": "1.40", "ApiVersion": "1.55"}
        if route.startswith("/volumes/"): return (200, self.volume) if self.volume else (404, None)
        target = route.split("/")[2]
        value = self.containers.get(target)
        if value is None:
            value = next((value for value in self.containers.values() if value["Name"] == "/" + target), None)
        return (200, copy.deepcopy(value)) if value else (404, None)


class RAM:
    def __init__(self): self.checked, self.cleaned, self.fail = 0, False, None
    def check(self):
        self.checked += 1
        if self.fail == self.checked: raise P.Stop("synthetic RAM drift")
    def cleanup(self): self.cleaned = True


class Receipts:
    def __init__(self): self.values, self.opened, self.fail = {}, False, None
    def open(self): self.opened = True
    def write(self, name, value):
        if name == self.fail: raise P.Stop("synthetic receipt failure")
        if name in self.values: raise P.Stop("duplicate receipt")
        self.values[name] = copy.deepcopy(value)


class CleanupTests(unittest.TestCase):
    def candidate(self):
        try:
            manifest = json.loads((C.ROOT / "cleanup-manifest.json").read_bytes())
        except FileNotFoundError:
            raise unittest.SkipTest("private cleanup-manifest.json intentionally not mirrored; runnable only in the private review lane")
        manifest["daemon_sha256"] = hashlib.sha256(b"synthetic-daemon").hexdigest()
        engine, ram, receipts = Engine(), RAM(), Receipts()
        with patch.object(P, "DAEMON_SHA256", manifest["daemon_sha256"]):
            cleanup = C.Cleanup(P, manifest, engine, ram, receipts, clock=lambda: 0)
        return cleanup, engine, ram, receipts, manifest["daemon_sha256"]

    def execute_fake(self, cleanup, fingerprint):
        with patch.object(P, "DAEMON_SHA256", fingerprint):
            return cleanup.run()

    def test_complete_exact_nonforcing_order_and_request_bound(self):
        cleanup, engine, ram, receipts, fingerprint = self.candidate()
        result = self.execute_fake(cleanup, fingerprint)
        self.assertEqual(result["wire_requests"], 39)
        self.assertEqual(len(engine.calls), 39)
        self.assertEqual([route for _, route in engine.mutations], cleanup.deletes)
        self.assertTrue(all("force=false" in route for _, route in engine.mutations))
        self.assertTrue(ram.cleaned)
        self.assertEqual(engine.containers, {})
        self.assertIsNone(engine.volume)
        self.assertIn("complete", receipts.values)

    def test_every_unknown_delete_stops_without_retry_or_ram_cleanup(self):
        for index in range(1, 4):
            for landed in (False, True):
                cleanup, engine, ram, _, fingerprint = self.candidate()
                engine.fail, engine.landed = index, landed
                with self.assertRaises(Exception): self.execute_fake(cleanup, fingerprint)
                self.assertEqual(len(engine.mutations), index)
                self.assertFalse(ram.cleaned)
                with self.assertRaises(P.Stop): cleanup.run()
                self.assertEqual(len(engine.mutations), index)

    def test_ownership_or_running_state_drift_prevents_any_delete(self):
        for change in (lambda item: item["State"].update(Running=True),
                       lambda item: item["Config"]["Labels"].update(extra="unreviewed"),
                       lambda item: item.update(Image="sha256:" + "f" * 64)):
            cleanup, engine, ram, _, fingerprint = self.candidate()
            change(engine.containers[C.B])
            with self.assertRaises(P.Stop): self.execute_fake(cleanup, fingerprint)
            self.assertEqual(engine.mutations, [])
            self.assertFalse(ram.cleaned)

    def test_ram_drift_and_intent_failure_prevent_next_mutation(self):
        for check, expected_deletes in ((1, 0), (2, 0), (3, 1), (4, 2), (5, 3)):
            cleanup, engine, ram, _, fingerprint = self.candidate()
            ram.fail = check
            with self.assertRaises(P.Stop): self.execute_fake(cleanup, fingerprint)
            self.assertEqual(len(engine.mutations), expected_deletes)
            self.assertFalse(ram.cleaned)
        cleanup, engine, _, receipts, fingerprint = self.candidate()
        receipts.fail = "delete-0-intent"
        with self.assertRaises(P.Stop): self.execute_fake(cleanup, fingerprint)
        self.assertEqual(engine.mutations, [])

    def test_unlisted_route_refused_before_backend(self):
        cleanup, engine, _, _, _ = self.candidate()
        cleanup.deadline = 120
        for method, route in (("POST", "/volumes/create"), ("DELETE", "/volumes/foreign?force=false"),
                              ("DELETE", "/containers/" + C.A + "?force=true")):
            with self.assertRaises(P.Stop): cleanup.call(method, route)
        self.assertEqual(engine.calls, [])

    def test_default_and_unfenced_cli_construct_no_live_adapter(self):
        with patch.object(C.sys, "argv", ["cleanup.py"]), patch.object(C, "reviewed_source") as source, patch("builtins.print"):
            C.main()
            source.assert_not_called()
        with patch.object(C.sys, "argv", ["cleanup.py", "--execute"]), patch.object(C, "reviewed_source") as source, patch("builtins.print"):
            with self.assertRaises(SystemExit): C.main()
            source.assert_not_called()


if __name__ == "__main__":
    unittest.main()
