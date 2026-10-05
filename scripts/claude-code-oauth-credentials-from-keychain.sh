#!/usr/bin/env bash
# Operator-only helper: print Claude Code OAuth credential JSON from the macOS
# Keychain for injection into CLAUDE_CODE_OAUTH_CREDENTIALS_JSON.
#
# The subscription-quota collector never calls Keychain; launchd wrappers or
# one-shot dry runs may use:
#
#   export CLAUDE_CODE_OAUTH_CREDENTIALS_JSON="$(
#     /ABSOLUTE/PATH/TO/Usage-Monitor/scripts/claude-code-oauth-credentials-from-keychain.sh
#   )"
#   node scripts/subscription-quota-collector.mjs --provider claude --dry-run --redacted
#
# Output is stdout only (no logging).  Do not tee or log the export value.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "claude-code-oauth-credentials-from-keychain: macOS only" >&2
  exit 1
fi

exec security find-generic-password -s "Claude Code-credentials" -w
