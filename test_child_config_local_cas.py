"""Fixture-only tests for the private child configuration CAS helper."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import child_config_local_cas as cas


class ChildConfigLocalCASTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="child-config-cas-")
        self.root = Path(self.tempdir.name)
        self.source = self.root / "usage-monitor.env"
        self.original = b"UNRELATED_SECRET=fixture-only-value\nOTHER_SETTING=keep-this-byte-for-byte\n"
        self.source.write_bytes(self.original)
        self.source.chmod(0o600)
        self.subject = cas.ChildConfigLocalCAS(self.source)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_backup_and_append_preserve_unrelated_bytes_and_metadata(self) -> None:
        before = self.subject.snapshot()
        backup_result = self.subject.prepare_backup(before)
        self.assertEqual(backup_result["backup"], "created_and_verified")
        backup = self.root / cas.BACKUP_NAME
        self.assertEqual(backup.read_bytes(), self.original)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.stat().st_uid, os.getuid())

        result = self.subject.apply_local(before)
        self.assertEqual(result["status"], "applied_and_verified")
        updated = self.source.read_bytes()
        self.assertTrue(updated.startswith(self.original))
        self.assertIn(
            b"OPENCODE_ADDITIONAL_DBS_JSON='[\"/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db\"]'\n",
            updated,
        )
        self.assertIn(
            b"BOTFLEET_WORKSPACES_DIRS=/mnt/fleet-extra/apps/botfleet-server/data/workspaces\n",
            updated,
        )
        source_stat = self.source.stat()
        self.assertEqual(source_stat.st_mode & 0o777, 0o600)
        self.assertEqual(source_stat.st_uid, os.getuid())
        self.assertEqual(source_stat.st_gid, before.gid)

    def test_change_after_backup_aborts_without_overwriting_concurrent_bytes(self) -> None:
        before = self.subject.snapshot()
        self.subject.prepare_backup(before)
        concurrent = self.original + b"CONCURRENT=preserve\n"
        self.source.write_bytes(concurrent)
        self.source.chmod(0o600)

        with self.assertRaises(cas.CASFailure):
            self.subject.apply_local(before)
        self.assertEqual(self.source.read_bytes(), concurrent)

    def test_different_and_duplicate_target_assignments_are_rejected(self) -> None:
        cases = (
            b'OPENCODE_ADDITIONAL_DBS_JSON="[]"\n',
            (b'BOTFLEET_WORKSPACES_DIRS=/first\n'
             b'BOTFLEET_WORKSPACES_DIRS=/second\n'),
        )
        for contents in cases:
            with self.subTest(contents=contents):
                self.source.write_bytes(contents)
                self.source.chmod(0o600)
                with self.assertRaises(cas.CASFailure):
                    self.subject.snapshot()

    def test_symlink_source_and_backup_are_rejected(self) -> None:
        real_source = self.root / "real.env"
        real_source.write_bytes(self.original)
        self.source.unlink()
        self.source.symlink_to(real_source)
        with self.assertRaises(cas.CASFailure):
            self.subject.snapshot()

        self.source.unlink()
        self.source.write_bytes(self.original)
        self.source.chmod(0o600)
        before = self.subject.snapshot()
        backup_target = self.root / "backup-target"
        backup_target.write_bytes(self.original)
        (self.root / cas.BACKUP_NAME).symlink_to(backup_target)
        with self.assertRaises(cas.CASFailure):
            self.subject.prepare_backup(before)

    def test_exported_equal_keys_are_recognized_without_backup(self) -> None:
        exported = (
            b"export OPENCODE_ADDITIONAL_DBS_JSON='"
            b'["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"]'
            b"'\nexport BOTFLEET_WORKSPACES_DIRS="
            b"/mnt/fleet-extra/apps/botfleet-server/data/workspaces\n"
        )
        self.source.write_bytes(exported)
        self.source.chmod(0o600)
        before = self.subject.snapshot()
        self.assertTrue(all(state == "equal" for state in before.key_states.values()))

        result = self.subject.apply_local(before)
        self.assertEqual(result["status"], "already_equal")
        self.assertEqual(self.source.read_bytes(), exported)
        self.assertFalse((self.root / cas.BACKUP_NAME).exists())

    def test_partial_new_backup_is_preserved_after_write_failure(self) -> None:
        before = self.subject.snapshot()

        def fail_after_partial_write(fd: int, content: bytes) -> None:
            os.write(fd, content[:1])
            raise cas.CASFailure("injected_write_failure")

        with mock.patch.object(cas, "_write_all", side_effect=fail_after_partial_write):
            with self.assertRaises(cas.CASFailure):
                self.subject.prepare_backup(before)

        backup = self.root / cas.BACKUP_NAME
        self.assertTrue(backup.exists())
        self.assertEqual(backup.read_bytes(), self.original[:1])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
