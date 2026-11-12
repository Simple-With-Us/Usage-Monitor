#!/usr/bin/env python3

import ast
import os
import re
import sys
from pathlib import Path

# Load MAX_RUNTIME_OVERRIDES from sentry-ci-report.py without executing it
repo_root = Path(__file__).resolve().parent.parent
script_path = repo_root / "scripts" / "sentry-ci-report.py"

if not script_path.exists():
    print(f"Error: {script_path} not found")
    sys.exit(1)

text = script_path.read_text(encoding="utf-8")
m = re.search(r"MAX_RUNTIME_OVERRIDES\s*=\s*\{([^}]*)\}", text, re.DOTALL)
if not m:
    print("Error: Could not find MAX_RUNTIME_OVERRIDES in sentry-ci-report.py")
    sys.exit(1)

dict_str = "{" + m.group(1) + "}"
try:
    overrides = eval(dict_str)
except Exception as e:
    print(f"Error parsing MAX_RUNTIME_OVERRIDES: {e}")
    sys.exit(1)

# Now check ios-ship.yml
ios_ship_path = repo_root / ".github" / "workflows" / "ios-ship.yml"
if not ios_ship_path.exists():
    print(f"Error: {ios_ship_path} not found")
    sys.exit(1)

ios_ship_text = ios_ship_path.read_text(encoding="utf-8")
timeout_match = re.search(r"timeout-minutes:\s*(\d+)", ios_ship_text)
if not timeout_match:
    print(f"Error: Could not find timeout-minutes in {ios_ship_path.name}")
    sys.exit(1)

timeout_minutes = int(timeout_match.group(1))

# The rule: max_runtime = 120 (predecessor timeout) + 10 (runner alloc) + 120 (this run) + 5 (reporter)
# So max_runtime = timeout_minutes * 2 + 15  (Wait, 10+5=15). 
# Wait, the comment says: 
# 260 = 120 (predecessor's own concurrency-queue ceiling) + 10 (macos-latest runner allocation) + 120 (this run's own timeout-minutes) + 5 (completed-event delivery + reporter), rounded up.
# So timeout_minutes * 2 + 15. Wait, 120 * 2 + 15 = 255. Rounded up is 260.
# Let's enforce timeout_minutes * 2 + 20

expected_override = timeout_minutes * 2 + 20

key = "iOS TestFlight ship (Mac runner)"
actual_override = overrides.get(key)

if actual_override is None:
    print(f"Error: '{key}' not found in MAX_RUNTIME_OVERRIDES")
    sys.exit(1)

if actual_override != expected_override:
    print(f"Error: MAX_RUNTIME_OVERRIDES['{key}'] is {actual_override}, expected {expected_override} (based on timeout-minutes: {timeout_minutes} in ios-ship.yml * 2 + 20)")
    sys.exit(1)


def _assign_value(tree: ast.AST, name: str):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if name in targets:
                return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {script_path.name}")


tree = ast.parse(text)
default_margin = _assign_value(tree, "DEFAULT_CHECKIN_MARGIN")
margin_overrides = _assign_value(tree, "CHECKIN_MARGIN_OVERRIDES")
schedules = _assign_value(tree, "CRON_SCHEDULES")

if default_margin != 15:
    print(f"Error: DEFAULT_CHECKIN_MARGIN is {default_margin}, expected 15")
    sys.exit(1)

expected_margins = {
    "CI": 480,
    "iOS TestFlight ship (Mac runner)": 480,
    "Effort Issues Sync": 600,
}
if margin_overrides != expected_margins:
    print(f"Error: CHECKIN_MARGIN_OVERRIDES is {margin_overrides}, expected {expected_margins}")
    sys.exit(1)

if schedules.get("Effort Issues Sync") != "12 6 * * *":
    print(f"Error: CRON_SCHEDULES['Effort Issues Sync'] is {schedules.get('Effort Issues Sync')}, expected '12 6 * * *'")
    sys.exit(1)

print("MARGIN_PARSE_OK", margin_overrides)
print("EFFORT_SYNC_CRON_OK", schedules["Effort Issues Sync"])
print("test-sentry-ci-report.py: PASSED")
