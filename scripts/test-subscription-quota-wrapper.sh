#!/usr/bin/env bash
# Offline checks for scripts/run-subscription-quota-collector.sh and
# scripts/wire-quota-wrapper-plist.sh (UM-1616).  Uses stub `security` and
# `node` executables in a temp dir: never touches the real Keychain, the network
# or any LaunchAgent.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAP="$ROOT/scripts/run-subscription-quota-collector.sh"
WIRE="$ROOT/scripts/wire-quota-wrapper-plist.sh"
TPL="$ROOT/scripts/com.jays.subscription-quota-collector.plist.example"
INSTALL="$ROOT/scripts/install-collectors.sh"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

bash -n "$WRAP" || fail "bash -n wrapper"
bash -n "$WIRE" || fail "bash -n wire script"

# The credential variable must never be printed or logged.
if grep -nE '(echo|printf)[^|>]*\$\{?cred\b|(echo|printf)[^|>]*CLAUDE_CODE_OAUTH_CREDENTIALS_JSON' "$WRAP" \
  | grep -v '^[0-9]*:\s*#' >/dev/null; then
  fail "wrapper would print the credential"
fi
grep -q 'Claude Code-credentials' "$WRAP" || fail "wrapper missing Keychain service name"
grep -q '/usr/bin/security' "$WRAP" || fail "wrapper must default to /usr/bin/security"
grep -q 'run-subscription-quota-collector\.sh' "$TPL" || fail "plist template does not run the wrapper"
grep -q "include='/run-subscription-quota-collector.sh'" "$INSTALL" || fail "installer does not copy the wrapper"
grep -q 'wire-quota-wrapper-plist.sh' "$INSTALL" || fail "installer does not wire the plist"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SENTINEL='SENTINEL-do-not-print-7f3a'

# Stub `node`: reports (without echoing the value) whether the credential arrived.
cat > "$TMP/node" <<'STUB'
#!/usr/bin/env bash
if [[ "${CLAUDE_CODE_OAUTH_CREDENTIALS_JSON:-}" == *SENTINEL-do-not-print-7f3a* ]]; then echo "node: has-cred"; else echo "node: no-cred"; fi
echo "node: args=${*:2}"
exit "${STUB_NODE_EXIT:-0}"
STUB
chmod 755 "$TMP/node"

make_security() { # <exit code> <stdout>
  printf '#!/usr/bin/env bash\ntouch "%s/security-called"\n[[ "$1 $2 $3" == "find-generic-password -s Claude Code-credentials" ]] || exit 99\nprintf "%%s" %q\nexit %s\n' \
    "$TMP" "$2" "$1" > "$TMP/security"
  chmod 755 "$TMP/security"
  rm -f "$TMP/security-called"
}

run() { # extra env assignments via env(1)
  env UM_NODE_BIN="$TMP/node" UM_KEYCHAIN_SECURITY_BIN="$TMP/security" \
    UM_QUOTA_COLLECTOR_SCRIPT="$TMP/collector.mjs" "$@" bash "$WRAP" --provider all --redacted
}

# 1. Keychain read succeeds: collector gets the credential, nothing is printed.
make_security 0 "{\"claudeAiOauth\":{\"accessToken\":\"$SENTINEL\"}}"
out="$(run 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || fail "success path exit $rc"
grep -q 'node: has-cred' <<<"$out" || fail "collector did not receive the credential"
grep -q 'args=--provider all --redacted' <<<"$out" || fail "collector args not forwarded"
grep -q "$SENTINEL" <<<"$out" && fail "credential leaked to output"
[[ "$(grep -c 'run-subscription-quota-collector' <<<"$out")" -eq 0 ]] || fail "success path should log nothing"

# 2. Item not found (44): one log line, collector still runs, exit 0.
make_security 44 ""
out="$(run 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || fail "not-found exit $rc"
grep -q 'node: no-cred' <<<"$out" || fail "collector must still run without the credential"
[[ "$(grep -c '^\[run-subscription-quota-collector\] keychain:' <<<"$out")" -eq 1 ]] || fail "expected exactly one log line (44)"
grep -q 'not found' <<<"$out" || fail "44 log line unclear"

# 3. Any other failure (denied, locked, cancelled): one line with the exit code.
make_security 51 ""
out="$(run 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || fail "denied exit $rc"
grep -q 'node: no-cred' <<<"$out" || fail "collector must still run after a denied read"
[[ "$(grep -c '^\[run-subscription-quota-collector\] keychain:' <<<"$out")" -eq 1 ]] || fail "expected exactly one log line (51)"
grep -q 'security exit 51' <<<"$out" || fail "denied log line should carry the exit code"

# 4. Non-JSON item: refused, not exported.
make_security 0 "not-json-$SENTINEL"
out="$(run 2>&1)"
grep -q 'node: no-cred' <<<"$out" || fail "non-JSON item must not be exported"
grep -q "$SENTINEL" <<<"$out" && fail "non-JSON item leaked to output"

# 5. Missing security binary.
out="$(env UM_NODE_BIN="$TMP/node" UM_KEYCHAIN_SECURITY_BIN="$TMP/nope" UM_QUOTA_COLLECTOR_SCRIPT=x bash "$WRAP" 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || fail "missing security exit $rc"
grep -q 'not found; claude-code quota skipped' <<<"$out" || fail "missing security log line"
grep -q 'node: no-cred' <<<"$out" || fail "collector must run without security"

# 6. A credential already in the environment wins; the Keychain is not read.
make_security 0 "{\"claudeAiOauth\":{\"accessToken\":\"other\"}}"
out="$(run "CLAUDE_CODE_OAUTH_CREDENTIALS_JSON={\"claudeAiOauth\":{\"accessToken\":\"$SENTINEL\"}}" 2>&1)"
grep -q 'node: has-cred' <<<"$out" || fail "preset credential not passed through"
[[ ! -e "$TMP/security-called" ]] || fail "Keychain read despite a preset credential"

# 7. The collector's exit status is the wrapper's exit status.
make_security 0 "{\"claudeAiOauth\":{\"accessToken\":\"$SENTINEL\"}}"
run STUB_NODE_EXIT=3 >/dev/null 2>&1; rc=$?
[[ $rc -eq 3 ]] || fail "collector exit status not propagated (got $rc)"

# 8. A Keychain prompt nobody answers is cut off.
printf '#!/usr/bin/env bash\nexec sleep 30\n' > "$TMP/security"; chmod 755 "$TMP/security"
start=$SECONDS
out="$(run UM_KEYCHAIN_TIMEOUT_SECS=1 2>&1)"; rc=$?
[[ $rc -eq 0 ]] || fail "timeout exit $rc"
(( SECONDS - start < 15 )) || fail "timeout did not cut the read off"
grep -q 'timed out after 1s' <<<"$out" || fail "timeout log line"
grep -q 'node: no-cred' <<<"$out" || fail "collector must run after a timeout"

# 9. Plist wiring: installed-copy shape -> wrapper, args kept, idempotent.
cat > "$TMP/quota.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jays.subscription-quota-collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/x/apps/usage-monitor-collectors/scripts/subscription-quota-collector.mjs</string>
    <string>--provider</string>
    <string>all</string>
    <string>--redacted</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
</dict>
</plist>
PLIST
W=/Users/x/apps/usage-monitor-collectors/scripts/run-subscription-quota-collector.sh
[[ "$("$WIRE" "$TMP/quota.plist" "$W")" == "wired" ]] || fail "plist not wired"
grep -q "<string>$W</string>" "$TMP/quota.plist" || fail "wrapper path missing from plist"
grep -q 'bin/node' "$TMP/quota.plist" && fail "node entry should be gone"
grep -q 'subscription-quota-collector\.mjs' "$TMP/quota.plist" && fail "collector entry should be gone"
grep -q '<string>--redacted</string>' "$TMP/quota.plist" || fail "trailing args dropped"
grep -q '<integer>900</integer>' "$TMP/quota.plist" || fail "rest of plist damaged"
[[ "$("$WIRE" "$TMP/quota.plist" "$W")" == "already wired" ]] || fail "wiring not idempotent"
if command -v plutil >/dev/null 2>&1; then plutil -lint "$TMP/quota.plist" >/dev/null || fail "wired plist invalid"; fi
printf '<plist><dict><key>Label</key><string>other</string></dict></plist>\n' > "$TMP/other.plist"
[[ "$("$WIRE" "$TMP/other.plist" "$W")" == "no match" ]] || fail "unrelated plist should not match"

printf 'ok  subscription-quota wrapper offline checks\n'
