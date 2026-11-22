#!/usr/bin/env python3
"""Block agent Edit/Write on Xcode-managed project files.

Codex/Claude PreToolUse hook: reads the tool-input JSON on stdin.
Exit 0 = allow.  Exit 2 = block, including unknown/malformed edit input.

Also accepts a file path as argv[1] for tests and other seats.
"""
from __future__ import annotations

import json
import re
import sys

BLOCK_RE = re.compile(
    r"(?:\.pbxproj$|\.xcodeproj$|\.xcworkspace$|\.xib$|\.storyboard$|\.entitlements$"
    r"|xcodeproj/|xcworkspace/)",
    re.IGNORECASE,
)

BLOCK_MSG = (
    "BLOCKED: Do not hand-edit Xcode project files "
    "(.pbxproj, .xcodeproj/, .xcworkspace, .xib, .storyboard, .entitlements). "
    "Create the .swift file and report that it needs target membership. "
    "Where the app uses XcodeGen, edit project.yml and run xcodegen generate."
)


def is_blocked(path: str) -> bool:
    if not path:
        return False
    return bool(BLOCK_RE.search(path.replace("\\", "/")))


def paths_from_stdin(raw: str) -> list[str]:
    """Return every edit/rename path, or fail closed on an unknown payload."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("hook payload must be an object")
    tool_input = data.get("tool_input", data.get("toolInput"))
    if not isinstance(tool_input, dict):
        raise ValueError("missing edit input")
    # Native Codex apply_patch carries one patch, potentially touching many
    # files. Prefer it over any incidental file_path field in the envelope.
    if "command" in tool_input:
        command = tool_input["command"]
        if not isinstance(command, str):
            raise ValueError("patch command must be text")
        lines = command.strip().splitlines()
        if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
            raise ValueError("unknown patch format")
        paths: list[str] = []
        prefixes = ("*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move to: ")
        for line in lines[1:-1]:
            prefix = next((p for p in prefixes if line.startswith(p)), None)
            if prefix:
                path = line[len(prefix):].strip()
                if not path or "\x00" in path:
                    raise ValueError("empty patch path")
                paths.append(path)
            elif line.startswith("*** ") and line != "*** End of File":
                raise ValueError("unknown patch directive")
        if not paths:
            raise ValueError("patch has no edit paths")
        return paths
    for key in ("file_path", "filePath", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip() and "\x00" not in value:
            return [value.strip()]
    raise ValueError("missing edit path")


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        assert is_blocked("ios/Foo.xcodeproj/project.pbxproj")
        assert is_blocked("App/App.entitlements")
        assert is_blocked("Legacy/Main.storyboard")
        assert not is_blocked("ios/project.yml")
        assert not is_blocked("ios/Foo/Bar.swift")
        assert not is_blocked("Package.swift")
        return 0

    try:
        if len(argv) == 2 and argv[1].strip():
            paths = [argv[1].strip()]
        elif len(argv) == 1:
            paths = paths_from_stdin(sys.stdin.read())
        else:
            raise ValueError("expected one path or hook JSON")
    except (ValueError, TypeError):
        print("BLOCKED: Cannot determine every edit path from hook input.", file=sys.stderr)
        return 2
    if any(is_blocked(path) for path in paths):
        print(BLOCK_MSG, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
