import importlib.util
from pathlib import Path
import unittest


HELPER = Path(__file__).with_name("prepare-um1646-inventory-update.py")
SPEC = importlib.util.spec_from_file_location("um1646_inventory_update", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class InventoryUpdateFixtureTests(unittest.TestCase):
    def test_note_inserts_six_rows_and_preserves_surrounding_and_peer_bytes(self):
        prefix = b"<div>Unrelated prior content</div>\n"
        heading = (
            b'<div><b><span style="font-size: 18px">Usage Monitor Telemetry (</span></b>'
            b'<b><u><a href="https://linear.app/simple-with-us/issue/UM-1646">'
            b'<span style="font-size: 18px">UM-1646</span></a></u></b>'
            b'<b><span style="font-size: 18px">)</span></b></div>'
        )
        gap = b"\n<div><br></div>\n<div><br><br></div>\n"
        private = b"<div>Private runtime routing and credentials remain in the private operations inventory and Infisical.</div>"
        peer = b"\n<div>Muse is installed but remains unloaded under the injector hold.</div>\n"
        source = prefix + heading + gap + private + peer
        botfleet = (
            b"| botfleet-session-collector.mjs | Mac and server active; first Mac pass stored 152 "
            b"authentic turn spans; " + MODULE.BOTFLEET_OLD_TAIL + b" |"
        )
        inventory = b"\n".join((
            b"## Usage Monitor Telemetry (UM-1646)",
            b"| Process / Helper | Schedule And Purpose |",
            MODULE.HUB_ROW,
            MODULE.BRIDGE_ROW,
            b"| scripts/prune-collector-sentry-outbox.mjs | " + MODULE.PRUNE_DESCRIPTION.encode() + b" |",
            b"| scripts/retry-collector-sentry-outbox.mjs | " + MODULE.RETRY_DESCRIPTION.encode() + b" |",
            botfleet,
            b"| UM-1646 Sentry Receipt Audit | " + MODULE.AUDIT_DESCRIPTION.encode() + b" |",
        )) + b"\n"
        inventory_after = MODULE._replace_inventory_rows(inventory)

        after, old_section, new_section = MODULE._note_after(source, inventory_after)

        self.assertEqual(old_section, heading + gap)
        self.assertEqual(after[:len(prefix)], prefix)
        self.assertTrue(after.endswith(private + peer))
        self.assertEqual(new_section.count(b"<li>"), 6)
        self.assertIn(b"scripts/prune-collector-sentry-outbox.mjs", new_section)
        self.assertIn(b"scripts/retry-collector-sentry-outbox.mjs", new_section)
        self.assertIn(b"UM-1646 Sentry Receipt Audit", new_section)
        self.assertIn(b"all eight retained child events are classified BotFleet", new_section)
        self.assertIn(b"first Mac pass stored 152 authentic turn spans", new_section)
        self.assertIn(b"/mnt/fleet-extra/apps/botfleet-server/data/workspaces", new_section)

    def test_nonblank_note_section_is_refused_without_changing_fixture(self):
        heading = b"<div>Usage Monitor Telemetry (UM-1646)</div>"
        source = (
            heading + b"\n<div>Peer addition that must remain untouched.</div>\n"
            b"<div>Private runtime routing and credentials remain in the private operations inventory and Infisical.</div>"
        )
        with self.assertRaisesRegex(MODULE.UpdateFailure, "note_target_section_not_blank"):
            MODULE._note_after(source, b"")
        self.assertIn(b"Peer addition that must remain untouched.", source)


if __name__ == "__main__":
    unittest.main()
