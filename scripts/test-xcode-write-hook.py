import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / '.codex/hooks/block-xcode-project-writes.py'

class XcodeGuardTests(unittest.TestCase):
    def run_hook(self, raw):
        return subprocess.run([sys.executable, str(HOOK)], input=raw, text=True, capture_output=True)

    def test_known_file_payloads_and_paths(self):
        for key in ('file_path', 'filePath', 'path'):
            for path, status in [('ios/Bar.swift', 0), ('App.xcodeproj', 2), ('App.xcodeproj/project.pbxproj', 2), ('App.xcworkspace/contents.xcworkspacedata', 2), ('Main.xib', 2), ('A\\App.entitlements', 2)]:
                with self.subTest(key=key, path=path):
                    self.assertEqual(self.run_hook(json.dumps({'tool_input': {key: path}})).returncode, status)

    def test_malformed_inputs_fail_closed(self):
        for raw in ('', '{', 'null', '[]', '{}', '{"tool_input":null}', '{"tool_input":[]}', '{"tool_input":{"file_path":""}}', '{"tool_input":{"command":42}}'):
            with self.subTest(raw=raw):
                result = self.run_hook(raw)
                self.assertEqual(result.returncode, 2)
                self.assertIn('Cannot determine', result.stderr)

    def test_every_patch_path_and_move_destination_is_checked(self):
        for directive in ('Update File', 'Add File', 'Delete File', 'Move to'):
            command = f'*** Begin Patch\n*** Update File: Safe.swift\n@@\n+text\n*** {directive}: App.entitlements\n*** End Patch'
            raw = json.dumps({'tool_name': 'apply_patch', 'tool_input': {'command': command, 'file_path': 'Safe.swift'}})
            self.assertEqual(self.run_hook(raw).returncode, 2, directive)
        command = '*** Begin Patch\n*** Add File: A.swift\n+text\n*** Update File: B.swift\n@@\n-old\n+new\n*** End of File\n*** End Patch'
        self.assertEqual(self.run_hook(json.dumps({'tool_input': {'command': command}})).returncode, 0)

    def test_unknown_patch_shapes_fail_closed(self):
        for command in ('echo hello', '*** Begin Patch\n*** End Patch', '*** Begin Patch\n*** Update File: \n*** End Patch', '*** Begin Patch\n*** Surprise: A.swift\n*** End Patch'):
            self.assertEqual(self.run_hook(json.dumps({'tool_input': {'command': command}})).returncode, 2)

    def test_config_resolves_git_root_from_subdirectory_without_installing_hook(self):
        config = json.loads((ROOT / '.codex/hooks.json').read_text())
        command = config['hooks']['PreToolUse'][0]['hooks'][0]['command']
        self.assertNotIn('/Volumes/', command)
        raw = json.dumps({'tool_input': {'file_path': 'App.entitlements'}})
        result = subprocess.run(['bash', '-c', command], cwd=ROOT / 'scripts', input=raw, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Do not hand-edit', result.stderr)
        result = subprocess.run(['bash', '-c', command], cwd=ROOT / 'scripts', input=json.dumps({'tool_input': {'file_path': 'A.swift'}}), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_guard_has_explicit_diagnostic_and_blocks(self):
        command = json.loads((ROOT / '.codex/hooks.json').read_text())['hooks']['PreToolUse'][0]['hooks'][0]['command']
        with tempfile.TemporaryDirectory() as folder:
            subprocess.run(['git', 'init', '-q', folder], check=True)
            result = subprocess.run(['bash', '-c', command], cwd=folder, input='{}', text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('guard script is missing', result.stderr)
        self.assertIn('test:xcode-write-hook', json.loads((ROOT / 'package.json').read_text())['scripts']['verify'])
        self.assertIn('run: npm run test:xcode-write-hook', (ROOT / '.github/workflows/ci.yml').read_text())

if __name__ == '__main__':
    unittest.main()
