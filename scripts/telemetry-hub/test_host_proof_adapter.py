"""Synthetic local-filesystem faults only; production paths and Engine are never used."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


def module(label, filename):
    spec = importlib.util.spec_from_file_location(label, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


H = module("host_adapter_candidate", "host-proof-adapter.py")
T = module("host_adapter_fixtures", "test_finite_pinned_lifecycle.py")


class MountedFixture:
    """Bind-inode simulation using an actual synthetic file descriptor."""
    def __init__(self, engine, snapshot):
        self.engine, self.snapshot, self.fd = engine, snapshot, None
        self.sticky_old = False
        self.calls = []
        request = engine.request
        def wrapped(method, route, body=None):
            result = request(method, route, body)
            if "/containers/create?" in route and not self.sticky_old:
                self.bind()
            return result
        engine.request = wrapped

    def bind(self):
        if self.fd is not None:
            os.close(self.fd)
        self.fd = os.open(self.snapshot, os.O_RDONLY | os.O_NOFOLLOW)

    def read(self, container_id, *, running, budget):
        budget.remaining()
        self.calls.append((container_id, running))
        if container_id != self.engine.new_id or self.engine.containers[container_id]["State"]["Running"] is not running:
            raise AssertionError("synthetic reader identity/state changed")
        info = os.fstat(self.fd)
        return os.pread(self.fd, info.st_size, 0).decode()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class Files:
    def __init__(self, root):
        self.root = Path(root)
        for name in ("snapshots", "inputs", "journal", "journal/state", "receipts"):
            (self.root / name).mkdir(mode=0o700)
        self.plan, self.engine, self.old, self.new = T.fixture()
        self.snapshot = self.root / "snapshots/config.json"
        self.next_snapshot = self.root / "inputs/new.json"
        self.reservation = self.root / "inputs/reservation.json"
        self.journal = self.root / "journal"
        self.engine.old["HostConfig"]["Binds"][1] = str(self.snapshot) + ":/run/secrets/telemetry-hub.json:ro"
        self.engine.old["Mounts"][0]["Source"] = str(self.journal)
        self.engine.old["Mounts"][1]["Source"] = str(self.snapshot)
        self.engine.volume["Mountpoint"] = str(self.journal)
        self.plan["lifecycle"] = self.engine.manifest()
        self.plan["rollback_plan_sha256"] = H.E.sha(H.F.recovery_plan(self.plan["lifecycle"], self.plan["snapshot"]))
        reservation = {"owner_session": "synthetic-owner-session", "container_id": self.engine.old_id,
                       "snapshot_path": str(self.snapshot), "journal_path": str(self.journal),
                       "acknowledgments": [{"topic": topic, "receipt": "synthetic-review", "acknowledged": True} for topic in ("AFC-600", "Clutch")]}
        self.plan["reservation_sha256"] = H.E.sha(reservation)
        self.write(self.snapshot, self.old)
        self.write(self.next_snapshot, self.new)
        self.write(self.reservation, H.canonical(reservation))
        self.write(self.journal / "journal.jsonl", "x" * 100)
        self.write(self.journal / "state/journal.base.json", '{"base":0,"nextBase":0,"pendingSize":0}')
        self.write(self.journal / "state/sentry.offset.json", '{"offset":90}')
        locations = {"snapshot": self.snapshot.parent, "inputs": self.next_snapshot.parent, "journal": self.journal,
                     "state": self.journal / "state", "receipts": self.root / "receipts"}
        self.scope = {"snapshot_path": str(self.snapshot), "new_snapshot_path": str(self.next_snapshot),
                      "reservation_path": str(self.reservation), "journal_path": str(self.journal),
                      "receipt_directory": str(self.root / "receipts"), "owner_session": "synthetic-owner-session",
                      "snapshot_owner": [os.getuid(), os.getgid()], "journal_owner": [os.getuid(), os.getgid()],
                      "input_owner": [os.getuid(), os.getgid()],
                      "pins": {key: H.directory_identity(value.stat()) for key, value in locations.items()}}
        self.sink = H.DurableReceipts(self.scope["receipt_directory"], self.scope["pins"]["receipts"], clock=lambda: self.engine.time)
        self.reader = MountedFixture(self.engine, self.snapshot)
        self.adapter = H.HostProofAdapter(self.plan, self.scope, self.sink, mounted_reader=self.reader)

    def write(self, destination, raw):
        destination.write_text(raw)
        destination.chmod(0o600)

    def budget(self):
        return H.E.Deadline(lambda: self.engine.time, 30)

    def initial(self):
        return self.adapter.invoke("preflight-recovery", {"inspect": copy.deepcopy(self.engine.old),
                                   "payload": H.E.M.pinned_create_payload(self.engine.old)}, self.budget())

    def run(self):
        # The host adapter checks real fixture ownership; only this test subclass
        # translates the unprivileged fixture UID for the model's UID10001 gate.
        class FixtureLifecycle(H.F.FiniteLifecycle):
            def identity(self, value, raw):
                if (value["uid"], value["gid"]) != (os.getuid(), os.getgid()):
                    raise H.Stop("synthetic fixture custody differs")
                mapped = dict(value, uid=10001, gid=10001)
                super().identity(mapped, raw)
        return FixtureLifecycle(self.plan, self.engine, proofs=self.adapter, receipt=self.sink,
                                clock=lambda: self.engine.time, pause=lambda seconds: setattr(self.engine, "time", self.engine.time + seconds)).run()

    def close(self):
        self.adapter.close()
        self.sink.close()
        self.reader.close()


class HostTests(unittest.TestCase):
    @contextlib.contextmanager
    def files(self):
        with tempfile.TemporaryDirectory() as directory:
            files = Files(directory)
            try:
                yield files
            finally:
                files.close()

    def test_full_synthetic_filesystem_model_preserves_data_and_durable_receipts(self):
        with self.files() as files:
            old_inode = files.snapshot.stat().st_ino
            result = files.run()
            self.assertFalse(result["live_execution_enabled"])
            self.assertEqual(files.snapshot.read_text(), files.new)
            self.assertNotEqual(files.snapshot.stat().st_ino, old_inode)
            self.assertEqual(stat.S_IMODE(files.snapshot.stat().st_mode), 0o600)
            receipts = list((files.root / "receipts").iterdir())
            self.assertEqual(len(receipts), 26)
            for receipt in receipts:
                self.assertEqual((receipt.stat().st_uid, stat.S_IMODE(receipt.stat().st_mode)), (os.getuid(), 0o600))
            self.assertEqual(json.loads((files.root / "receipts/backup-snapshot.json").read_text()), files.old)
            self.assertEqual((files.journal / "journal.jsonl").read_text(), "x" * 100)
            self.assertTrue((files.snapshot.parent / H.LEASE).exists())
            self.assertIsNone(files.adapter.lease_fd)

    def test_production_uid_gate_is_not_relaxed_by_host_scope(self):
        if os.getuid() == 10001 and os.getgid() == 10001:
            self.skipTest("fixture already has production custody UID")
        with self.files() as files:
            candidate = H.F.FiniteLifecycle(files.plan, files.engine, proofs=files.adapter, receipt=files.sink,
                                           clock=lambda: files.engine.time)
            with self.assertRaises(H.Stop):
                candidate.run()
            self.assertEqual(files.engine.mutations, [])
            self.assertEqual(files.snapshot.read_text(), files.old)

    def test_receipt_file_and_directory_fsync_and_exact_readback(self):
        with self.files() as files:
            real = H.os.fsync
            calls = []
            def fsync(fd):
                calls.append(stat.S_IFMT(os.fstat(fd).st_mode))
                return real(fd)
            with patch.object(H.os, "fsync", side_effect=fsync):
                ack = files.sink.write("synthetic-receipt", {"marker": "synthetic"}, files.budget())
            self.assertEqual(ack, {"sha256": H.E.sha({"marker": "synthetic"}), "durable_readback": True})
            self.assertIn(stat.S_IFREG, calls)
            self.assertIn(stat.S_IFDIR, calls)

    def test_partial_receipt_and_fsync_failure_preserve_partial_file_without_ack(self):
        for fault in ("write", "fsync"):
            with self.files() as files:
                if fault == "write":
                    original = H.os.write
                    calls = [0]
                    def partial(fd, raw):
                        calls[0] += 1
                        if calls[0] == 1:
                            return original(fd, raw[:2])
                        raise OSError("synthetic full filesystem")
                    target = patch.object(H.os, "write", side_effect=partial)
                else:
                    target = patch.object(H.os, "fsync", side_effect=OSError("synthetic fsync failure"))
                with target, self.assertRaises(H.Stop):
                    files.sink.write("partial", {"synthetic": "payload"}, files.budget())
                self.assertTrue((files.root / "receipts/partial.json").exists())
                with self.assertRaises(H.Stop):
                    files.sink.write("another", {}, files.budget())

    def test_receipt_duplicate_symlink_and_hardlink_are_never_overwritten(self):
        with self.files() as files:
            files.sink.write("existing", {"old": True}, files.budget())
            before = (files.root / "receipts/existing.json").read_bytes()
            with self.assertRaises(H.Stop):
                files.sink.write("existing", {"old": False}, files.budget())
            self.assertEqual((files.root / "receipts/existing.json").read_bytes(), before)
        with self.files() as files:
            outside = files.root / "outside.json"
            files.write(outside, "synthetic outside")
            (files.root / "receipts/link.json").symlink_to(outside)
            with self.assertRaises(H.Stop):
                files.sink.write("link", {}, files.budget())
            self.assertEqual(outside.read_text(), "synthetic outside")
        with self.files() as files:
            os.link(files.snapshot, files.snapshot.parent / "other-link")
            with self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(files.engine.mutations, [])

    def test_wrong_engine_scope_stops_before_any_file_body_read(self):
        with self.files() as files:
            changed = copy.deepcopy(files.engine.old)
            changed["Mounts"][1]["Source"] = str(files.root / "sibling.json")
            with patch.object(H.Directory, "read", side_effect=AssertionError("body read is forbidden")):
                with self.assertRaises(H.Stop):
                    files.adapter.invoke("preflight-recovery", {"inspect": changed,
                                         "payload": H.E.M.pinned_create_payload(files.engine.old)}, files.budget())
            self.assertFalse((files.snapshot.parent / H.LEASE).exists())

    def test_snapshot_directory_symlink_and_unsafe_mode_are_refused(self):
        with self.files() as files:
            directory = files.snapshot.parent
            directory.rename(files.root / "snapshots-original")
            directory.symlink_to(files.root / "snapshots-original", target_is_directory=True)
            with self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(files.engine.mutations, [])
        with self.files() as files:
            files.snapshot.chmod(0o644)
            with self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(files.engine.mutations, [])

    def test_same_bytes_written_during_read_are_detected(self):
        with self.files() as files:
            original, inode, changed = H.os.read, files.snapshot.stat().st_ino, [False]
            def read(fd, count):
                raw = original(fd, count)
                if not changed[0] and os.fstat(fd).st_ino == inode:
                    changed[0] = True
                    files.write(files.snapshot, files.old)
                return raw
            with patch.object(H.os, "read", side_effect=read), self.assertRaises(H.Stop):
                files.run()
            self.assertTrue(changed[0])
            self.assertEqual(files.engine.mutations, [])

    def test_corrupt_receipt_readback_prevents_stop(self):
        with self.files() as files:
            original = H.Directory.read
            def read(directory, filename, *args, **kwargs):
                if filename == "backup-payload.json":
                    files.write(files.root / "receipts" / filename, '{"synthetic":"corrupted"}')
                return original(directory, filename, *args, **kwargs)
            with patch.object(H.Directory, "read", new=read), self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(files.engine.mutations, [])

    def test_even_reviewed_unacknowledged_reservation_prevents_lease(self):
        with self.files() as files:
            reservation = json.loads(files.reservation.read_text())
            reservation["acknowledgments"][0]["acknowledged"] = False
            files.write(files.reservation, H.canonical(reservation))
            files.plan["reservation_sha256"] = H.E.sha(reservation)
            files.adapter.close()
            files.adapter = H.HostProofAdapter(files.plan, files.scope, files.sink, mounted_reader=files.reader)
            with self.assertRaises(H.Stop):
                files.run()
            self.assertFalse((files.snapshot.parent / H.LEASE).exists())
            self.assertEqual(files.engine.mutations, [])

    def test_input_directory_swap_after_backup_prevents_transition(self):
        with self.files() as files:
            files.initial()
            original = files.root / "inputs"
            original.rename(files.root / "inputs-old")
            original.mkdir(mode=0o700)
            files.engine.old["State"]["Running"] = False
            with self.assertRaises(H.Stop):
                files.adapter.invoke("stopped-transition", {"old_sha256": files.plan["snapshot"]["old_sha256"],
                                     "new_sha256": files.plan["snapshot"]["new_sha256"], "stopped_inspect": files.engine.old}, files.budget())
            self.assertEqual(files.snapshot.read_text(), files.old)

    def test_competing_snapshot_write_after_staging_is_preserved(self):
        with self.files() as files:
            original = H.Directory.write
            def change(directory, filename, raw, owner, budget, **kwargs):
                result = original(directory, filename, raw, owner, budget, **kwargs)
                if filename == H.STAGE:
                    files.write(files.snapshot, "synthetic competing snapshot")
                return result
            with patch.object(H.Directory, "write", new=change), self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(len(files.engine.mutations), 1)
            self.assertEqual(files.snapshot.read_text(), "synthetic competing snapshot")
            self.assertTrue((files.snapshot.parent / H.STAGE).exists())

    def test_stage_changed_during_intervening_checks_is_never_renamed(self):
        for change in ("content", "same-bytes", "inode", "symlink"):
            with self.subTest(change=change), self.files() as files:
                original, changed = files.adapter.journal, [False]
                old_inode = files.snapshot.stat().st_ino
                def journal(budget):
                    result = original(budget)
                    staged = files.snapshot.parent / H.STAGE
                    if staged.exists() and not changed[0]:
                        changed[0] = True
                        if change in ("content", "same-bytes"):
                            files.write(staged, "x" * len(files.new) if change == "content" else files.new)
                            info = staged.stat()
                            os.utime(staged, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
                        elif change == "inode":
                            replacement = files.snapshot.parent / "replacement-stage"
                            files.write(replacement, files.new)
                            os.rename(replacement, staged)
                        else:
                            staged.unlink()
                            staged.symlink_to(files.next_snapshot)
                    return result
                files.adapter.journal = journal
                with patch.object(H.os, "replace", wraps=H.os.replace) as replace, self.assertRaises(H.Stop):
                    files.run()
                self.assertTrue(changed[0])
                replace.assert_not_called()
                self.assertEqual(files.snapshot.read_text(), files.old)
                self.assertEqual(files.snapshot.stat().st_ino, old_inode)
                self.assertEqual(len(files.engine.mutations), 1)
                self.assertFalse((files.root / "receipts/host-snapshot-rename-confirmed.json").exists())

    def test_stopped_journal_samples_detect_same_size_rewrites_and_replacement(self):
        for filename in ("journal.jsonl", "dead-letter.jsonl", "state/journal.base.json", "state/sentry.offset.json"):
            for replacement in (False, True):
                with self.subTest(file=filename, replacement=replacement), self.files() as files:
                    files.write(files.journal / "dead-letter.jsonl", "synthetic dead letter")
                    original, changed = files.adapter.journal, [False]
                    target = files.journal / filename
                    raw = target.read_text()
                    def journal(budget):
                        if (files.snapshot.parent / H.STAGE).exists() and not changed[0]:
                            changed[0] = True
                            if replacement:
                                alternate = target.parent / "replacement-journal-file"
                                files.write(alternate, raw)
                                os.rename(alternate, target)
                            else:
                                files.write(target, raw)
                                info = target.stat()
                                os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
                        return original(budget)
                    files.adapter.journal = journal
                    with patch.object(H.os, "replace", wraps=H.os.replace) as replace, self.assertRaises(H.Stop):
                        files.run()
                    self.assertTrue(changed[0])
                    replace.assert_not_called()
                    self.assertEqual(files.snapshot.read_text(), files.old)
                    self.assertEqual(len(files.engine.mutations), 1)

    def test_state_inode_change_within_one_journal_sample_is_refused(self):
        for filename in ("journal.base.json", "sentry.offset.json"):
            with self.subTest(file=filename), self.files() as files:
                original, changed = H.Directory.read, [False]
                def read(directory, candidate, *args, **kwargs):
                    result = original(directory, candidate, *args, **kwargs)
                    if candidate == filename and kwargs.get("with_signature") and not changed[0]:
                        changed[0] = True
                        target = files.journal / "state" / filename
                        alternate = target.parent / "replacement-state"
                        files.write(alternate, target.read_text())
                        os.rename(alternate, target)
                    return result
                with patch.object(H.Directory, "read", new=read), self.assertRaises(H.Stop):
                    files.run()
                self.assertTrue(changed[0])
                self.assertEqual(files.snapshot.read_text(), files.old)
                self.assertEqual(len(files.engine.mutations), 1)

    def test_prestart_journal_inode_change_prevents_start(self):
        with self.files() as files:
            original = files.reader.read
            def read(container_id, *, running, budget):
                raw = original(container_id, running=running, budget=budget)
                if not running:
                    target = files.journal / "journal.jsonl"
                    alternate = target.parent / "replacement-before-start"
                    files.write(alternate, target.read_text())
                    os.rename(alternate, target)
                return raw
            files.reader.read = read
            with self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(len(files.engine.mutations), 3)
            self.assertFalse(files.engine.containers[files.engine.new_id]["State"]["Running"])

    def test_poststart_physical_file_changes_allow_valid_journal_progress(self):
        with self.files() as files:
            original = files.reader.read
            def read(container_id, *, running, budget):
                raw = original(container_id, running=running, budget=budget)
                if running:
                    files.write(files.journal / "journal.jsonl", "x" * 110)
                    files.write(files.journal / "state/sentry.offset.json", '{"offset":100}')
                return raw
            files.reader.read = read
            self.assertFalse(files.run()["live_execution_enabled"])

    def test_landed_rename_then_directory_fsync_failure_is_not_rolled_back(self):
        with self.files() as files:
            replace, fsync = H.os.replace, H.os.fsync
            landed = [False]
            def renamed(*args, **kwargs):
                result = replace(*args, **kwargs)
                landed[0] = True
                return result
            def sync(fd):
                if landed[0] and stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError("synthetic post-rename fsync failure")
                return fsync(fd)
            with patch.object(H.os, "replace", side_effect=renamed), patch.object(H.os, "fsync", side_effect=sync), self.assertRaises(H.Stop):
                files.run()
            self.assertTrue(landed[0])
            self.assertEqual(files.snapshot.read_text(), files.new)
            self.assertEqual(len(files.engine.mutations), 1)
            self.assertTrue((files.root / "receipts/host-snapshot-rename-intent.json").exists())
            self.assertFalse((files.root / "receipts/host-snapshot-rename-confirmed.json").exists())

    def test_pending_compaction_or_invalid_offset_prevents_snapshot_replacement(self):
        for filename, raw in (("journal.base.json", '{"base":0,"nextBase":1,"pendingSize":1}'),
                              ("sentry.offset.json", '{"offset":101}'),
                              ("sentry.offset.json", '{"offset":90,"offset":91}'),
                              ("journal.base.json", '{"base":9007199254740992,"nextBase":9007199254740992,"pendingSize":0}')):
            with self.files() as files:
                files.write(files.journal / "state" / filename, raw)
                with self.assertRaises(H.Stop):
                    files.run()
                self.assertEqual(files.snapshot.read_text(), files.old)
                self.assertEqual(len(files.engine.mutations), 1)

    def test_journal_and_dead_letter_bodies_are_never_read(self):
        with self.files() as files:
            files.write(files.journal / "dead-letter.jsonl", "synthetic dead letter")
            original = H.Directory.read
            def read(directory, filename, *args, **kwargs):
                self.assertNotIn(filename, ("journal.jsonl", "dead-letter.jsonl"))
                return original(directory, filename, *args, **kwargs)
            with patch.object(H.Directory, "read", new=read):
                files.run()

    def test_old_bound_inode_prevents_start_after_real_host_rename(self):
        with self.files() as files:
            files.reader.bind()
            files.reader.sticky_old = True
            with self.assertRaises(H.Stop):
                files.run()
            self.assertEqual(files.snapshot.read_text(), files.new)
            self.assertEqual(len(files.engine.mutations), 3)
            self.assertFalse(files.engine.containers[files.engine.new_id]["State"]["Running"])

    def test_prior_common_lease_blocks_second_receipt_directory(self):
        with self.files() as files:
            files.initial()
            directory = files.root / "second-receipts"
            directory.mkdir(mode=0o700)
            scope = copy.deepcopy(files.scope)
            scope["receipt_directory"] = str(directory)
            scope["pins"]["receipts"] = H.directory_identity(directory.stat())
            sink = H.DurableReceipts(str(directory), scope["pins"]["receipts"])
            adapter = H.HostProofAdapter(files.plan, scope, sink)
            try:
                with self.assertRaises(H.Stop):
                    adapter.invoke("preflight-recovery", {"inspect": files.engine.old,
                                   "payload": H.E.M.pinned_create_payload(files.engine.old)}, files.budget())
            finally:
                adapter.close()
                sink.close()
            self.assertEqual(files.snapshot.read_text(), files.old)

    def test_default_reader_and_cli_cannot_read_live_resources(self):
        with self.assertRaises(H.Stop):
            H.RefusingMountedReader().read("b" * 64, running=False, budget=H.E.Deadline(lambda: 0))
        for execute in (False, True):
            argv = ["host-proof-adapter.py"] + (["--execute"] if execute else [])
            with patch.object(H.sys, "argv", argv), patch.object(H.os, "open") as opened, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if execute:
                    with self.assertRaises(SystemExit) as stopped:
                        H.main()
                    self.assertEqual(stopped.exception.code, 2)
                else:
                    H.main()
                opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
