"""Exercise the workflow's actual shell gate, preserving fork and unknown-bot denial."""
from pathlib import Path
import os
import subprocess
import unittest

SOURCE = Path(__file__).resolve().parents[1] / ".github/workflows/security.yml"


class ActorGuard(unittest.TestCase):
    def gate(self, actor, head="Simple-With-Us/Usage-Monitor"):
        text = SOURCE.read_text()
        start = text.index("        run: |\n") + len("        run: |\n")
        end = text.index("      - uses:", start)
        script = "\n".join(line[10:] for line in text[start:end].splitlines())
        script = script.replace(
            "${{ github.event.pull_request.head.repo.full_name }}", head
        )
        script = script.replace("${{ github.repository }}", "Simple-With-Us/Usage-Monitor")
        # Pass actor via env so special characters cannot break bash quoting.
        script = script.replace("${{ github.actor }}", "${ACTOR}")
        env = os.environ.copy()
        env["ACTOR"] = actor
        return subprocess.run(
            ["bash", "-c", script], capture_output=True, env=env
        ).returncode

    def test_verified_wise_same_repo(self):
        self.assertEqual(self.gate("swu-wise[bot]"), 0)

    def test_wise_fork_denied(self):
        self.assertNotEqual(self.gate("swu-wise[bot]", "other/Usage-Monitor"), 0)

    def test_unknown_bot_denied(self):
        self.assertNotEqual(self.gate("unknown[bot]"), 0)

    def test_lookalike_bot_denied(self):
        self.assertNotEqual(self.gate("swu-wise-other[bot]"), 0)

    def test_existing_trusted_bot(self):
        self.assertEqual(self.gate("swu-echo[bot]"), 0)

    def test_human_unchanged(self):
        self.assertEqual(self.gate("jaywedgeworth22"), 0)

    def test_actor_with_shell_metachar_does_not_break_gate(self):
        self.assertNotEqual(self.gate('evil"[bot]'), 0)

    def test_read_only_runner_and_scanner_unchanged(self):
        source = SOURCE.read_text()
        self.assertIn("runs-on: ubuntu-latest", source)
        self.assertIn("permissions:\n      contents: read", source)
        self.assertIn("gitleaks git --no-banner --redact --exit-code 0", source)
        self.assertIn('if [ "$count" -gt 0 ]; then', source)


if __name__ == "__main__":
    unittest.main()
