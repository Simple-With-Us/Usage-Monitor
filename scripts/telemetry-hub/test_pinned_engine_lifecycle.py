"""Fake Engine lifecycle, terminal outcomes and pre-start invariant tests."""
import copy
import importlib.util
from pathlib import Path
import unittest
import urllib.parse
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("engine_candidate", Path(__file__).with_name("pinned-engine-lifecycle.py"))
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)


class FakeEngine:
    def __init__(self):
        self.old_id, self.new_id = "a" * 64, "b" * 64
        self.old = {"Id": self.old_id, "Name": "/existing", "Image": "sha256:" + "c" * 64,
            "Config": {"Image": "old-tag", "Hostname": "old", "Domainname": "", "User": "10001:10001",
                       "AttachStdin": False, "AttachStdout": True, "AttachStderr": True, "Tty": False,
                       "OpenStdin": False, "StdinOnce": False, "Env": ["NODE_ENV=production"],
                       "Cmd": ["node", "otlp-receiver.mjs"], "Entrypoint": ["docker-entrypoint.sh"],
                       "WorkingDir": "/app", "Volumes": {"/data": {}},
                       "Labels": {"com.docker.compose.project": "project", "com.docker.compose.service": "telemetry-hub"},
                       "Healthcheck": {"Test": ["CMD", "node", "health.mjs"], "Interval": 30000000000,
                                       "Timeout": 5000000000, "StartPeriod": 10000000000, "Retries": 3}},
            "HostConfig": {"NetworkMode": "host", "ReadonlyRootfs": True,
                           "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
                           "LogConfig": {"Type": "json-file", "Config": {"max-size": "10m"}},
                           "SecurityOpt": ["no-new-privileges:true"], "CapDrop": ["ALL"], "Init": True,
                           "Memory": 268435456, "PidsLimit": 64, "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=16m"},
                           "Binds": ["existing-journal:/data:rw", "/private/snapshot:/run/secrets/telemetry-hub.json:ro"]},
            "Mounts": [{"Destination": "/data", "Name": "existing-journal", "Source": "/private/journal", "Type": "volume", "RW": True},
                       {"Destination": "/run/secrets/telemetry-hub.json", "Source": "/private/snapshot", "Type": "bind", "RW": False}],
            "State": {"Running": True, "Health": {"Status": "healthy"}}}
        self.containers = {self.old_id: self.old}
        self.volume = {"Name": "existing-journal", "Driver": "local", "Mountpoint": "/private/journal", "Labels": {}, "Options": None, "Scope": "local"}
        self.calls, self.mutations = [], []
        self.fail_method = None
        self.corrupt_new = False
        self.warnings = []
        self.health = "healthy"
        self.time = 0
        self.extra_container = False
        self.created_change = lambda inspected: None

    def manifest(self):
        return {"old_id": self.old_id, "old_name": "existing", "project": "project", "service": "telemetry-hub",
                "resolved_sha256": E.sha(E.M.resolved_invariants(self.old)), "payload_sha256": E.sha(E.M.pinned_create_payload(self.old)),
                "daemon_sha256": E.daemon_fingerprint("fake-daemon"), "volume_name": "existing-journal", "volume_sha256": E.sha(self.volume), "image_id": self.old["Image"]}

    def request(self, method, route, body=None):
        self.calls.append((method, route))
        path = route.removeprefix(E.PREFIX)
        if method != "GET":
            self.mutations.append((method, route))
            if self.fail_method == len(self.mutations):
                raise TimeoutError("synthetic unconfirmed mutation")
        if path == "/info": return 200, {"ID": "fake-daemon"}
        if path == "/version": return 200, {"MinAPIVersion": "1.40", "ApiVersion": "1.55"}
        if path.startswith("/images/"): return 200, {"Id": self.old["Image"]}
        if path.startswith("/volumes/"): return 200, copy.deepcopy(self.volume)
        if path.startswith("/containers/json?"):
            rows = [{"Id": identifier} for identifier in self.containers]
            return 200, rows + ([{"Id": "d" * 64}] if self.extra_container else [])
        if path.startswith("/containers/create?"):
            # Reconstruct inspect from the submitted create body, never the old inspect.
            config = copy.deepcopy({key: value for key, value in body.items() if key != "HostConfig"})
            config["Hostname"] = self.new_id[:12]
            host, mounts = copy.deepcopy(body["HostConfig"]), []
            for declaration in host.get("Binds", []):
                source, destination, mode = declaration.split(":")
                mount = {"Destination": destination, "Type": "bind" if source.startswith("/") else "volume", "RW": mode != "ro"}
                if mount["Type"] == "volume":
                    mount.update(Name=source, Source=self.volume["Mountpoint"])
                else:
                    mount["Source"] = source
                mounts.append(mount)
            new = {"Id": self.new_id, "Name": "/" + urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)["name"][0],
                   "Image": body["Image"], "Config": config, "HostConfig": host, "Mounts": mounts,
                   "State": {"Running": False, "Health": {"Status": "starting"}}}
            if self.corrupt_new:
                new["Config"]["Env"] = ["CHANGED_CONFIGURATION=1"]
            self.created_change(new)
            self.containers[self.new_id] = new
            return 201, {"Id": self.new_id, "Warnings": self.warnings}
        identifier = path.split("/")[2].split("?", 1)[0]
        if path.endswith("/json"):
            return 200, copy.deepcopy(self.containers[identifier])
        if "/stop?" in path:
            self.containers[identifier]["State"]["Running"] = False
            return 204, None
        if method == "DELETE":
            del self.containers[identifier]
            return 204, None
        if path.endswith("/start"):
            self.containers[identifier]["State"] = {"Running": True, "Health": {"Status": self.health}}
            return 204, None
        raise AssertionError("unexpected fake route")


class EngineTests(unittest.TestCase):
    def candidate(self, engine):
        receipts = []
        candidate = E.Lifecycle(engine.manifest(), engine, receipt=lambda phase, data: receipts.append((phase, data)),
            clock=lambda: engine.time, pause=lambda duration: setattr(engine, "time", engine.time + duration))
        return candidate, receipts

    def run_candidate(self, engine, **callbacks):
        candidate, receipts = self.candidate(engine)
        defaults = {"stopped_snapshot_transition": lambda: None, "before_start_verify": lambda: None, "after_start_verify": lambda: None}
        defaults.update(callbacks)
        return candidate.run(**defaults), receipts

    def test_single_attempt_order_and_no_volume_deletion_or_pull(self):
        engine = FakeEngine()
        result, receipts = self.run_candidate(engine)
        methods = [method for method, route in engine.mutations]
        self.assertEqual(methods, ["POST", "DELETE", "POST", "POST"])
        self.assertIn("v=false&force=false&link=false", engine.mutations[1][1])
        self.assertFalse(any("/volumes/" in path or "/images/" in path for _, path in engine.mutations))
        create_index = next(index for index, call in enumerate(engine.calls) if "/containers/create?" in call[1])
        start_index = next(index for index, call in enumerate(engine.calls) if call[1].endswith("/start"))
        self.assertTrue(any(path.endswith(engine.new_id + "/json") for _, path in engine.calls[create_index:start_index]))
        self.assertEqual(result["status"], "pinned-runtime-verified")
        self.assertEqual(receipts[-1][0], "09-complete")

    def test_every_unconfirmed_mutation_stops_without_retry_or_recovery(self):
        for index in range(1, 5):
            engine = FakeEngine()
            engine.fail_method = index
            with self.assertRaisesRegex(E.Stop, "outcome unavailable"):
                self.run_candidate(engine)
            self.assertEqual(len(engine.mutations), index)

    def test_changed_new_config_never_starts(self):
        engine = FakeEngine()
        engine.corrupt_new = True
        with self.assertRaisesRegex(E.Stop, "resolved configuration"):
            self.run_candidate(engine)
        self.assertFalse(any(route.endswith("/start") for _, route in engine.mutations))

    def test_fixed_api_payload_reconstruction_preserves_every_invariant(self):
        engine = FakeEngine()
        original = copy.deepcopy(engine.old)
        self.run_candidate(engine)
        created = engine.containers[engine.new_id]
        self.assertNotEqual(original["Config"]["Hostname"], created["Config"]["Hostname"])
        self.assertNotEqual(original["Config"]["Image"], created["Config"]["Image"])
        self.assertEqual(E.M.resolved_invariants(original), E.M.resolved_invariants(created))
        self.assertTrue(all(route.startswith("/v1.53/") for _, route in engine.calls))
        self.assertEqual(original["Config"]["Image"], "old-tag")

    def test_reordered_replacement_mounts_preserve_offline_lifecycle_equivalence(self):
        engine = FakeEngine()
        engine.created_change = lambda item: item["Mounts"].reverse()
        result, _ = self.run_candidate(engine)
        self.assertEqual(result["status"], "pinned-runtime-verified")
        self.assertEqual(len(engine.mutations), 4)

    def test_duplicate_mount_destination_blocks_before_stop_or_start(self):
        engine = FakeEngine()
        candidate, _ = self.candidate(engine)
        engine.old["Mounts"].append(copy.deepcopy(engine.old["Mounts"][0]))
        with self.assertRaisesRegex(E.Stop, "duplicate resolved"):
            candidate.run(stopped_snapshot_transition=lambda: None, before_start_verify=lambda: None, after_start_verify=lambda: None)
        self.assertEqual(engine.mutations, [])
        engine = FakeEngine()
        engine.created_change = lambda item: item["Mounts"].append(copy.deepcopy(item["Mounts"][0]))
        with self.assertRaisesRegex(E.Stop, "duplicate resolved"):
            self.run_candidate(engine)
        self.assertEqual(len(engine.mutations), 3)
        self.assertFalse(engine.containers[engine.new_id]["State"]["Running"])

    def test_each_config_host_mount_or_image_drift_blocks_before_start(self):
        changes = {
            "command": lambda item: item["Config"].update(Cmd=["other"]),
            "healthcheck": lambda item: item["Config"]["Healthcheck"].update(Retries=30),
            "labels": lambda item: item["Config"]["Labels"].update(extra="unexpected"),
            "restart": lambda item: item["HostConfig"]["RestartPolicy"].update(Name="always"),
            "security": lambda item: item["HostConfig"].update(SecurityOpt=[]),
            "memory": lambda item: item["HostConfig"].update(Memory=0),
            "daemon-default": lambda item: item["HostConfig"].update(UnexpectedDefault=True),
            "mount-source": lambda item: item["Mounts"][0].update(Source="/other/journal"),
            "mount-readonly": lambda item: item["Mounts"][1].update(RW=True),
            "image": lambda item: item.update(Image="sha256:" + "e" * 64),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                engine = FakeEngine()
                engine.created_change = change
                with self.assertRaisesRegex(E.Stop, "resolved configuration"):
                    self.run_candidate(engine)
                self.assertEqual(len(engine.mutations), 3)
                self.assertFalse(engine.containers[engine.new_id]["State"]["Running"])

    def test_wrong_created_inspect_identity_or_name_blocks_before_start(self):
        for change in (lambda item: item.update(Id="e" * 64), lambda item: item.update(Name="/other")):
            engine = FakeEngine()
            engine.created_change = change
            with self.assertRaisesRegex(E.Stop, "identity or reviewed name"):
                self.run_candidate(engine)
            self.assertEqual(len(engine.mutations), 3)

    def test_create_warning_never_starts_or_removes_new_container(self):
        engine = FakeEngine()
        engine.warnings = ["synthetic warning"]
        with self.assertRaisesRegex(E.Stop, "warnings"):
            self.run_candidate(engine)
        self.assertEqual(len(engine.mutations), 3)
        self.assertIn(engine.new_id, engine.containers)

    def test_competing_writer_blocks_before_stop(self):
        engine = FakeEngine()
        engine.extra_container = True
        with self.assertRaisesRegex(E.Stop, "exactly one"):
            self.run_candidate(engine)
        self.assertEqual(engine.mutations, [])

    def test_snapshot_transition_failure_leaves_old_stopped_and_preserved(self):
        engine = FakeEngine()
        def refuse(): raise E.Stop("snapshot drift")
        with self.assertRaisesRegex(E.Stop, "snapshot drift"):
            self.run_candidate(engine, stopped_snapshot_transition=refuse)
        self.assertEqual(len(engine.mutations), 1)
        self.assertIn(engine.old_id, engine.containers)
        self.assertFalse(engine.old["State"]["Running"])

    def test_prestart_callback_failure_preserves_stopped_replacement(self):
        engine = FakeEngine()
        def refuse(): raise E.Stop("snapshot or journal changed")
        with self.assertRaisesRegex(E.Stop, "snapshot or journal"):
            self.run_candidate(engine, before_start_verify=refuse)
        self.assertEqual(len(engine.mutations), 3)
        self.assertFalse(engine.containers[engine.new_id]["State"]["Running"])

    def test_health_wait_is_finite_and_never_restarts(self):
        engine = FakeEngine()
        engine.health = "starting"
        with self.assertRaisesRegex(E.Stop, "finite startup"):
            self.run_candidate(engine)
        self.assertEqual(engine.time, 60)
        self.assertEqual(len(engine.mutations), 4)

    def test_real_transport_refuses_every_mutation_before_socket_access(self):
        with patch.object(E, "UnixConnection") as connection:
            for method in ("POST", "DELETE", "PUT", "PATCH"):
                with self.assertRaisesRegex(E.Stop, "disabled"):
                    E.ReadOnlyEngine().request(method, E.PREFIX + "/containers/create", {})
            connection.assert_not_called()

    def test_old_json_encoded_daemon_fingerprint_is_not_accepted(self):
        engine = FakeEngine()
        manifest = engine.manifest()
        manifest["daemon_sha256"] = E.sha("fake-daemon")
        with self.assertRaisesRegex(E.Stop, "daemon identity"):
            E.Lifecycle(manifest, engine, receipt=lambda *args: None).preflight()
        self.assertEqual(engine.mutations, [])


if __name__ == "__main__":
    unittest.main()
