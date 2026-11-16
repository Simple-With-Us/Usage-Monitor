"""Offline mounted-snapshot activation tests; no Docker operation runs."""
import importlib.util
import contextlib
import io
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mounted", Path(__file__).with_name("sync-mounted-sources.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class Backend:
    def __init__(self):
        self.calls = []
        self.raw = None
        self.fail = None
        self.after = {"device": 1, "logical_end": 120, "offset": 100, "dead_letter_bytes": 0}
        self.count = 0

    def step(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise M.Stop("unknown outcome")

    def preflight(self):
        self.step("preflight")

    def stop(self):
        self.step("stop")

    def journal(self):
        self.step("journal")
        self.count += 1
        return {"device": 1, "logical_end": 100, "offset": 90, "dead_letter_bytes": 0} if self.count == 1 else self.after

    def recreate(self):
        self.step("recreate")

    def mounted(self):
        self.step("mounted")
        return self.raw


def fixture():
    old_sources = [{"id": "old", "platform": "old", "token": "r" * 43}]
    new_sources = old_sources + [{"id": name, "platform": name, "token": name + "a" * 43} for name in ("clutch.mac", "kimi-code", "zcode")]
    old_map, new_map = json.dumps(old_sources), json.dumps(new_sources)
    raw = json.dumps({"SENTRY_OTLP_ENDPOINT": "https://fake.invalid/otlp", "SENTRY_PUBLIC_KEY": "fake-public", M.C.HUB_MAP: old_map})
    manifest = {"snapshot_path": "/fake/config.json", "canonical_map_path": "/fake/canonical", "old_snapshot_sha256": M.C.digest(raw),
                "old_map_sha256": M.C.digest(old_map), "new_map_sha256": M.C.digest(new_map),
                "new_members": [row["id"] for row in new_sources], "receipt_prefix": "/fake/receipt"}
    return manifest, raw, new_map


class DigestOnlyMountedTests(unittest.TestCase):
    """The container must emit only the mounted file's digest, never the raw secret."""

    RAW = json.dumps({"SENTRY_OTLP_ENDPOINT": "https://fake.invalid/otlp",
                      "SENTRY_PUBLIC_KEY": "fake-public", M.C.HUB_MAP: "[]"})

    def make_backend(self, remote):
        backend = M.DockerCompose({"snapshot_path": "/fake/config.json"})
        backend.inspect = lambda: "fake-container"
        calls = []
        def command(args):
            calls.append(args)
            return remote
        backend.command = command
        return backend, calls

    def patched_snapshot(self, raw):
        old = M.read_snapshot
        M.read_snapshot = lambda path: raw
        self.addCleanup(setattr, M, "read_snapshot", old)

    def test_digest_match_returns_host_snapshot_without_raw_stdout(self):
        self.patched_snapshot(self.RAW)
        remote = M.C.digest(self.RAW)
        backend, calls = self.make_backend(remote)
        self.assertEqual(backend.mounted(), self.RAW)
        self.assertEqual(calls[0][:3], ["docker", "exec", "fake-container"])
        program = calls[0][-1]
        self.assertIn("node:crypto", program)
        self.assertIn(".digest('hex')", program)
        # Per-argument check: json.dumps would escape RAW's quotes and vacuously pass.
        for call in calls:
            for arg in call:
                self.assertNotIn(self.RAW, arg)
        # The per-argument check above proves the raw snapshot never reaches argv;
        # asserting on `remote` here would only re-check this test's own digest of
        # the fixture, not anything the backend emitted.

    def test_digest_mismatch_stops(self):
        self.patched_snapshot(self.RAW)
        backend, calls = self.make_backend("0" * 64)
        with self.assertRaises(M.Stop) as caught:
            backend.mounted()
        self.assertIn("differ", str(caught.exception))

    def test_preflight_relies_on_digest_check(self):
        self.patched_snapshot(self.RAW)
        with tempfile.TemporaryDirectory() as tmp:
            compose = Path(tmp) / "compose.yml"
            compose.write_text("services: {}")
            inspect_item = [{"Config": {"Labels": {
                "com.docker.compose.project.config_files": str(compose),
                "com.docker.compose.project.working_dir": tmp}}}]
            backend, calls = self.make_backend(None)
            backend.command = lambda args: (json.dumps(inspect_item) if args[1] == "inspect"
                                            else M.C.digest(self.RAW))
            backend.m = {"snapshot_path": "/fake/config.json", "compose_file": str(compose),
                         "compose_sha256": M.C.digest(compose.read_text()), "compose_directory": tmp}
            self.assertIsNone(backend.preflight())
            backend.command = lambda args: (json.dumps(inspect_item) if args[1] == "inspect"
                                            else "0" * 64)
            with self.assertRaises(M.Stop):
                backend.preflight()


class MountedTests(unittest.TestCase):
    def invariant_fixture(self):
        return {"Config": {"Hostname": "generated", "Image": "mutable-tag", "Labels": {"one": "two"}},
                "HostConfig": {"Mounts": [{"Target": "/z", "Type": "volume", "Source": "journal"}], "Future": ["keep", "order"]},
                "Image": "sha256:" + "a" * 64,
                "Mounts": [{"Destination": "/z", "Type": "volume", "Name": "journal", "Source": "/volume", "RW": True,
                            "Mode": "rw", "Driver": "local", "Propagation": "", "Future": {"values": [1, 2]}},
                           {"Destination": "/a", "Type": "bind", "Source": "/snapshot", "RW": False, "Mode": "ro",
                            "Propagation": "rprivate", "Future": {"values": [3, 4]}}]}

    def test_inspect_mount_reordering_is_equal_without_mutating_or_dropping_fields(self):
        inspected = self.invariant_fixture()
        before = json.loads(json.dumps(inspected))
        reordered = json.loads(json.dumps(inspected))
        reordered["Mounts"].reverse()
        left, right = M.resolved_invariants(inspected), M.resolved_invariants(reordered)
        self.assertEqual(left, right)
        self.assertEqual([row["Destination"] for row in left["Mounts"]], ["/a", "/z"])
        self.assertEqual(left["Mounts"], sorted(before["Mounts"], key=lambda row: row["Destination"]))
        self.assertEqual(left["HostConfig"], before["HostConfig"])
        self.assertEqual(inspected, before)
        left["Mounts"][0]["Future"]["values"].append(5)
        self.assertEqual(inspected, before)

    def test_inspect_normalization_retains_every_mount_field_and_nested_value(self):
        original = self.invariant_fixture()
        for key, value in {"Destination": "/different", "Type": "bind", "Name": "other", "Source": "/other",
                           "RW": False, "Mode": "rw,nocopy", "Driver": "other", "Propagation": "rprivate",
                           "Future": {"values": [2, 1]}, "Unknown": None}.items():
            with self.subTest(field=key):
                changed = json.loads(json.dumps(original))
                changed["Mounts"][0][key] = value
                changed["Mounts"].reverse()
                self.assertNotEqual(M.resolved_invariants(original), M.resolved_invariants(changed))
        changed = json.loads(json.dumps(original))
        del changed["Mounts"][0]["Driver"]
        self.assertNotEqual(M.resolved_invariants(original), M.resolved_invariants(changed))

    def test_duplicate_or_malformed_inspect_destinations_are_rejected(self):
        for mounts in (None, {}, [None], ["mount"], [{}], [{"Destination": ""}], [{"Destination": "relative"}],
                       [{"Destination": "/bad\x00path"}], [{"Destination": "/data"}, {"Destination": "/data"}]):
            inspected = self.invariant_fixture()
            inspected["Mounts"] = mounts
            with self.subTest(mounts=mounts), self.assertRaises(M.Stop):
                M.resolved_invariants(inspected)

    def run_controller(self, backend, manifest=None, corrupt_mount=False, fail_replace=False):
        plan, raw, new_map = fixture()
        files = {}
        def write(path, value):
            if path in files:
                raise M.Stop("prior receipt exists")
            files[path] = value
        def replace(path, before, after):
            backend.step("replace")
            self.assertEqual(before, raw)
            if fail_replace:
                raise M.Stop("compare changed")
            backend.raw = "old-inode" if corrupt_mount else after
        result = M.execute(manifest or plan, backend, read=lambda path: raw, source_read=lambda path: new_map,
                           write=write, replace=replace, backup_read=files.__getitem__)
        return result, files

    def test_complete_preserves_other_snapshot_fields_and_all_members(self):
        backend = Backend()
        result, files = self.run_controller(backend)
        self.assertEqual(result["status"], "mounted_snapshot_verified")
        _, raw, _ = fixture()
        before, after = json.loads(raw), json.loads(backend.raw)
        for key in M.FIELDS - {M.C.HUB_MAP}:
            self.assertEqual(before[key], after[key])
        self.assertEqual(files["/fake/receipt.backup.json"], raw)
        self.assertEqual(backend.calls, ["preflight", "stop", "journal", "replace", "recreate", "mounted", "journal"])

    def test_old_baseline_drift_stops_before_backend(self):
        plan, _, _ = fixture()
        plan["old_snapshot_sha256"] = "changed"
        backend = Backend()
        with self.assertRaisesRegex(M.Stop, "baseline"):
            self.run_controller(backend, plan)
        self.assertEqual(backend.calls, [])

    def test_existing_member_change_or_removal_refused(self):
        plan, raw, new_map = fixture()
        rows = json.loads(new_map)
        rows[0]["token"] = "x" * 43
        changed = json.dumps(rows)
        plan["new_map_sha256"] = M.C.digest(changed)
        with self.assertRaisesRegex(M.Stop, "existing member"):
            M.replacement(raw, changed, plan)

    def test_actual_old_bind_inode_readback_blocks_success(self):
        with self.assertRaisesRegex(M.Stop, "in-container"):
            self.run_controller(Backend(), corrupt_mount=True)

    def test_post_replacement_digest_stop_keeps_no_rollback_instruction(self):
        class DigestStopBackend(Backend):
            def mounted(self):
                self.step("mounted")
                raise M.Stop("host and running mounted snapshots differ")
        with self.assertRaisesRegex(M.Stop, "reconcile without rollback"):
            self.run_controller(DigestStopBackend())

    def test_post_replacement_command_failure_keeps_no_rollback_guidance(self):
        class CommandStopBackend(Backend):
            def mounted(self):
                self.step("mounted")
                raise M.Stop("Docker operation refused or outcome unknown; reconcile private receipts")
        with self.assertRaises(M.Stop) as caught:
            self.run_controller(CommandStopBackend())
        message = str(caught.exception)
        # Non-digest failures are relabeled as an unverified readback (not a content
        # mismatch) but MUST keep the no-rollback guidance and the original cause,
        # because the snapshot is already replaced and rollback would fork custody.
        self.assertIn("post-replacement readback unverified", message)
        self.assertIn("reconcile without rollback", message)
        self.assertIn("reconcile private receipts", message)
        self.assertNotIn("readback differs", message)

    def test_compare_failure_does_not_recreate(self):
        backend = Backend()
        with self.assertRaisesRegex(M.Stop, "compare"):
            self.run_controller(backend, fail_replace=True)
        self.assertNotIn("recreate", backend.calls)

    def test_every_unknown_phase_stops_without_retry(self):
        for phase in ("preflight", "stop", "journal", "replace", "recreate", "mounted"):
            backend = Backend()
            backend.fail = phase
            with self.assertRaisesRegex(M.Stop, "unknown"):
                self.run_controller(backend)
            self.assertEqual(backend.calls.count(phase), 1)

    def test_journal_offset_end_or_volume_device_regression_refused(self):
        for change in ({"offset": 80}, {"logical_end": 90}, {"device": 2}, {"dead_letter_bytes": 1}):
            backend = Backend()
            backend.after.update(change)
            with self.assertRaisesRegex(M.Stop, "journal continuity"):
                self.run_controller(backend)

    def test_duplicate_json_snapshot_fields_refused(self):
        with self.assertRaisesRegex(M.Stop, "duplicate"):
            M.snapshot('{"SENTRY_PUBLIC_KEY":"one","SENTRY_PUBLIC_KEY":"two"}')

    def test_live_stop_and_recreate_refuse_without_any_docker_call(self):
        backend = M.DockerCompose({"compose_directory": "/reviewed", "compose_project": "existing",
                                  "compose_file": "/reviewed/compose.yaml", "compose_service": "telemetry-hub", "compose_sha256": M.C.digest("fake")})
        with patch.object(backend, "command", return_value="") as command, patch.object(backend, "inspect"), patch.object(M.Path, "read_text", return_value="fake"):
            with self.assertRaisesRegex(M.Stop, "unimplemented"):
                backend.recreate()
            with self.assertRaisesRegex(M.Stop, "unavailable"):
                backend.stop()
            command.assert_not_called()

    def test_matching_reviewed_manifest_cannot_release_live_cli(self):
        plan, _, _ = fixture()
        plan.update(compose_directory="/fake", compose_project="existing", compose_file="/fake/compose.yaml",
                    compose_service="telemetry-hub", compose_sha256="a" * 64,
                    container_invariants_sha256="b" * 64, image_id="sha256:" + "c" * 64, journal_path="/fake/journal")
        raw, errors = json.dumps(plan), io.StringIO()
        argv = ["sync-mounted-sources.py", "--manifest", "/fake/manifest", "--execute", "--reviewed-manifest-sha256", M.C.digest(raw)]
        with patch.object(M.sys, "argv", argv), patch.object(M.Path, "read_text", return_value=raw), \
                patch.object(M, "DockerCompose") as backend, patch.object(M, "read_snapshot") as read, \
                patch.object(M.C, "private_read") as credential, contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as stopped:
                M.main()
            self.assertEqual(stopped.exception.code, 2)
            self.assertIn("live mounted execution unavailable", errors.getvalue())
            backend.assert_not_called()
            read.assert_not_called()
            credential.assert_not_called()

    def test_offline_engine_payload_pins_resolved_image_and_preserves_configuration(self):
        inspected = {"Config": {"Image": "mutable-tag", "Hostname": "old-container", "User": "10001:10001",
                                "Env": ["NODE_ENV=production", "TELEMETRY_HUB_CONFIG_FILE=/run/secrets/telemetry-hub.json"]},
                     "HostConfig": {"NetworkMode": "host", "ReadonlyRootfs": True, "Binds": ["named-data:/data", "/private/config:/run/secrets/telemetry-hub.json:ro"]},
                     "Mounts": [{"Destination": "/data", "Name": "named-data", "Type": "volume", "RW": True},
                                {"Destination": "/run/secrets/telemetry-hub.json", "Source": "/private/config", "Type": "bind", "RW": False}],
                     "Image": "sha256:" + "a" * 64}
        payload = M.pinned_create_payload(inspected)
        self.assertEqual(payload["Image"], inspected["Image"])
        self.assertEqual(payload["Env"], inspected["Config"]["Env"])
        self.assertEqual(payload["HostConfig"], inspected["HostConfig"])
        self.assertEqual(inspected["Config"]["Image"], "mutable-tag")
        created = json.loads(json.dumps(inspected))
        created["Config"]["Image"] = inspected["Image"]
        created["Config"]["Hostname"] = "new-container"
        self.assertEqual(M.resolved_invariants(inspected), M.resolved_invariants(created))
        inspected["Config"]["Env"].append("SENTRY_AUTH_TOKEN=synthetic-not-authorized-for-recovery")
        with self.assertRaisesRegex(M.Stop, "credential-shaped"):
            M.pinned_create_payload(inspected)
        inspected["Config"]["Env"][-1] = "sentry_auth_token=synthetic"
        with self.assertRaisesRegex(M.Stop, "credential-shaped"):
            M.pinned_create_payload(inspected)
        inspected["Config"]["Env"].pop()
        inspected["HostConfig"]["Binds"] = ["/private/config:/run/secrets/telemetry-hub.json:ro"]
        inspected["Config"]["Volumes"] = {"/data": {}}
        with self.assertRaisesRegex(M.Stop, "declarations differ"):
            M.pinned_create_payload(inspected)

    def test_payload_requires_exact_mount_types_and_complete_declarations(self):
        inspected = {"Config": {"Image": "tag", "User": "10001:10001", "Env": []},
                     "HostConfig": {"NetworkMode": "host", "ReadonlyRootfs": True, "Mounts": [
                         {"Type": "volume", "Source": "journal", "Target": "/data"},
                         {"Type": "bind", "Source": "/private/config", "Target": "/run/secrets/telemetry-hub.json", "ReadOnly": True}]},
                     "Mounts": [{"Destination": "/data", "Name": "journal", "Type": "volume", "RW": True},
                                {"Destination": "/run/secrets/telemetry-hub.json", "Source": "/private/config", "Type": "bind", "RW": False}],
                     "Image": "sha256:" + "a" * 64}
        self.assertEqual(M.pinned_create_payload(inspected)["HostConfig"], inspected["HostConfig"])
        for mutate in (
                lambda item: item["HostConfig"]["Mounts"].append({"Type": "bind", "Source": "/private/extra", "Target": "/extra"}),
                lambda item: item["Mounts"].append(dict(item["Mounts"][0])),
                lambda item: item["HostConfig"]["Mounts"][0].update(Type="bind")):
            changed = json.loads(json.dumps(inspected))
            mutate(changed)
            with self.assertRaisesRegex(M.Stop, "mount"):
                M.pinned_create_payload(changed)

    @unittest.skipUnless(os.geteuid() == 0, "fixture must assign existing container UID")
    def test_real_atomic_snapshot_replace_preserves_uid_gid_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text("old synthetic snapshot")
            path.chmod(0o600)
            os.chown(path, 10001, 10001)
            M.atomic_replace(str(path), "old synthetic snapshot", "new synthetic snapshot")
            self.assertEqual(M.read_snapshot(str(path)), "new synthetic snapshot")
            info = path.stat()
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (10001, 10001, 0o600))

    @unittest.skipUnless(os.geteuid() == 0, "fixture must assign existing container UID")
    def test_real_atomic_snapshot_compare_refuses_drift_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text("competing snapshot")
            path.chmod(0o600)
            os.chown(path, 10001, 10001)
            with self.assertRaisesRegex(M.Stop, "compare"):
                M.atomic_replace(str(path), "reviewed old snapshot", "new snapshot")
            self.assertEqual(path.read_text(), "competing snapshot")
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                M.read_snapshot(str(link))


if __name__ == "__main__":
    unittest.main()
