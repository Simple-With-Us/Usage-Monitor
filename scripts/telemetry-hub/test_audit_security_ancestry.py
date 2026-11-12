"""Offline checks; all process metadata is fabricated and subprocesses are stubbed."""
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("ancestry", Path(__file__).with_name("audit-security-ancestry.py"))
ancestry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ancestry)


class AncestryTests(unittest.TestCase):
    def test_unknown_text_is_not_emitted(self):
        marker = "UNTRUSTED_PROCESS_MARKER"
        row = ancestry.process_metadata(12, lambda args: (0, f"12 1 501 /unexpected/{marker}\n"))
        self.assertNotIn(marker, json.dumps(row))
        self.assertEqual(row["executable_name"], "other")
        self.assertFalse(any(row["candidate_name_matches"].values()))
        self.assertFalse(any(row["candidate_path_matches"].values()))

    def test_exact_name_and_path_comparisons(self):
        row = ancestry.executable_matches("/Users/jay/.local/bin/fleet-secrets")
        self.assertTrue(row["candidate_name_matches"]["fleet_secrets"])
        self.assertTrue(row["candidate_path_matches"]["local_fleet_secrets"])
        lookalike = ancestry.executable_matches("/Users/jay/.local/bin/fleet-secrets-malicious")
        self.assertFalse(any(lookalike["candidate_name_matches"].values()))
        self.assertFalse(any(lookalike["candidate_path_matches"].values()))

    def test_fixed_commands_and_ancestry(self):
        calls = []
        def run(args):
            calls.append(args)
            if args[0] == "/usr/bin/pgrep":
                return 0, "12\n"
            if args[2] == "12":
                return 0, "12 1 501 /usr/bin/security\n"
            return 0, "1 0 0 /sbin/launchd\n"
        result = ancestry.audit(501, run)
        self.assertEqual(len(result["security_processes"][0]), 2)
        self.assertEqual(calls[0], ["/usr/bin/pgrep", "-x", "-u", "501", "security"])
        for call in calls[1:]:
            self.assertEqual(call[0], "/bin/ps")
            self.assertEqual(call[3:], ["-o", "pid=,ppid=,uid=,comm="])

    def test_changed_or_different_process_refused(self):
        with self.assertRaises(ValueError):
            ancestry.process_metadata(12, lambda args: (0, "13 1 501 /usr/bin/security\n"))
        result = ancestry.audit(501, lambda args: (0, "12\n") if args[0].endswith("pgrep") else (0, "12 1 502 /usr/bin/security\n"))
        self.assertEqual(result["security_processes"], [])


if __name__ == "__main__":
    unittest.main()
