#!/usr/bin/env bash
# Offline checks for the Mac server watchdog's heartbeat token (the keychain is
# the only source).  Uses a stub `security` in a temp dir:  never touches the
# real Keychain, the network, or any LaunchAgent.
#
# Pins the four review findings on Usage-Monitor #2081:
#   * the keychain read is bounded by a timeout, so an unanswered Keychain
#     prompt cannot hang the launchd schedule;
#   * the keychain is the source and the environment is not:  a copy of the
#     token in the environment must not shadow the authoritative value;
#   * the security binary is absolute, because launchd's PATH is minimal;
#   * the error names both keychain accounts and says what each one covers.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WD="$ROOT/scripts/ops/mac-server-watchdog.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

bash -n "$WD" || fail "bash -n watchdog"

# The environment is not a source:  neither token name may be read from it.
if grep -nE '\$\{?(MAC_HEARTBEAT_INGEST_TOKEN|USAGE_INGEST_TOKEN)[:}]' "$WD" \
  | grep -v '^[0-9]*:[[:space:]]*#' >/dev/null; then
  fail "the watchdog reads the heartbeat token from the environment"
fi

# The keychain is the source, and the read is bounded and absolute.
grep -q 'read_keychain_secret' "$WD" || fail "the watchdog lost its keychain read"
grep -q 'MAC_HEARTBEAT_SECURITY_BIN:-/usr/bin/security' "$WD" \
  || fail "the security binary must default to the absolute /usr/bin/security"
# The read must be bounded by a killable timer:  an alarm set in the parent is
# reset by exec, so the read has to run in a forked child the timer can kill.
grep -q 'alarm \$timeout' "$WD" || fail "the keychain read must arm a timeout"
grep -q 'fork()' "$WD" || fail "the keychain read must run in a forked child"
grep -q 'kill "TERM"' "$WD" || fail "the timeout must kill the keychain read"
grep -q 'KEYCHAIN_FALLBACK_ACCOUNT' "$WD" \
  || fail "the error must name the fallback keychain account"
grep -q 'accounts ${KEYCHAIN_ACCOUNT} and ${KEYCHAIN_FALLBACK_ACCOUNT}' "$WD" \
  || fail "the error must name both keychain accounts"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SENTINEL='SENTINEL-never-print-9c41'

make_security() { # <exit code> <stdout> [sleep seconds]
  printf '#!/usr/bin/env bash\nprintf "%%s" %q\nsleep %s\nexit %s\n' \
    "$2" "${3:-0}" "$1" > "$TMP/security"
  chmod 755 "$TMP/security"
}

# The function is exercised on its own,  the way the house quota-collector test
# exercises its wrapper:  the rest of the watchdog is macOS-only.
awk '/^read_keychain_secret\(\) \{/,/^\}/' "$WD" > "$TMP/fn.sh"
[[ -s "$TMP/fn.sh" ]] || fail "could not extract read_keychain_secret"

run_fn() { # runs the function with the stub and prints its stdout
  (
    set -uo pipefail
    SECURITY_BIN="$TMP/security"
    KEYCHAIN_SERVICE="infisical-service-token"
    KEYCHAIN_TIMEOUT_SECS="${TIMEOUT:-20}"
    source "$TMP/fn.sh"
    read_keychain_secret "$1"
  )
}

# 1. The keychain yields the token:  it comes back,  and it is the only source.
make_security 0 "$SENTINEL"
out="$(run_fn mac-host-heartbeat-read)"
[[ "$out" == "$SENTINEL" ]] || fail "the keychain value did not come back"

# 2. A missing item (security exit 44) yields nothing and never fails the pass.
make_security 44 ""
out="$(run_fn mac-host-heartbeat-read)"
[[ -z "$out" ]] || fail "a missing keychain item must yield no token"

# 3. An unanswered prompt is bounded:  the read dies at the timeout.
make_security 0 "$SENTINEL" 30
start="$(date +%s)"
out="$(TIMEOUT=2 run_fn mac-host-heartbeat-read)"
elapsed=$(( $(date +%s) - start ))
[[ -z "$out" ]] || fail "a timed-out read must yield no token"
[[ "$elapsed" -lt 25 ]] || fail "the keychain read was not bounded (${elapsed}s)"

printf 'ok  mac-server-watchdog token source\n'
