#!/usr/bin/env bash
# test-scheduled-ship-gate.sh - Offline tests for scheduled-ship-gate.sh.
#
# The gate is the only thing standing between a half-hourly cron and a
# TestFlight build for every backend commit. Hosted macos-latest is the ship
# host, so without these tests a defect in it is invisible until either
# testers get spammed or an iOS change silently never ships. Everything here is
# a throwaway git repo in a scratch dir: no network, no credentials, no
# xcodebuild, no App Store Connect.
#
# Usage: bash scripts/test-ios-scheduled-ship-gate.sh
#
# ASCII-only (Apple bash 3.2 safe).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="${SCRIPT_DIR}/ios-scheduled-ship-gate.sh"
[[ -f "$GATE" ]] || { echo "missing $GATE"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ship-gate-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

REPO="${TMP}/repo"
STATE="${TMP}/state"
mkdir -p "$REPO" "$STATE"

git -C "$REPO" init --quiet -b main
git -C "$REPO" config user.email "test@example.invalid"
git -C "$REPO" config user.name "gate test"

commit() {
  # commit <path> <content> <message>
  mkdir -p "$(dirname "${REPO}/$1")"
  printf '%s\n' "$2" >"${REPO}/$1"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "$3"
  git -C "$REPO" rev-parse HEAD
}

PASS=0
FAIL=0
check() {
  # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  ok  : $1 (=$3)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

run_gate() {
  # run_gate <event> [extra args...] -> prints "key=value" lines
  # Single --path-prefix: the pre-2026-10-29 call shape, kept working.
  local event="$1"; shift
  bash "$GATE" \
    --event "$event" \
    --path-prefix "ios/" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$@" 2>&1
}

run_gate_paths() {
  # run_gate_paths <event> <prefix>... -- <app>... -> prints "key=value" lines
  # Repeatable --path-prefix: one entry per workflow on.push.paths pattern.
  local event="$1"; shift
  local prefix_args=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    prefix_args[${#prefix_args[@]}]="--path-prefix"
    prefix_args[${#prefix_args[@]}]="$1"; shift
  done
  [[ "${1:-}" == "--" ]] && shift
  bash "$GATE" \
    --event "$event" \
    "${prefix_args[@]}" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$@" 2>&1
}

# Mirror of ios-ship.yml on.push.paths. Test 17 asserts it never drifts from
# the workflow's own list or the gate step's --path-prefix args.
SHIP_PREFIXES=('ios/**' '.github/workflows/ios-ship.yml' 'scripts/ios-*.sh' 'scripts/ios-fleet/**' 'scripts/ios-fleet-pin.sh' 'scripts/ios-fleet.sha256')

field() {
  # field <output> <key>
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k {print $2}' | tail -1
}

set_state() {
  # set_state <app> <sha>
  printf '%s %s\n' "$(date +%s)" "$2" >"${STATE}/last-ship-$1.txt"
}

echo "== syntax =="
bash -n "$GATE" && echo "  ok  : ios-scheduled-ship-gate.sh parses"

echo "== fixture =="
BASE="$(commit README.md base "base")"
echo "  base commit ${BASE:0:10}"

echo "== 1. push/dispatch events bypass the gate entirely =="
out="$(run_gate push demo)"
check "push -> should_ship" 1 "$(field "$out" should_ship)"
out="$(run_gate workflow_dispatch demo)"
check "workflow_dispatch -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 2. scheduled tick with no ship history defers to the ship script =="
out="$(run_gate schedule demo)"
check "no state -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 3. scheduled tick on an already-shipped HEAD skips =="
set_state demo "$BASE"
out="$(run_gate schedule demo)"
check "HEAD already shipped -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 4. backend-only commits since the last ship do NOT ship =="
commit "server/api.ts" "backend change" "feat(server): unrelated to iOS" >/dev/null
commit "docs/notes.md" "docs" "docs: nothing an iOS tester can see" >/dev/null
out="$(run_gate schedule demo)"
check "backend-only -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 5. an iOS change since the last ship DOES ship =="
commit "ios/App/View.swift" "// ui" "fix(ios): visible change" >/dev/null
out="$(run_gate schedule demo)"
check "ios change -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 6. per-app outputs are independent =="
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
set_state demo "$HEAD_SHA"          # caught up
set_state demo-local "$BASE"        # behind, and iOS changed since BASE
out="$(run_gate schedule demo demo-local)"
check "caught-up app" 0 "$(field "$out" ship_demo)"
check "behind app" 1 "$(field "$out" ship_demo_local)"
check "any-app roll-up" 1 "$(field "$out" should_ship)"

echo "== 7. an unreachable last-ship sha falls back to the recorded timestamp =="
# Observed live on Usage-Monitor 2026-08-13: the recorded ship sha was the tip
# of a grok/* ship worktree, not an ancestor of main. Skipping forever would
# make the backstop useless; shipping blind would spam TestFlight.
rm -f "${STATE}/last-ship-demo-local.txt"
FUTURE=$(( $(date +%s) + 600 ))
printf '%s %s\n' "$FUTURE" "0000000000000000000000000000000000000000" >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, no newer iOS commits -> should_ship" 0 "$(field "$out" should_ship)"

PAST=$(( $(date +%s) - 86400 ))
printf '%s %s\n' "$PAST" "0000000000000000000000000000000000000000" >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, iOS commits since -> should_ship" 1 "$(field "$out" should_ship)"

printf 'not-a-timestamp deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, unusable ts -> defers to ship script" 1 "$(field "$out" should_ship)"

# Back to a clean skip state for the exit-code assertion below.
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 8. deciding 'skip' is never an error exit =="
run_gate schedule demo >/dev/null
check "exit code on skip" 0 "$?"

echo "== 9. a tooling-only merge since the last ship DOES ship (the missed-push backstop) =="
commit "scripts/ios-fleet/ship-testflight.sh" "# tooling fix" "fix(ios-fleet): tooling-only, push trigger would have shipped" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "scripts/ios-fleet/ change -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 10. a workflow-file-only merge DOES ship =="
commit ".github/workflows/ios-ship.yml" "# ship workflow tweak" "ci(ios-ship): workflow-only, push trigger would have shipped" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "workflow file change -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 11. project.yml (under ios/) and the ios-*.sh glob DO ship =="
commit "ios/UsageMonitor/project.yml" "# xcodegen" "ios: project.yml change" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "project.yml change -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"
commit "scripts/ios-nightly.sh" "#!/usr/bin/env bash" "ios: new ios-*.sh helper" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "scripts/ios-*.sh change -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 12. pin files DO ship; nearby non-matching scripts do NOT =="
commit "scripts/ios-fleet.sha256" "pin" "ios: pin refresh" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "scripts/ios-fleet.sha256 change -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"
commit "scripts/other.sh" "# unrelated helper" "chore: unrelated script" >/dev/null
commit "server/api.ts" "backend change 2" "feat(server): unrelated to iOS" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "scripts/other.sh + server only -> should_ship" 0 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 13. unrelated-only changes still skip with the full prefix set =="
commit "README.md" "readme tweak" "docs: readme" >/dev/null
commit "src/server.ts" "backend" "feat(server): more backend" >/dev/null
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "README + server only -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 14. HEAD already shipped still skips with the full prefix set =="
set_state demo "$(git -C "$REPO" rev-parse HEAD)"
out="$(run_gate_paths schedule "${SHIP_PREFIXES[@]}" -- demo)"
check "HEAD already shipped -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 15. '!' exclusions filter like the push trigger =="
commit "ios/Generated/build.swift" "// generated" "ios: generated file only" >/dev/null
out="$(run_gate_paths schedule 'ios/**' '!ios/Generated/**' -- demo)"
check "excluded-only change -> should_ship" 0 "$(field "$out" should_ship)"
out="$(run_gate_paths schedule 'ios/**' -- demo)"
check "same change without the exclusion -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 16. the old single-prefix call keeps working =="
commit "scripts/ios-fleet/ship-testflight.sh" "# tooling fix 2" "fix(ios-fleet): tooling-only again" >/dev/null
out="$(run_gate schedule demo)"
check "single ios/ prefix ignores tooling-only -> should_ship" 0 "$(field "$out" should_ship)"
commit "ios/App/Next.swift" "// ui 2" "fix(ios): visible change 2" >/dev/null
out="$(run_gate schedule demo)"
check "single ios/ prefix still ships ios changes -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 17. gate prefixes match the workflow's own on.push.paths =="
SYNC_OUT="$(python3 - "$SCRIPT_DIR/../.github/workflows/ios-ship.yml" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
push = text.split('push:', 1)[1].split('workflow_dispatch:', 1)[0]
push_paths = sorted(m.group(1) for m in re.finditer(r"^\s*-\s*['\"]([^'\"]+)['\"]\s*$", push, re.M))
step = text.split('Scheduled ship gate', 1)[1].split('- name:', 1)[0]
gate_prefixes = sorted(m.group(1) for m in re.finditer(r"--path-prefix\s+['\"]([^'\"]+)['\"]", step))
print("push=" + ",".join(push_paths))
print("gate=" + ",".join(gate_prefixes))
PY
)"
PUSH_LIST="$(printf '%s\n' "$SYNC_OUT" | sed -n 's/^push=//p')"
GATE_LIST="$(printf '%s\n' "$SYNC_OUT" | sed -n 's/^gate=//p')"
check "gate step passes every push path" "$PUSH_LIST" "$GATE_LIST"
MIRROR_LIST="$(printf '%s\n' "${SHIP_PREFIXES[@]}" | LC_ALL=C sort | tr '\n' ',' | sed 's/,$//')"
check "test mirror matches push paths" "$PUSH_LIST" "$MIRROR_LIST"

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
echo "scheduled-ship-gate: all tests passed"
