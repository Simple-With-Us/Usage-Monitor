"""Offline fixtures only; no credential, SSH, launchctl or native-source access."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-collector-coverage.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class AuditTests(unittest.TestCase):
    def test_default_plan_does_not_inspect_host_or_launch_processes(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["audit"]), patch.object(M, "audit") as audit, patch.object(M.subprocess, "run") as run, contextlib.redirect_stdout(output):
            M.main()
        self.assertEqual(json.loads(output.getvalue())["mode"], "offline_plan")
        audit.assert_not_called()
        run.assert_not_called()

    def test_local_audit_refuses_without_matching_expected_home(self):
        for argv in (["audit", "--audit-local-mac"], ["audit", "--audit-local-mac", "--expected-home", "/nonexistent-home"]):
            with patch.object(sys, "argv", argv), patch.object(M.platform, "system", return_value="Darwin"), patch.object(M, "audit") as audit:
                with self.assertRaises(SystemExit):
                    M.main()
            audit.assert_not_called()

    def test_regular_bounded_file_refuses_symlink_ancestors_and_oversize(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "file"
            path.write_bytes(b"synthetic")
            self.assertEqual(M.bounded_file(path), b"synthetic")
            with self.assertRaises(ValueError):
                M.bounded_file(path, limit=2)
            link = root / "link"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(OSError):
                M.bounded_file(link / "file")

    def test_tree_never_opens_native_content_or_follows_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            native = root / "native"
            native.mkdir()
            (native / "wire.jsonl").write_text("DO-NOT-READ-PROMPT")
            (native / "outside").symlink_to(root, target_is_directory=True)
            with patch.object(M, "bounded_file", side_effect=AssertionError("native content read")):
                result = M.tree_metadata(native, time.time())
            self.assertTrue(result["complete"])
            self.assertEqual(result["files"], 1)
            self.assertEqual(result["wire_files"], 1)
            self.assertNotIn("DO-NOT-READ-PROMPT", json.dumps(result))

    def test_scan_limit_marks_incomplete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in ("one", "two"):
                (root / name).touch()
            with patch.object(M, "MAX_TREE_ENTRIES", 1):
                result = M.tree_metadata(root, time.time())
            self.assertFalse(result["complete"])
            self.assertTrue(result["entry_limit_reached"])

    def test_plist_and_launchctl_values_are_never_relayed(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            agents = home / "Library" / "LaunchAgents"
            agents.mkdir(parents=True)
            label = M.JOBS["kimi-code"]
            secret = "SYNTHETIC-SECRET-DO-NOT-RELAY"
            config = {"ProgramArguments": ["node", "/approved/scripts/collector-injector.mjs", secret],
                      "EnvironmentVariables": {"TOKEN": secret}, "StartInterval": 300}
            (agents / (label + ".plist")).write_bytes(plistlib.dumps(config))
            reply = type("Reply", (), {"returncode": 0, "stdout": b"last exit code = 0\n" + secret.encode()})()
            with patch.object(M.subprocess, "run", return_value=reply) as run:
                result = M.job_metadata(home, "kimi-code", label)
            self.assertTrue(result["loaded"])
            self.assertTrue(result["injector_argument_present"])
            self.assertEqual(result["last_exit_code"], 0)
            self.assertNotIn(secret, json.dumps(result))
            self.assertEqual(run.call_args.args[0], ["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"])

    def test_wrong_host_refuses_before_inspection(self):
        with patch.object(sys, "argv", ["audit", "--audit-local-mac"]), patch.object(M.platform, "system", return_value="Linux"), patch.object(M, "audit") as audit:
            with self.assertRaises(SystemExit):
                M.main()
            audit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
