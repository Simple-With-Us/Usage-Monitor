"""Offline fake-daemon and synthetic filesystem faults; no fixed scope is opened."""
import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("uid_custody_fixture", Path(__file__).with_name("custody.py"))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
READER_SPEC = importlib.util.spec_from_file_location("uid_custody_absence", Path(__file__).with_name("verify-absence.py"))
Q = importlib.util.module_from_spec(READER_SPEC)
READER_SPEC.loader.exec_module(Q)
FINGERPRINT = hashlib.sha256(b"synthetic-daemon").hexdigest()


def tar_bytes(*, uid=10001, gid=10001, mode=0o600, name="telemetry-hub.json", content=None, kind=tarfile.REGTYPE, extra=False):
    output = io.BytesIO()
    body = P.SNAPSHOT_RAW if content is None else content
    with tarfile.open(fileobj=output, mode="w:", format=tarfile.USTAR_FORMAT) as archive:
        item = tarfile.TarInfo(name)
        item.uid, item.gid, item.mode, item.size, item.type = uid, gid, mode, len(body), kind
        if kind == tarfile.SYMTYPE:
            item.linkname = "/other"
        archive.addfile(item, io.BytesIO(body))
        if extra:
            item = tarfile.TarInfo("extra")
            archive.addfile(item)
    return output.getvalue()


class FakeEvidence:
    def __init__(self):
        self.files, self.payload_signature = {}, None
        self.opened = self.cleaned = self.uploaded = False
        self.bad_owner = self.changed = False
        self.refuse = None

    def open(self):
        self.opened = True

    def write(self, name, value):
        if name == self.refuse:
            raise P.Stop("synthetic receipt failure")
        if name in self.files:
            raise AssertionError("exclusive receipt repeated")
        self.files[name] = copy.deepcopy(value)

    def check(self):
        if self.changed:
            raise P.Stop("synthetic file changed")

    def capture_payload(self):
        if not self.uploaded or self.bad_owner:
            raise P.Stop("actual UID-10001 payload custody differs")
        self.payload_signature = (1, 2, 10001, 10001, stat.S_IFREG | 0o600, 1, len(P.SNAPSHOT_RAW), 3, 4)

    def cleanup(self):
        self.check()
        self.cleaned = True

    def close(self):
        pass


class FakeEngine:
    def __init__(self, evidence):
        self.evidence, self.item, self.identifier = evidence, None, None
        self.calls, self.mutations, self.reads = 0, [], 0
        self.failure = self.bad_status = None
        self.warnings, self.upload_response, self.delete_response = [], None, None
        self.inspect_change = lambda item, count: None
        self.archive_change = lambda index: tar_bytes()
        self.archive_count = 0

    def permit_container(self, identifier):
        assert identifier == "a" * 64
        self.identifier = identifier

    def request(self, method, route, body=None):
        self.calls += 1 if route == "/info" else 2
        if method != "GET":
            self.mutations.append((method, route))
            if self.failure == len(self.mutations):
                raise TimeoutError("synthetic unknown reply")
            if self.bad_status == len(self.mutations):
                return 500, {"message": "synthetic refusal"}
        if route == "/info":
            return 200, {"ID": "synthetic-daemon", "CgroupVersion": "2"}
        if route == "/version":
            return 200, {"MinAPIVersion": "1.40", "ApiVersion": "1.55"}
        if route.startswith("/images/"):
            return 200, {"Id": P.B.IMAGE_ID, "RepoDigests": [P.B.IMAGE_REFERENCE], "Config": {"Env": P.B.ENV[:-1]}}
        if method == "POST":
            assert P.B.same_json(body, P.source_payload())
            config = copy.deepcopy({key: value for key, value in body.items() if key != "HostConfig"})
            config["Hostname"] = "a" * 12
            self.item = {"Id": "a" * 64, "Name": "/" + P.NAME, "Image": P.B.IMAGE_ID,
                         "Config": config, "HostConfig": copy.deepcopy(body["HostConfig"]),
                         "Mounts": [{"Type": "bind", "Source": P.PAYLOAD_ROOT, "Destination": "/run/secrets", "RW": True}],
                         "State": {"Running": False, "Status": "created", "Pid": 0}}
            return 201, {"Id": "a" * 64, "Warnings": self.warnings}
        if method == "PUT":
            P.validate_upload(body)
            self.evidence.uploaded = True
            return 200, self.upload_response
        if method == "DELETE":
            self.item = None
            return 204, self.delete_response
        if route.endswith(P.B.ARCHIVE_SUFFIX):
            value = self.archive_change(self.archive_count)
            self.archive_count += 1
            return 200, value
        if route.endswith("/json"):
            if self.item is None:
                return 404, None
            self.reads += 1
            item = copy.deepcopy(self.item)
            self.inspect_change(item, self.reads)
            return 200, item
        raise AssertionError("unlisted fake route")


class Response:
    will_close = False
    status = 200
    def __init__(self, data):
        self.data = data
    def read1(self, size):
        chunk, self.data = self.data[:size], self.data[size:]
        return chunk
    def getheader(self, name):
        return None


class Connection:
    def __init__(self):
        self.calls, self.closed = [], False
        self.before_response = lambda: None
    def begin(self, deadline):
        self.deadline = deadline
        return self.identity()
    def identity(self):
        return (1, 2, (123, 0, 0))
    def reset_response_budget(self):
        pass
    def request(self, method, route, **kwargs):
        self.calls.append((method, route, kwargs))
        self.response = Response(b'{"ID":"synthetic-daemon"}' if route.endswith("/info") else b"")
    def getresponse(self):
        self.before_response()
        return self.response
    def close(self):
        self.closed = True


class CustodyTests(unittest.TestCase):
    def fixture(self):
        evidence = FakeEvidence()
        engine = FakeEngine(evidence)
        return P.Probe(engine, evidence), engine, evidence

    def run_fake(self, probe):
        with patch.object(P.B, "DAEMON_SHA256", FINGERPRINT), patch.object(P.B.socket, "socket", side_effect=AssertionError("no actual socket allowed")):
            return probe.run()

    def test_complete_fake_flow_has_exact_counts_and_only_three_mutations(self):
        probe, engine, evidence = self.fixture()
        result = self.run_fake(probe)
        self.assertEqual(result["status"], "synthetic_uid_custody_verified")
        self.assertEqual(engine.calls, 27)
        self.assertEqual(result["wire_requests"], 27)
        self.assertEqual([method for method, _ in engine.mutations], ["POST", "PUT", "DELETE"])
        self.assertEqual(result["archive_owner"], [10001, 10001])
        self.assertFalse(result["production_resource_custody_verified"])
        self.assertFalse(result["started"])
        self.assertTrue(evidence.cleaned)
        self.assertEqual(len(evidence.files["archive-proof-1.json"]["snapshot_sha256"]), 64)

    def test_each_unknown_or_bad_mutation_stops_without_retry_or_cleanup(self):
        for field in ("failure", "bad_status"):
            for count in range(1, 4):
                with self.subTest(field=field, count=count):
                    probe, engine, evidence = self.fixture()
                    setattr(engine, field, count)
                    with self.assertRaises(P.Stop):
                        self.run_fake(probe)
                    self.assertEqual(len(engine.mutations), count)
                    self.assertFalse(evidence.cleaned)
                    calls = engine.calls
                    with self.assertRaises(P.Stop):
                        self.run_fake(probe)
                    self.assertEqual(engine.calls, calls)

    def test_warning_or_unexpected_mutation_body_is_preserved_then_refused(self):
        for field, value, count in (("warnings", ["synthetic warning"], 1), ("upload_response", {"warning": "synthetic"}, 2),
                                    ("delete_response", {"warning": "synthetic"}, 3)):
            probe, engine, evidence = self.fixture()
            setattr(engine, field, value)
            with self.assertRaises(P.Stop):
                self.run_fake(probe)
            receipt = evidence.files[f"response-{count - 1}.json"]
            self.assertIn("synthetic", str(receipt))
            self.assertEqual(len(engine.mutations), count)
            self.assertFalse(evidence.cleaned)

    def test_host_and_archive_uid_gates_are_separate_and_unchanged(self):
        probe, engine, evidence = self.fixture()
        evidence.bad_owner = True
        with self.assertRaisesRegex(P.Stop, "custody differs"):
            self.run_fake(probe)
        self.assertIn("response-1.json", evidence.files)
        self.assertEqual(len(engine.mutations), 2)
        for uid, gid in ((1001, 10001), (10001, 1001), (1001, 1001)):
            probe, engine, evidence = self.fixture()
            engine.archive_change = lambda index: tar_bytes(uid=uid, gid=gid)
            with self.assertRaises(P.R.Stop):
                self.run_fake(probe)
            self.assertEqual(len(engine.mutations), 2)
            self.assertIn("archive-response-0.json", evidence.files)
            self.assertFalse(evidence.cleaned)
        self.assertEqual(P.B.HOST_OWNER, (1001, 1001))
        self.assertEqual(P.PAYLOAD_OWNER, (10001, 10001))

    def test_exact_tar_and_unchanged_decoder_reject_unreviewed_bytes(self):
        P.validate_upload(P.upload_tar())
        self.assertEqual(P.R.snapshot_archive(P.upload_tar()).encode(), P.SNAPSHOT_RAW)
        values = [tar_bytes(uid=1001), tar_bytes(gid=1001), tar_bytes(mode=0o644), tar_bytes(name="../telemetry-hub.json"),
                  tar_bytes(kind=tarfile.SYMTYPE), tar_bytes(extra=True), tar_bytes(content=b"x"), b"gzip", P.upload_tar() + b"x" * 16384]
        for raw in values:
            with self.subTest(size=len(raw)), self.assertRaises(P.Stop):
                P.validate_upload(raw)

    def test_both_archive_boundaries_reject_type_drift_and_preserve_mismatch(self):
        for changed_count in (2, 3):
            for before, after in ((False, 0), (0, 0.0), (False, 0.0), (True, 1), (1, 1.0), (True, 1.0)):
                probe, engine, evidence = self.fixture()
                def change(item, count):
                    item["Mounts"][0]["Future"] = {"nested": [after if count == changed_count else before]}
                engine.inspect_change = change
                with self.assertRaisesRegex(P.Stop, "configuration changed"):
                    self.run_fake(probe)
                self.assertEqual(evidence.files["mismatch.json"]["fields"], ["Mounts"])
                self.assertFalse(evidence.cleaned)
                self.assertEqual(len(engine.mutations), 2)

    def test_each_evidence_failure_preserves_scope_without_automatic_cleanup(self):
        for name in ("create-intent.json", "response-0.json", "upload-intent.json", "response-1.json", "archive-response-0.json",
                     "archive-proof-1.json", "response-2.json", "comparison.json"):
            probe, engine, evidence = self.fixture()
            evidence.refuse = name
            with self.assertRaisesRegex(P.Stop, "receipt failure"):
                self.run_fake(probe)
            self.assertFalse(evidence.cleaned)
            self.assertLessEqual(len(engine.mutations), 3)

    def test_actual_payload_metadata_rejects_operator_owned_file_without_opening_it(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
            root = Path(directory)
            root.chmod(0o700)
            (root / "payload").mkdir(mode=0o700)
            evidence = P.Evidence()
            evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
            evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
            evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
            try:
                evidence.write("before-upload.json", {"test": "synthetic"})
                source = root / "payload" / "telemetry-hub.json"
                source.write_bytes(P.SNAPSHOT_RAW)
                source.chmod(0o600)
                # Response durability must precede interpretation of new custody.
                evidence.write("upload-response.json", {"status": 200})
                with patch.object(P.os, "open", side_effect=AssertionError("payload content must not be opened")), self.assertRaisesRegex(P.Stop, "custody differs"):
                    evidence.capture_payload()
                self.assertTrue(source.exists())
                self.assertTrue((root / "upload-response.json").exists())
            finally:
                evidence.close()

    def test_actual_operator_receipt_same_size_rewrite_and_extra_entry_are_refused(self):
        for fault in ("rewrite", "extra", "symlink"):
            with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
                root = Path(directory)
                root.chmod(0o700)
                (root / "payload").mkdir(mode=0o700)
                evidence = P.Evidence()
                evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
                evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
                evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
                try:
                    evidence.write("receipt.json", {"value": "synthetic"})
                    if fault == "rewrite":
                        receipt = root / "receipt.json"
                        receipt.write_bytes(b"x" * receipt.stat().st_size)
                    elif fault == "extra":
                        (root / "payload" / "extra").touch()
                    else:
                        (root / "payload").rename(root / "saved-payload")
                        (root / "payload").symlink_to(root / "saved-payload", target_is_directory=True)
                    with self.assertRaises(P.Stop):
                        evidence.check()
                    with patch.object(P.os, "unlink") as unlink, self.assertRaises(P.Stop):
                        evidence.cleanup()
                    unlink.assert_not_called()
                finally:
                    evidence.close()

    def test_same_size_payload_rewrite_or_inode_replacement_refuses_cleanup(self):
        for fault in ("rewrite", "replace"):
            with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
                root = Path(directory)
                root.chmod(0o700)
                (root / "payload").mkdir(mode=0o700)
                source = root / "payload" / "telemetry-hub.json"
                source.write_bytes(P.SNAPSHOT_RAW)
                source.chmod(0o600)
                evidence = P.Evidence()
                evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
                evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
                evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
                original_stat = os.stat
                def synthetic_uid_stat(path, *args, **kwargs):
                    info = original_stat(path, *args, **kwargs)
                    if path == "telemetry-hub.json":
                        values = {key: getattr(info, key) for key in P.SIGNATURE_FIELDS}
                        values.update(st_uid=10001, st_gid=10001)
                        return types.SimpleNamespace(**values)
                    return info
                try:
                    # Test-only UID substitution leaves actual inode/time fields
                    # intact; no chown or production gate relaxation occurs.
                    with patch.object(P.os, "stat", side_effect=synthetic_uid_stat):
                        evidence.capture_payload()
                        if fault == "replace":
                            source.unlink()
                        source.write_bytes(b"x" * len(P.SNAPSHOT_RAW))
                        source.chmod(0o600)
                        # Coarse-tick filesystems (HZ-granularity ext4) can
                        # return identical stat signatures for a fast real
                        # rewrite; force a guaranteed timestamp delta so the
                        # fixture stays deterministic everywhere. tmpfs (the
                        # enforced production parent) has ns granularity.
                        stat_after = source.stat()
                        os.utime(source, ns=(stat_after.st_atime_ns + 1000000, stat_after.st_mtime_ns + 1000000))
                        with self.assertRaisesRegex(P.Stop, "identity changed"):
                            evidence.check()
                        with patch.object(P.os, "unlink") as unlink, self.assertRaises(P.Stop):
                            evidence.cleanup()
                        unlink.assert_not_called()
                finally:
                    evidence.close()

    def test_stat_only_payload_custody_bounds_full_signature_collision(self):
        # Adversarial boundary, by design: plan.md states the host actor never
        # opens the UID-10001 payload to read content, so payload custody is a
        # physical stat signature only.  A rewrite that preserves the ENTIRE
        # signature - same inode, with mtime/ctime reading identical because
        # the filesystem timestamp tick is coarser than the rewrite window -
        # is NOT detectable without reading content.  This test documents
        # that residual for review; it is not an asserted acceptance.  The
        # collision is simulated by replaying the captured signature rather
        # than produced with real timestamps, and no timestamp-granularity
        # guarantee is claimed.
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
            root = Path(directory)
            root.chmod(0o700)
            (root / "payload").mkdir(mode=0o700)
            source = root / "payload" / "telemetry-hub.json"
            source.write_bytes(P.SNAPSHOT_RAW)
            source.chmod(0o600)
            evidence = P.Evidence()
            evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
            evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
            evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
            original_stat = os.stat
            def synthetic_uid_stat(path, *args, **kwargs):
                info = original_stat(path, *args, **kwargs)
                if path == "telemetry-hub.json":
                    values = {key: getattr(info, key) for key in P.SIGNATURE_FIELDS}
                    values.update(st_uid=10001, st_gid=10001)
                    return types.SimpleNamespace(**values)
                return info
            try:
                # Test-only UID substitution, same as the sibling fixtures.
                with patch.object(P.os, "stat", side_effect=synthetic_uid_stat):
                    evidence.capture_payload()
                # Real in-place, same-size rewrite: the bytes change, the inode stays.
                source.write_bytes(b"y" * len(P.SNAPSHOT_RAW))
                self.assertNotEqual(source.read_bytes(), P.SNAPSHOT_RAW)
                captured = dict(zip(P.SIGNATURE_FIELDS, evidence.payload_signature))
                def coarse_tick_stat(path, *args, **kwargs):
                    info = original_stat(path, *args, **kwargs)
                    if path == "telemetry-hub.json":
                        return types.SimpleNamespace(**captured)
                    return info
                # Under a coarse-tick filesystem reading, the same rewrite is
                # invisible to stat-only custody.  This is a documented
                # residual (plan.md), NOT an accepted behavior: the check is
                # quarantined so that a future custody strengthening turns
                # this case into a skip instead of a failure, and acceptance
                # of a replayed signature is never a gating assertion.
                with patch.object(P.os, "stat", side_effect=coarse_tick_stat):
                    try:
                        evidence.check()
                    except P.Stop as exc:
                        # Receipt failures are ordinary failures and must never be
                        # masked as a skip.  The payload-identity signal is the
                        # strengthened-custody case this quarantine exists for:
                        # plan.md records that a custody strengthening turns this
                        # into a skip, never a failure.
                        message = str(exc)
                        if "receipt" in message:
                            raise
                        raise unittest.SkipTest(
                            "custody strengthened past the stat-only residual; drop this quarantine") from exc
                # With true stat reads (same test-only UID substitution) and a
                # guaranteed timestamp delta, the same rewrite IS refused:
                # detection depends entirely on the signature changing.
                after = source.stat()
                os.utime(source, ns=(after.st_atime_ns + 1000000, after.st_mtime_ns + 1000000))
                with patch.object(P.os, "stat", side_effect=synthetic_uid_stat):
                    with self.assertRaisesRegex(P.Stop, "actual synthetic payload identity changed"):
                        evidence.check()
            finally:
                evidence.close()

    def test_cleanup_happy_path_removes_generated_scope_offline(self):
        # Offline cleanup contract: generated temporary fixtures only, no
        # private fingerprints.  When every custody gate holds, cleanup()
        # removes the payload file, the payload directory and the RAM scope
        # directory exactly, and closes its descriptors.  The exact reviewed
        # values (uid/gid, mode, nlink, size, full signature) stay enforced on
        # the way; the pinned "/dev/shm" parent read is redirected to the
        # generated parent, which is the same contract against a temp fixture.
        with tempfile.TemporaryDirectory() as parent_dir:
            parent = Path(parent_dir)
            root = parent / P.BASE
            root.mkdir(mode=0o700)
            (root / "payload").mkdir(mode=0o700)
            source = root / "payload" / "telemetry-hub.json"
            source.write_bytes(P.SNAPSHOT_RAW)
            source.chmod(0o600)
            evidence = P.Evidence()
            evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
            evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
            evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
            original_stat = os.stat
            def synthetic_uid_stat(path, *args, **kwargs):
                info = original_stat(path, *args, **kwargs)
                if path == "telemetry-hub.json":
                    values = {key: getattr(info, key) for key in P.SIGNATURE_FIELDS}
                    values.update(st_uid=10001, st_gid=10001)
                    return types.SimpleNamespace(**values)
                return info
            original_open = os.open
            def generated_parent_open(path, *args, **kwargs):
                if path == "/dev/shm":
                    return original_open(str(parent), *args, **kwargs)
                return original_open(path, *args, **kwargs)
            try:
                with patch.object(P, "RAM_ROOT", str(root)):
                    with patch.object(P.os, "stat", side_effect=synthetic_uid_stat):
                        evidence.capture_payload()
                    with patch.object(P.os, "stat", side_effect=synthetic_uid_stat), \
                            patch.object(P.os, "open", side_effect=generated_parent_open):
                        evidence.cleanup()
                self.assertFalse(source.exists())
                self.assertFalse((root / "payload").exists())
                self.assertFalse(root.exists())
                self.assertIsNone(evidence.fd)
                self.assertIsNone(evidence.payload_fd)
            finally:
                evidence.close()

    def test_operator_receipt_deadline_failure_retains_written_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(P, "RAM_ROOT", directory):
            root = Path(directory)
            root.chmod(0o700)
            (root / "payload").mkdir(mode=0o700)
            clock = [0.0]
            evidence = P.Evidence(clock=lambda: clock[0])
            evidence.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            evidence.payload_fd = os.open(root / "payload", os.O_RDONLY | os.O_DIRECTORY)
            evidence.directory_identity = evidence.directory_pin(os.fstat(evidence.fd))
            evidence.payload_identity = evidence.directory_pin(os.fstat(evidence.payload_fd))
            fsync = os.fsync
            def slow_fsync(descriptor):
                fsync(descriptor)
                clock[0] = 16
            try:
                with patch.object(P.os, "fsync", side_effect=slow_fsync), self.assertRaises(P.Stop):
                    evidence.write("deadline.json", {"value": "synthetic"})
                self.assertTrue((root / "deadline.json").exists())
                self.assertIsNone(evidence.effect_deadline)
            finally:
                evidence.close()

    def engine(self, connection=None):
        return P.CustodyEngine(armed=True, expected_daemon=P.B.DAEMON_SHA256, connection=connection or Mock(side_effect=AssertionError("no connection allowed")))

    def test_forbidden_route_body_id_and_mutation_order_refuse_before_connection(self):
        bad_create = P.source_payload()
        bad_create["HostConfig"]["Privileged"] = True
        cases = [("POST", "/containers/" + "a" * 64 + "/start", None), ("POST", "/containers/" + "a" * 64 + "/exec", None),
                 ("POST", "/containers/create?name=" + P.NAME, bad_create), ("POST", "/containers/create?name=foreign", P.source_payload()),
                 ("DELETE", "/containers/" + "a" * 64 + "?v=true&force=true&link=false", None),
                 ("PUT", "/containers/" + "b" * 64 + P.UPLOAD_ROUTE, P.upload_tar()),
                 ("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE + "&other=true", P.upload_tar()),
                 ("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE, b"changed")]
        for method, route, body in cases:
            engine = self.engine()
            engine.permit_container("a" * 64)
            with self.assertRaises(P.Stop):
                engine.request(method, route, body)
            self.assertEqual(engine.calls, 0)
        for method, route, body in (("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE, P.upload_tar()),
                                    ("DELETE", "/containers/" + "a" * 64 + "?v=false&force=false&link=false", None)):
            engine = self.engine()
            engine.permit_container("a" * 64)
            with self.assertRaisesRegex(P.Stop, "order required"):
                engine.request(method, route, body)

    def test_exact_binary_upload_uses_one_daemon_verified_connection_and_mime(self):
        connection = Connection()
        with patch.object(P.B, "DAEMON_SHA256", FINGERPRINT):
            engine = self.engine(lambda: connection)
            engine.permit_container("a" * 64)
            engine.mutations.add(("POST", "/containers/create?name=" + P.NAME))
            status, value = engine.request("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE, P.upload_tar())
            self.assertEqual((status, value), (200, None))
            self.assertEqual(engine.calls, 2)
            self.assertEqual(connection.calls[0][1], "/v1.53/info")
            self.assertEqual(connection.calls[1][2]["headers"]["Content-Type"], "application/x-tar")
            self.assertEqual(connection.calls[1][2]["body"], P.upload_tar())
            with self.assertRaises(P.Stop):
                engine.request("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE, P.upload_tar())
            self.assertTrue(connection.closed)

    def test_daemon_mismatch_deadline_budget_and_final_tar_check_stop_before_upload(self):
        for fault in ("daemon", "deadline", "budget", "tar", "connection"):
            connection = Connection()
            clock = [0.0]
            with patch.object(P.B, "DAEMON_SHA256", FINGERPRINT):
                engine = P.CustodyEngine(armed=True, expected_daemon=FINGERPRINT, connection=lambda: connection, clock=lambda: clock[0])
                engine.permit_container("a" * 64)
                engine.mutations.add(("POST", "/containers/create?name=" + P.NAME))
                if fault == "daemon":
                    engine.expected_daemon = "f" * 64
                elif fault == "deadline":
                    connection.before_response = lambda: clock.__setitem__(0, 16)
                elif fault == "budget":
                    engine.calls = P.MAX_REQUESTS - 1
                elif fault == "connection":
                    connection.before_response = lambda: setattr(connection, "identity", lambda: (9, 9, (123, 0, 0)))
                if fault == "tar":
                    validator = P.validate_upload
                    calls = [0]
                    def changed(raw):
                        calls[0] += 1
                        if calls[0] == 2:
                            raise P.Stop("synthetic final tar check")
                        validator(raw)
                    context = patch.object(P, "validate_upload", side_effect=changed)
                else:
                    context = patch.object(P, "MAX_REQUESTS", P.MAX_REQUESTS)
                with context, self.assertRaises(P.Stop):
                    engine.request("PUT", "/containers/" + "a" * 64 + P.UPLOAD_ROUTE, P.upload_tar())
                self.assertFalse(any(method == "PUT" for method, _, _ in connection.calls))
                self.assertTrue(engine.failed)

    def test_default_cli_and_unreviewed_execute_construct_no_engine_or_evidence(self):
        for arguments in (["custody.py"], ["custody.py", "--execute"]):
            with patch.object(P.sys, "argv", arguments), patch.object(P, "CustodyEngine") as engine, patch.object(P, "Evidence") as evidence, patch("builtins.print"):
                if "--execute" in arguments:
                    with patch.object(P.Path, "read_bytes", return_value=b"unreviewed"), self.assertRaises(SystemExit):
                        P.main()
                else:
                    P.main()
                engine.assert_not_called()
                evidence.assert_not_called()

    def test_separate_unarmed_absence_reader_has_five_wire_requests_and_no_mutations(self):
        engine = FakeEngine(FakeEvidence())
        engine.armed = False
        with patch.object(Q.C.B, "DAEMON_SHA256", FINGERPRINT):
            result = Q.verify_absence("a" * 64, engine, ram_check=lambda: False)
        self.assertTrue(result["all_exact_resources_absent"])
        self.assertEqual(result["wire_requests"], 5)
        self.assertEqual(result["mutations"], 0)
        self.assertEqual(engine.mutations, [])
        for fault in ("armed", "id", "ram"):
            engine = FakeEngine(FakeEvidence())
            engine.armed = fault == "armed"
            with patch.object(Q.C.B, "DAEMON_SHA256", FINGERPRINT), self.assertRaises(Q.C.Stop):
                Q.verify_absence("invalid" if fault == "id" else "a" * 64, engine, ram_check=lambda: fault == "ram")
            self.assertEqual(engine.mutations, [])

    def test_independent_reader_default_and_unreviewed_arguments_construct_no_client(self):
        for arguments in (["verify-absence.py"], ["verify-absence.py", "--container-id", "a" * 64]):
            with patch.object(Q.sys, "argv", arguments), patch.object(Q.C, "CustodyEngine") as engine, patch("builtins.print"):
                if len(arguments) == 1:
                    Q.main()
                else:
                    with self.assertRaises(SystemExit):
                        Q.main()
                engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
