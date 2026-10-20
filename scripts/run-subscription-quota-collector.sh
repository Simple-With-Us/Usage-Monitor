#!/usr/bin/env bash
# launchd wrapper for scripts/subscription-quota-collector.mjs (UM-1616).
#
# The collector never reads the Keychain itself (PR #1592).  It takes the Claude
# Code OAuth credential from CLAUDE_CODE_OAUTH_CREDENTIALS_JSON.  This wrapper
# reads that credential from the macOS login Keychain item "Claude Code-credentials"
# with /usr/bin/security, hands it to the collector through that variable, and
# execs the collector.  It is installed next to the collector by
# scripts/install-collectors.sh and wired into the LaunchAgent by --plists.
#
# Safety:
#   * The credential lives only in a shell variable and the collector's
#     environment.  It is never printed, logged or written to disk.
#   * A failed Keychain read (locked, denied, item missing, timeout) logs ONE
#     line and the collector still runs without the variable, exactly as it did
#     before this wrapper existed, so Codex, Grok and MiniMax are unaffected.
#     The wrapper itself never fails the run; the exit status is the collector's.
#   * A CLAUDE_CODE_OAUTH_CREDENTIALS_JSON already in the environment wins and
#     the Keychain is not touched.
#   * The read is killed after UM_KEYCHAIN_TIMEOUT_SECS (default 20) so a
#     Keychain prompt that nobody answers cannot hang the 15 minute schedule.
#
# First run: macOS asks once to let /usr/bin/security read the item.  Click
# "Always Allow".  Until then every pass logs the one-line failure below.
#
# Test seams (offline tests only): UM_KEYCHAIN_SECURITY_BIN, UM_NODE_BIN,
# UM_QUOTA_COLLECTOR_SCRIPT.
set -uo pipefail

KEYCHAIN_SERVICE="Claude Code-credentials"
SECURITY_BIN="${UM_KEYCHAIN_SECURITY_BIN:-/usr/bin/security}"
TIMEOUT_SECS="${UM_KEYCHAIN_TIMEOUT_SECS:-20}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTOR="${UM_QUOTA_COLLECTOR_SCRIPT:-$HERE/subscription-quota-collector.mjs}"

log() { printf '[run-subscription-quota-collector] %s\n' "$*"; }

pick_node() {
  if [[ -n "${UM_NODE_BIN:-}" ]]; then printf '%s' "$UM_NODE_BIN"; return; fi
  local c
  for c in /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$c" ]] && { printf '%s' "$c"; return; }
  done
  command -v node || true
}

read_keychain_credential() {
  if [[ ! -x "$SECURITY_BIN" ]]; then
    log "keychain: $SECURITY_BIN not found; claude-code quota skipped this pass"
    return 0
  fi
  [[ "$TIMEOUT_SECS" =~ ^[0-9]+$ ]] || TIMEOUT_SECS=20
  local cred rc
  # perl's alarm survives exec, so the read dies after the timeout.  stderr is
  # discarded: security prints item attributes there on some failures.
  cred="$(/usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' "$TIMEOUT_SECS" \
    "$SECURITY_BIN" find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    case "$rc" in
      142) log "keychain: read timed out after ${TIMEOUT_SECS}s (prompt unanswered?); claude-code quota skipped this pass" ;;
      44)  log "keychain: item \"$KEYCHAIN_SERVICE\" not found; claude-code quota skipped this pass" ;;
      *)   log "keychain: read failed (security exit $rc; click Always Allow once if prompted); claude-code quota skipped this pass" ;;
    esac
    return 0
  fi
  if [[ "$cred" != \{* ]]; then
    log "keychain: item \"$KEYCHAIN_SERVICE\" is not credential JSON; claude-code quota skipped this pass"
    return 0
  fi
  CLAUDE_CODE_OAUTH_CREDENTIALS_JSON="$cred"
  export CLAUDE_CODE_OAUTH_CREDENTIALS_JSON
}

if [[ -z "${CLAUDE_CODE_OAUTH_CREDENTIALS_JSON:-}" ]]; then
  read_keychain_credential
fi

NODE_BIN="$(pick_node)"
if [[ -z "$NODE_BIN" ]]; then
  log "node not found; nothing was run"
  exit 1
fi
exec "$NODE_BIN" "$COLLECTOR" "$@"
