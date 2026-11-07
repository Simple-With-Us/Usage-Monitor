"""Offline fake-daemon tests; the fixed rehearsal scope is never opened or run."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("stopped_archive_fixture", Path(__file__).with_name("rehearse.py"))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


def tar_snapshot(version, uid=None):
    output = io.BytesIO()
    body = P.canonical(P.snapshot(version)).encode()
    with tarfile.open(fileobj=output, mode="w:", format=tarfile.USTAR_FORMAT) as tar:
        info = tarfile.TarInfo("telemetry-hub.json")
        info.uid = P.HOST_OWNER[0] if uid is None else uid
        info.gid, info.mode, info.size = P.HOST_OWNER[1], 0o600, len(body)
        tar.addfile(info, io.BytesIO(body))
    return output.getvalue()


class Evidence:
    def __init__(self):
        self.files, self.version = {}, "old"
        self.opened = self.cleaned = False

    def open(self):
        self.opened = True

    def write(self, name, data):
        if name in self.files:
            raise AssertionError("exclusive evidence repeated")
        self.files[name] = copy.deepcopy(data)

    def check(self):
        pass

    def replace_snapshot(self):
        self.version = "new"

    def cleanup(self):
        self.cleaned = True


class Engine:
    def __init__(self, evidence, *, after_swap="new"):
        self.evidence, self.after_swap = evidence, after_swap
        self.containers, self.volume_data, self.ids, self.bodies = {}, None, set(), {}
        self.calls, self.mutations = [], []
        self.failure = None
        self.warnings = []
        self.corrupt_b = False
        self.inspect_counts = {}
        self.inspect_change = lambda item, count: None

    def permit_body(self, name, body):
        P.validate_create_payload(body)
        self.bodies[name] = copy.deepcopy(body)

    def permit_container(self, identifier):
        self.ids.add(identifier)

    def request(self, method, path, body=None):
        if path != "/info":
            self.calls.append(("GET", "/info"))
        self.calls.append((method, path))
        if method != "GET":
            self.mutations.append((method, path))
            if self.failure == len(self.mutations):
                raise TimeoutError("synthetic unknown reply")
        if path == "/info": return 200, {"ID": "synthetic-daemon", "CgroupVersion": "2"}
        if path == "/version": return 200, {"MinAPIVersion": "1.40", "ApiVersion": "1.55"}
        if path.startswith("/images/"):
            return 200, {"Id": P.IMAGE_ID, "RepoDigests": [P.IMAGE_REFERENCE], "Config": {"Env": list(P.ENV[:-1])}}
        if path == "/volumes/create":
            self.volume_data = {"Name": P.VOLUME, "Driver": "local", "Labels": P.VOLUME_LABELS,
                                "Options": P.VOLUME_OPTIONS, "Mountpoint": "/synthetic/volume"}
            return 201, copy.deepcopy(self.volume_data)
        if path == "/volumes/" + P.VOLUME:
            return (200, copy.deepcopy(self.volume_data)) if self.volume_data else (404, None)
        if path == "/volumes/" + P.VOLUME + "?force=false":
            if self.containers: return 409, None
            self.volume_data = None
            return 204, None
        if path.startswith("/containers/create?"):
            name = path.split("=", 1)[1]
            index = P.NAMES.index(name)
            identifier = ("a" if index == 0 else "b") * 64
            config = copy.deepcopy({key: value for key, value in body.items() if key != "HostConfig"})
            config.setdefault("Hostname", identifier[:12])
            mounts = [{"Type": "volume", "Name": P.VOLUME, "Source": "/synthetic/volume", "Destination": "/data", "RW": True},
                      {"Type": "bind", "Source": P.RAM_ROOT + "/config.json", "Destination": P.SNAPSHOT_TARGET, "RW": False}]
            self.containers[identifier] = {"Id": identifier, "Name": "/" + name, "Image": P.IMAGE_ID, "Config": config,
                                          "HostConfig": copy.deepcopy(body["HostConfig"]), "Mounts": mounts,
                                          "State": {"Running": False, "Status": "created", "Pid": 0}}
            return 201, {"Id": identifier, "Warnings": self.warnings}
        if path.startswith("/containers/") and path.endswith(P.ARCHIVE_SUFFIX):
            identifier = path.split("/")[2]
            if identifier == "a" * 64:
                version = "old" if self.evidence.version == "old" else self.after_swap
            else:
                version = "old" if self.corrupt_b else "new"
            return 200, tar_snapshot(version)
        if path.startswith("/containers/") and path.endswith("/json"):
            target = path.split("/")[2]
            item = self.containers.get(target)
            if item is None:
                item = next((item for item in self.containers.values() if item["Name"] == "/" + target), None)
            if item:
                item = copy.deepcopy(item)
                identifier = item["Id"]
                count = self.inspect_counts.get(identifier, 0) + 1
                self.inspect_counts[identifier] = count
                self.inspect_change(item, count)
                return 200, item
            return 404, None
        if method == "DELETE" and path.startswith("/containers/"):
            identifier = path.split("/")[2].split("?", 1)[0]
            del self.containers[identifier]
            return 204, None
        raise AssertionError("unlisted fake route")


class FixtureTests(unittest.TestCase):
    def run_probe(self, **kwargs):
        evidence = Evidence()
        engine = Engine(evidence, **kwargs)
        probe = P.Probe(engine, evidence, P.DAEMON_SHA256)
        return probe, engine, evidence

    def execute_fake(self, probe):
        fingerprint = hashlib.sha256(b"synthetic-daemon").hexdigest()
        probe.expected_daemon = fingerprint
        with patch.object(P, "DAEMON_SHA256", fingerprint):
            return probe.run()

    def test_both_old_container_inode_outcomes_are_scoped_successes(self):
        for outcome in ("old", "new"):
            probe, engine, evidence = self.run_probe(after_swap=outcome)
            result = self.execute_fake(probe)
            self.assertEqual(result["archives"], ["old", outcome, "new"])
            self.assertFalse(result["started"])
            self.assertFalse(result["production_uid_custody_verified"])
            self.assertTrue(result["cleanup_verified"])
            self.assertEqual(len(engine.calls), 57)
            self.assertEqual(len(engine.mutations), 6)
            self.assertTrue(evidence.cleaned)
            self.assertFalse(any(any(value in route for value in ("/start", "/exec", "/stop", "/prune", "/networks")) for _, route in engine.calls))

    def test_each_unknown_mutation_stops_without_retry_or_cleanup(self):
        for index in range(1, 7):
            probe, engine, evidence = self.run_probe()
            engine.failure = index
            with self.assertRaises(P.Stop):
                self.execute_fake(probe)
            self.assertEqual(len(engine.mutations), index)
            self.assertFalse(evidence.cleaned)

    def test_mount_order_changes_are_accepted_with_all_fields_preserved(self):
        probe, engine, evidence = self.run_probe()
        def reorder(item, count):
            for row in item["Mounts"]:
                row["Future"] = {"keep": [False, None, "exact"]}
            if count % 2:
                item["Mounts"].reverse()
        engine.inspect_change = reorder
        result = self.execute_fake(probe)
        self.assertEqual(result["status"], "equivalent")
        self.assertEqual(len(engine.calls), 57)
        self.assertNotIn("mismatch.json", evidence.files)
        self.assertEqual(len([name for name in evidence.files if name.startswith("inspect-digest-")]), 7)
        for index in range(3):
            self.assertEqual(len(evidence.files[f"archive-response-digest-{index}.json"]["response_sha256"]), 64)

    def test_each_archive_comparison_retains_sanitized_mismatch_and_response_digest(self):
        for identifier, count in (("a" * 64, 2), ("a" * 64, 3), ("b" * 64, 2)):
            probe, engine, evidence = self.run_probe()
            def change(item, observed_count):
                if item["Id"] == identifier and observed_count == count:
                    item["Mounts"][0]["Unknown"] = "synthetic-private-value"
            engine.inspect_change = change
            with self.assertRaisesRegex(P.Stop, "configuration changed"):
                self.execute_fake(probe)
            mismatch = evidence.files["mismatch.json"]
            self.assertEqual(mismatch["fields"], ["Mounts"])
            self.assertEqual(set(mismatch), {"phase", "fields", "left_response_sha256", "right_response_sha256",
                                             "left_invariant_sha256", "right_invariant_sha256"})
            self.assertNotIn("synthetic-private-value", P.canonical(mismatch))
            self.assertNotEqual(mismatch["left_response_sha256"], mismatch["right_response_sha256"])
            self.assertNotEqual(mismatch["left_invariant_sha256"], mismatch["right_invariant_sha256"])
            self.assertTrue(any(name.startswith("inspect-digest-") and receipt["response_sha256"] == mismatch["right_response_sha256"]
                                for name, receipt in evidence.files.items()))
            self.assertFalse(evidence.cleaned)
            self.assertFalse(any(method == "DELETE" for method, _ in engine.mutations))

    def test_final_comparison_retains_only_allowlisted_field_names_and_digests(self):
        probe, engine, evidence = self.run_probe()
        def change(item, count):
            if item["Id"] == "b" * 64:
                item["Mounts"][0]["Future"] = "synthetic-final-value"
        engine.inspect_change = change
        with self.assertRaisesRegex(P.Stop, "representation mismatch"):
            self.execute_fake(probe)
        self.assertEqual(evidence.files["mismatch.json"]["fields"], ["Mounts"])
        self.assertNotIn("synthetic-final-value", P.canonical(evidence.files["mismatch.json"]))
        self.assertEqual(len(engine.mutations), 3)
        self.assertFalse(evidence.cleaned)

    def test_bool_integer_float_changes_stop_at_every_comparison_boundary(self):
        boundaries = (("a" * 64, 2), ("a" * 64, 3), ("b" * 64, 2), ("b" * 64, None))
        for values in ((False, 0, 0.0), (True, 1, 1.0)):
            for before in values:
                for after in values:
                    if type(before) is type(after):
                        continue
                    for identifier, count in boundaries:
                        with self.subTest(before=repr(before), after=repr(after), identifier=identifier, count=count):
                            probe, engine, evidence = self.run_probe()
                            def change(item, observed_count):
                                changed = item["Id"] == identifier and (count is None or observed_count == count)
                                item["Mounts"][0]["Future"] = {"nested": [after if changed else before]}
                            engine.inspect_change = change
                            with self.assertRaisesRegex(P.Stop, "representation mismatch" if count is None else "configuration changed"):
                                self.execute_fake(probe)
                            mismatch = evidence.files["mismatch.json"]
                            self.assertEqual(mismatch["fields"], ["Mounts"])
                            self.assertNotEqual(mismatch["left_invariant_sha256"], mismatch["right_invariant_sha256"])
                            self.assertEqual(len(engine.mutations), 2 if identifier == "a" * 64 else 3)
                            self.assertFalse(any(method == "DELETE" for method, _ in engine.mutations))
                            self.assertFalse(evidence.cleaned)

    def test_complete_projected_fields_use_type_strict_json_equality(self):
        for field in ("Config", "HostConfig", "Mounts", "Image"):
            for before, after in ((False, 0), (0, 0.0), (False, 0.0), (True, 1), (1, 1.0), (True, 1.0)):
                with self.subTest(field=field, before=repr(before), after=repr(after)):
                    probe, _, evidence = self.run_probe()
                    left = {"Config": {}, "HostConfig": {}, "Mounts": [{"Destination": "/data"}], "Image": P.IMAGE_ID}
                    right = copy.deepcopy(left)
                    if field == "Image":
                        left[field], right[field] = before, after
                    elif field == "Mounts":
                        left[field][0]["Future"], right[field][0]["Future"] = {"nested": [before]}, {"nested": [after]}
                    else:
                        left[field]["Future"], right[field]["Future"] = {"nested": [before]}, {"nested": [after]}
                    with self.assertRaises(P.Stop):
                        probe.compare(left, right, "synthetic type drift")
                    expected = ["Config", "Image"] if field == "Image" else [field]
                    self.assertEqual(evidence.files["mismatch.json"]["fields"], expected)

    def test_malformed_mounts_or_validation_failure_retains_inspect_digest_before_refusal(self):
        for invalid in ("duplicate", "config"):
            probe, engine, evidence = self.run_probe()
            def change(item, count):
                if count == 2:
                    if invalid == "duplicate":
                        item["Mounts"].append(copy.deepcopy(item["Mounts"][0]))
                    else:
                        item["HostConfig"]["Memory"] += 1
            engine.inspect_change = change
            with self.assertRaises(P.Stop):
                self.execute_fake(probe)
            self.assertEqual(len(evidence.files["inspect-digest-1.json"]["response_sha256"]), 64)
            self.assertFalse(evidence.cleaned)
            self.assertEqual(len(engine.mutations), 2)
        for rows in ([{"Destination": "/same"}, {"Destination": "/same"}], [{"Destination": "relative"}], [None], None):
            with self.subTest(rows=rows), self.assertRaises(P.Stop):
                P.invariants({"Config": {}, "Image": P.IMAGE_ID, "HostConfig": {}, "Mounts": rows})

    def test_failed_digest_or_mismatch_receipt_stops_without_cleanup_or_retry(self):
        for refused in ("inspect-digest-1.json", "mismatch.json"):
            probe, engine, evidence = self.run_probe()
            write = evidence.write
            def failing_write(name, value):
                if name == refused:
                    raise P.Stop("synthetic evidence failure")
                write(name, value)
            evidence.write = failing_write
            engine.inspect_change = lambda item, count: item["Mounts"][0].update(Unknown="changed") if count == 2 else None
            with self.assertRaisesRegex(P.Stop, "synthetic evidence failure"):
                self.execute_fake(probe)
            self.assertEqual(len(engine.mutations), 2)
            self.assertFalse(evidence.cleaned)

    def test_warning_response_is_retained_before_rejection(self):
        probe, engine, evidence = self.run_probe()
        engine.warnings = ["synthetic warning to preserve"]
        with self.assertRaises(P.Stop):
            self.execute_fake(probe)
        self.assertEqual(evidence.files["mutation-response-1.json"]["response"]["Warnings"], engine.warnings)
        self.assertFalse(evidence.cleaned)

    def test_b_must_see_new_bytes_and_unknown_a_bytes_are_refused(self):
        probe, engine, evidence = self.run_probe()
        engine.corrupt_b = True
        with self.assertRaises(P.Stop):
            self.execute_fake(probe)
        self.assertEqual(len(engine.mutations), 3)
        self.assertEqual(evidence.files["archive-response-digest-2.json"]["response_sha256"], hashlib.sha256(tar_snapshot("old")).hexdigest())
        self.assertFalse(evidence.cleaned)
        probe, engine, evidence = self.run_probe(after_swap="unreviewed")
        with self.assertRaises(P.Stop):
            self.execute_fake(probe)
        self.assertEqual(len(engine.mutations), 2)
        self.assertEqual(evidence.files["archive-response-digest-1.json"]["response_sha256"], hashlib.sha256(tar_snapshot("unreviewed")).hexdigest())

    def test_production_custody_is_not_silently_normalized(self):
        self.assertEqual(P.archive_snapshot(tar_snapshot("old")), P.canonical(P.snapshot("old")))
        with self.assertRaises(P.Stop):
            P.archive_snapshot(tar_snapshot("old", uid=10001))

    def test_real_transport_rejects_start_exec_and_unreviewed_ids_before_connection(self):
        connection = unittest.mock.Mock(side_effect=AssertionError("no actual connection permitted"))
        engine = P.FixtureEngine(armed=True, expected_daemon=P.DAEMON_SHA256, connection=connection)
        with patch.object(P.socket, "socket", side_effect=AssertionError("no real socket permitted")):
            for method, route in (("POST", "/containers/" + "f" * 64 + "/start"),
                                  ("POST", "/containers/" + "f" * 64 + "/exec"),
                                  ("GET", "/containers/" + "f" * 64 + P.ARCHIVE_SUFFIX),
                                  ("DELETE", "/volumes/unreviewed?force=false")):
                with self.assertRaises(P.Stop):
                    engine.request(method, route)
            connection.assert_not_called()

    def test_binary_archive_and_daemon_probe_share_one_fake_connection(self):
        class Response:
            will_close = False
            status = 200
            def __init__(self, data, archive=False):
                self.data, self.archive = data, archive
            def read1(self, size):
                chunk, self.data = self.data[:size], self.data[size:]
                return chunk
            def getheader(self, name):
                return "application/x-tar" if self.archive and name == "Content-Type" else None
        class Connection:
            def __init__(self):
                self.calls, self.closed = [], False
            def begin(self, deadline): return self.identity()
            def identity(self): return (1, 90, (111, 0, 0))
            def reset_response_budget(self): pass
            def request(self, method, route, **kwargs):
                self.calls.append((method, route))
                self.response = (Response(b'{"ID":"synthetic-daemon"}') if route.endswith("/info")
                                 else Response(tar_snapshot("old"), archive=True))
            def getresponse(self): return self.response
            def close(self): self.closed = True
        connection = Connection()
        fingerprint = hashlib.sha256(b"synthetic-daemon").hexdigest()
        with patch.object(P, "DAEMON_SHA256", fingerprint):
            engine = P.FixtureEngine(armed=False, expected_daemon=fingerprint, connection=lambda: connection)
            engine.permit_container("a" * 64)
            status, raw = engine.request("GET", "/containers/" + "a" * 64 + P.ARCHIVE_SUFFIX)
        self.assertEqual(status, 200)
        self.assertEqual(P.archive_snapshot(raw), P.canonical(P.snapshot("old")))
        self.assertEqual(len(connection.calls), 2)
        self.assertTrue(connection.closed)

    def test_actual_synthetic_file_replace_and_final_stage_tamper_guard(self):
        for tamper in (False, True):
            with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
                evidence = P.RamEvidence()
                evidence.fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                info = os.fstat(evidence.fd)
                evidence.identity = (info.st_dev, info.st_ino, info.st_uid)
                evidence.write("config.json", P.snapshot("old"))
                original = evidence.check_file
                changed = [False]
                def check_file(name):
                    original(name)
                    if tamper and name == "snapshot-replace-intent.json" and not changed[0]:
                        changed[0] = True
                        staged = Path(directory) / "replacement.json"
                        staged.write_text("x" * staged.stat().st_size)
                evidence.check_file = check_file
                try:
                    if tamper:
                        with patch.object(P.os, "replace", wraps=P.os.replace) as replace, self.assertRaises(P.Stop):
                            evidence.replace_snapshot()
                        replace.assert_not_called()
                        self.assertEqual((Path(directory) / "config.json").read_text(), P.canonical(P.snapshot("old")))
                    else:
                        evidence.replace_snapshot()
                        self.assertEqual((Path(directory) / "config.json").read_text(), P.canonical(P.snapshot("new")))
                finally:
                    evidence.close()

    def test_default_cli_is_zero_io_and_unreviewed_execute_is_fenced(self):
        with patch.object(P.sys, "argv", ["rehearse.py"]), patch.object(P, "FixtureEngine") as engine, \
                patch.object(P, "RamEvidence") as evidence, patch.object(P, "canonical", return_value="{}"), patch("builtins.print"):
            P.main()
            engine.assert_not_called()
            evidence.assert_not_called()
        with patch.object(P.sys, "argv", ["rehearse.py", "--execute"]), patch.object(P, "FixtureEngine") as engine, \
                patch.object(P.Path, "read_bytes", return_value=b"unreviewed"), patch("builtins.print"):
            with self.assertRaises(SystemExit):
                P.main()
            engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
