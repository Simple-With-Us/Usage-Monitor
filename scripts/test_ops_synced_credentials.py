"""Offline credential checks; never run either operational entrypoint."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parent


class IsolatedOpsFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ops-synced-credentials-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.bin = self.home / ".local" / "bin"
        self.bin.mkdir(parents=True)
        self.marker = self.home / "unexpected-operation"
        for name in (
            "fleet-secrets", "infisical", "security", "curl", "id", "tailscale",
            "jq", "sed", "head", "awk", "sw_vers", "sysctl", "uname", "top",
            "iostat", "vm_stat", "df", "pgrep", "ps", "pm2", "launchctl", "date",
        ):
            executable = self.bin / name
            executable.write_text(
                '#!/bin/sh\nprintf invoked >> "$FIXTURE_OPS_MARKER"\nexit 97\n',
                encoding="utf-8",
            )
            executable.chmod(0o700)
        self.environment = {
            "HOME": str(self.home), "PATH": str(self.bin), "LC_ALL": "C",
            "FIXTURE_OPS_MARKER": str(self.marker),
            "FLEET_SECRETS_BIN": str(self.bin / "fleet-secrets"),
        }

    def tearDown(self):
        self.assertFalse(self.marker.exists(), "credential or operational trap ran")


class NamecheapSyncedCredentialsTests(IsolatedOpsFixture):
    def setUp(self):
        super().setUp()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, self.environment, clear=True))
        self.guards = [
            self.stack.enter_context(mock.patch(target, side_effect=AssertionError("unexpected operation")))
            for target in (
                "urllib.request.urlopen", "socket.getaddrinfo", "socket.create_connection",
                "subprocess.Popen", "os.system",
            )
        ]
        self.stdout = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stderr = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        spec = importlib.util.spec_from_file_location("namecheap_credential_fixture", SCRIPTS / "namecheap.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def tearDown(self):
        for guard in self.guards:
            guard.assert_not_called()
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")
        super().tearDown()

    def test_actual_getters_preserve_environment_quote_and_space_normalization(self):
        os.environ.update({
            "NAMECHEAP_API_KEY": '  "fixture-namecheap-key"  ',
            "NAMECHEAP_API_USER": " 'fixture-namecheap-user' ",
        })
        self.assertEqual(self.module.get_api_key(), "fixture-namecheap-key")
        self.assertEqual(self.module.get_api_user(), "fixture-namecheap-user")

    def test_actual_getters_follow_changed_then_removed_environment_values(self):
        os.environ["NAMECHEAP_API_KEY"] = "fixture-first-key"
        self.assertEqual(self.module.get_api_key(), "fixture-first-key")
        os.environ["NAMECHEAP_API_KEY"] = "fixture-changed-key"
        self.assertEqual(self.module.get_api_key(), "fixture-changed-key")
        del os.environ["NAMECHEAP_API_KEY"]
        self.assertIsNone(self.module.get_api_key())
        self.assertIsNone(self.module.get_api_user())

    def test_missing_and_blank_tuple_refuses_before_ip_discovery_or_api(self):
        cases = (
            ({}, "NAMECHEAP_API_KEY"),
            ({"NAMECHEAP_API_USER": "fixture-namecheap-user"}, "NAMECHEAP_API_KEY"),
            ({"NAMECHEAP_API_KEY": "fixture-namecheap-key"}, "NAMECHEAP_API_USER"),
            ({"NAMECHEAP_API_KEY": " \t", "NAMECHEAP_API_USER": "fixture-namecheap-user"}, "NAMECHEAP_API_KEY"),
            ({"NAMECHEAP_API_KEY": "fixture-namecheap-key", "NAMECHEAP_API_USER": '""'}, "NAMECHEAP_API_USER"),
            ({"INFISICAL_TOKEN": "st.other", "USAGE_INGEST_TOKEN": "fixture-other-token"}, "NAMECHEAP_API_KEY"),
        )
        for values, missing in cases:
            with self.subTest(missing=missing), mock.patch.dict(os.environ, {**self.environment, **values}, clear=True):
                with mock.patch.object(self.module, "get_public_ip", side_effect=AssertionError("unexpected IP discovery")) as discover:
                    with self.assertRaises(ValueError) as error:
                        self.module.call_namecheap("namecheap.users.getBalances")
                    self.assertEqual(str(error.exception), f"{missing} required in the Infisical-synced environment")
                    discover.assert_not_called()

    def test_explicit_api_credentials_skip_environment_getters_before_transport(self):
        class StopBeforeTransport(Exception):
            pass

        with mock.patch.object(self.module, "get_api_key", side_effect=AssertionError("unexpected key lookup")) as key:
            with mock.patch.object(self.module, "get_api_user", side_effect=AssertionError("unexpected user lookup")) as user:
                with mock.patch.object(self.module, "get_public_ip", side_effect=StopBeforeTransport):
                    with self.assertRaises(StopBeforeTransport):
                        self.module.call_namecheap(
                            "namecheap.users.getBalances", api_user="fixture-explicit-user", api_key="fake-key",
                        )
                key.assert_not_called()
                user.assert_not_called()


class WatchdogSyncedCredentialsTests(IsolatedOpsFixture):
    """The heartbeat token comes from the login keychain and nowhere else.

    Owner ruling, November 22, 2026:  the environment is never a source, and a
    copy of a secret in the environment is a defect, not a fallback.  The
    keychain is this consumer's own store, so the test makes `security` a reader
    instead of a trap, and pins that the environment cannot supply or shadow the
    credential.
    """

    def setUp(self):
        super().setUp()
        source = (SCRIPTS / "ops" / "mac-server-watchdog.sh").read_text(encoding="utf-8")
        start = "set -euo pipefail\n"
        end = '\nHOSTNAME="jays.services"\n'
        self.assertEqual(source.count(start), 1)
        self.assertEqual(source.count(end), 1)
        self.assertLess(source.index(start), source.index(end))
        # Only the actual auth prefix is executable here; all probes and POSTs
        # are beyond the unique end marker and never enter the child program.
        self.prefix = source[source.index(start):source.index(end)]
        self.calls = self.home / "keychain-calls"
        # `security` is the source, so it reads instead of tripping the trap.
        # A blank value is a missing item (security exit 44).
        reader = self.bin / "security"
        reader.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FIXTURE_KEYCHAIN_CALLS"\n'
            'if [ -n "$FIXTURE_KEYCHAIN_VALUE" ]; then printf "%s" "$FIXTURE_KEYCHAIN_VALUE"; exit 0; fi\n'
            'exit 44\n',
            encoding="utf-8",
        )
        reader.chmod(0o700)

    def run_prefix(self, values, expected=None, keychain=""):
        environment = {
            **self.environment,
            "INGEST_URL": "http://127.0.0.1:9/unused-fixture",
            "MAC_HEARTBEAT_SECURITY_BIN": str(self.bin / "security"),
            "FIXTURE_KEYCHAIN_CALLS": str(self.calls),
            "FIXTURE_KEYCHAIN_VALUE": keychain,
            **values,
        }
        program = self.prefix
        if expected is not None:
            environment["FIXTURE_EXPECTED_TOKEN"] = expected
            program += '\n[[ "$TOKEN" == "$FIXTURE_EXPECTED_TOKEN" ]] || exit 91\n'
            program += '[[ "$INGEST_URL" == "http://127.0.0.1:9/unused-fixture" ]] || exit 92\n'
        with subprocess.Popen(
            ["/bin/bash", "-s"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=environment,
        ) as child:
            try:
                stdout, stderr = child.communicate(program, timeout=15)
            except subprocess.TimeoutExpired:
                child.send_signal(signal.SIGKILL)
                child.communicate(timeout=5)
                self.fail("Watchdog auth fixture exceeded its 15 second deadline")
            self.assertGreaterEqual(child.returncode, 0, "auth fixture terminated by signal")
        self.assertEqual(stdout, "")
        self.assertFalse(self.marker.exists(), "auth prefix attempted an external command")
        for value in values.values():
            if value.strip():
                self.assertNotIn(value, stderr)
        return child.returncode, stderr

    def keychain_accounts(self):
        if not self.calls.exists():
            return []
        return [
            line.split(" -a ", 1)[1].split()[0]
            for line in self.calls.read_text(encoding="utf-8").splitlines()
            if " -a " in line
        ]

    def test_the_keychain_value_is_the_credential(self):
        status, stderr = self.run_prefix({}, expected="fixture-keychain-token", keychain="fixture-keychain-token")
        self.assertEqual((status, stderr), (0, ""))
        self.assertEqual(self.keychain_accounts()[0], "mac-host-heartbeat-read")

    def test_the_environment_is_not_a_source(self):
        # A copy of the token in the environment neither supplies the credential
        # nor shadows the keychain value.
        for values in (
            {"MAC_HEARTBEAT_INGEST_TOKEN": "fixture-dedicated"},
            {"USAGE_INGEST_TOKEN": "fixture-legacy"},
            {"MAC_HEARTBEAT_INGEST_TOKEN": "fixture-dedicated", "USAGE_INGEST_TOKEN": "fixture-legacy"},
        ):
            with self.subTest(names=tuple(values)):
                status, stderr = self.run_prefix(values, expected="fixture-keychain-token", keychain="fixture-keychain-token")
                self.assertEqual((status, stderr), (0, ""))

    def test_a_missing_keychain_item_refuses_and_names_both_accounts(self):
        status, stderr = self.run_prefix({})
        self.assertEqual(status, 1)
        self.assertIn("infisical-service-token", stderr)
        self.assertIn("mac-host-heartbeat-read", stderr)
        self.assertIn("USAGE_INGEST_TOKEN", stderr)
        self.assertIn("service-tokens skill", stderr)

    def test_unrelated_bootstrap_never_becomes_a_heartbeat_credential(self):
        status, stderr = self.run_prefix({
            "INFISICAL_TOKEN": "st.other", "TOKEN": "fixture-ambient-token",
            "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID": "fixture-client", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET": "fixture-secret",
        })
        self.assertEqual(status, 1)
        self.assertIn("the login keychain", stderr)


if __name__ == "__main__":
    unittest.main()
