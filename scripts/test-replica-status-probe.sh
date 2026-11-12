#!/usr/bin/env bash
# Offline checks for replica health probing scripts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEARTBEAT="$ROOT/scripts/replica-status-heartbeat.sh"
COOLIFY_PROBE="$ROOT/deploy/coolify/replica-status-probe.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

bash -n "$HEARTBEAT" || fail "heartbeat bash -n"
bash -n "$COOLIFY_PROBE" || fail "coolify probe bash -n"

grep -q '\-json' "$HEARTBEAT" || fail "heartbeat missing ltx -json"
grep -q 'SNAPSHOT_LEVEL=9' "$HEARTBEAT" || fail "heartbeat missing snapshot level 9"
grep -q 'list_timeout' "$HEARTBEAT" || fail "heartbeat missing list_timeout reason"
grep -q 'snapshot_only' "$HEARTBEAT" || fail "heartbeat missing snapshot_only reason"
grep -q 'empty_ltx' "$HEARTBEAT" || fail "heartbeat missing empty_ltx reason"

if grep -nE 'NF == 5' "$HEARTBEAT" >/dev/null; then
  fail "heartbeat still uses awk NF==5 parsing"
fi

if grep -nE 'for level in 0 1 2 3 4 5' "$HEARTBEAT" >/dev/null; then
  fail "heartbeat still scans levels 0-5"
fi

if grep -nE '\-level all' "$HEARTBEAT" "$COOLIFY_PROBE" >/dev/null; then
  fail "probe still uses -level all"
fi

# Host probe must never put replica secrets on docker exec argv.
if grep -nE 'extend\(\["-e"|"-e", f"\{k\}=' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still passes -e KEY=VALUE on docker exec argv"
fi
if grep -nE 'docker exec.*LITESTREAM_S3_' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe interpolates LITESTREAM_S3_* into docker exec argv"
fi
grep -q '\-\-env-file' "$COOLIFY_PROBE" || fail "coolify probe missing docker exec --env-file"

# Cost efficiency (2026-08-31): the in-container `docker exec ... --once`
# heartbeat attempt always fails on this infra (docker exec never carries
# the Infisical-injected env) and is short-circuited — the probe must go
# straight to the host env-file LTX fallback. The fallback probes level 0
# first (the common case resolves in 1 call) and only escalates to levels
# 1-3 when level 0 is empty/erroring/timed-out — litestream's brief L0
# retention can otherwise leave a real, fresh continuous tip sitting at
# L1-L3 invisible to an L0-only scan (a real bug caught by review on this
# change: PR #1378). Level 9 (snapshot) is queried only as the last resort.
if grep -nE 'run_in_container_heartbeat' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still attempts the always-failing in-container heartbeat"
fi
if grep -vE '^\s*#' "$COOLIFY_PROBE" | grep -nE 'docker exec.*replica-status-heartbeat\.sh' >/dev/null; then
  fail "coolify probe still execs replica-status-heartbeat.sh in-container"
fi
if grep -nE 'for level in \(0, 9\):' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe reverted to a naive fixed level-{0,9} scan (loses the L1-3 continuous tip when L0 is briefly empty)"
fi
if grep -nE 'for level in \(0, 1, 2, 3, 9\)' "$COOLIFY_PROBE" >/dev/null; then
  fail "coolify probe still scans all five levels unconditionally per tick"
fi
grep -q 'def probe_level' "$COOLIFY_PROBE" || fail "coolify probe missing the probe_level escalation helper"
grep -q 'continuous_newest = probe_level(0)' "$COOLIFY_PROBE" \
  || fail "coolify probe must try level 0 first"
grep -q 'for level in (1, 2, 3):' "$COOLIFY_PROBE" \
  || fail "coolify probe must escalate to levels 1-3 when level 0 is inconclusive"
grep -q 'snapshot_newest = probe_level(9)' "$COOLIFY_PROBE" \
  || fail "coolify probe must query level 9 only as the last resort"

# Functional check (not just grep): exec the ACTUAL escalation source from the
# probe script against mocked subprocess.run responses, so a subtle bug in the
# embedded heredoc (e.g. the `nonlocal` vs `global` mistake this design hit
# once already — a nonlocal reference with no enclosing function is a
# SyntaxError at exec time, invisible to `bash -n` and to any textual grep)
# fails this test instead of failing silently in production.
python3 - "$COOLIFY_PROBE" <<'PYEOF' || fail "coolify probe escalation logic self-test"
import json
import re
import subprocess
import sys

probe_path = sys.argv[1]
lines = open(probe_path, "r").read().splitlines()


def extract(start_pat, end_pat, dedent=False):
    start = next(i for i, l in enumerate(lines) if re.search(start_pat, l))
    end = next(i for i, l in enumerate(lines) if i > start and re.search(end_pat, l))
    block = lines[start:end + 1]
    if dedent:
        indent = len(block[0]) - len(block[0].lstrip(" "))
        block = [l[indent:] if l.startswith(" " * indent) else l for l in block]
    return "\n".join(block)


# classify() and newest_timestamp() are module-level (0-indent) helpers used
# by probe_level(); pull them in verbatim, no dedent needed.
classify_fn = extract(r"^def classify\(", r"^    return \"list_error\"$")
newest_ts_fn = extract(r"^def newest_timestamp\(", r"^    return sorted\(stamps\)\[-1\] if stamps else None$")
# probe_level() plus the level-0 -> 1-3 -> 9 escalation orchestration that
# calls it is nested one level inside the script's outer `try:` block;
# dedent so it execs as valid top-level statements.
escalation = extract(r"^    def probe_level\(level\):", r"snapshot_newest = probe_level\(9\)", dedent=True)

calls = []
SCENARIO = {}


def fake_run(cmd, **kwargs):
    level = cmd[cmd.index("-level") + 1]
    calls.append(level)
    return subprocess.CompletedProcess(cmd, 0, stdout=SCENARIO.get(level, "[]"), stderr="")


fake_subprocess = type(
    "FakeSubprocess", (), {"run": staticmethod(fake_run), "TimeoutExpired": subprocess.TimeoutExpired}
)


def run_scenario(scenario):
    global SCENARIO
    SCENARIO = scenario
    calls.clear()
    ns = {"subprocess": fake_subprocess, "json": json, "env_path": "/tmp/fake-env", "container": "fake-container"}
    exec(classify_fn, ns)
    exec(newest_ts_fn, ns)
    exec(escalation, ns)
    return ns


ns = run_scenario({"0": '[{"level":0,"timestamp":"2026-08-31T11:00:00Z"}]'})
assert calls == ["0"], f"common case should make exactly 1 call, got {calls}"
assert ns["continuous_newest"] == "2026-08-31T11:00:00Z"

ns = run_scenario({"0": "[]", "1": '[{"level":1,"timestamp":"2026-08-31T10:00:00Z"}]', "2": "[]", "3": "[]"})
assert calls == ["0", "1", "2", "3"], f"L0-empty escalation should scan 0,1,2,3, got {calls}"
assert ns["continuous_newest"] == "2026-08-31T10:00:00Z", "must find the L1 tip when L0 is empty"

ns = run_scenario({"0": "[]", "1": "[]", "2": "[]", "3": "[]", "9": '[{"level":9,"timestamp":"2026-08-31T09:00:00Z"}]'})
assert calls == ["0", "1", "2", "3", "9"], f"full escalation should reach snapshot level 9, got {calls}"
assert ns["snapshot_newest"] == "2026-08-31T09:00:00Z", "must fall back to the snapshot when no continuous tip exists"
assert ns["continuous_newest"] is None

print("probe escalation self-test: PASS (1-call common case; correct L1-3 + L9 fallback)")
PYEOF

# Timer cadence: widened 10min -> 30min alongside the level trim (2026-08-31).
TIMER="$ROOT/deploy/coolify/usage-monitor-replica-status.timer"
grep -q 'OnUnitActiveSec=30min' "$TIMER" || fail "timer missing 30min cadence"
if grep -nE 'OnUnitInactiveSec=10min' "$TIMER" >/dev/null; then
  fail "timer still on the old 10min cadence"
fi

# Fixture-driven classify / snapshot behavior.
bash "$HEARTBEAT" --self-test || fail "heartbeat --self-test"

printf 'ok  replica-status-probe offline checks\n'
