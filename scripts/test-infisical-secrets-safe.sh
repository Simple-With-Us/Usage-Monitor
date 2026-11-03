#!/usr/bin/env bash
# Offline auth-routing checks for infisical-secrets-safe.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/infisical-secrets-safe.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

cat >"$TMP/bin/infisical" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  login)
    printf 'login\n' >>"$INFISICAL_MOCK_LOG"
    printf 'mock-session'
    exit 0
    ;;
  secrets)
    operation="${2:-names}"
    [[ "$operation" != --projectId=* ]] || operation="names"
    case "$operation" in
      names)
        if [ -e "$INFISICAL_MOCK_DELETED" ]; then
          printf 'SECOND=value\n'
        else
          printf 'FIRST=value\nSECOND=value\n'
        fi
        ;;
      set)
        [ "${3:-}" = 'SOURCE_KEY=@/dev/stdin' ] || exit 4
        [ "$(cat)" = 'local-value' ] || exit 5
        ;;
      delete) : >"$INFISICAL_MOCK_DELETED" ;;
      *) printf 'unexpected infisical command\n' >&2; exit 2 ;;
    esac
    printf '%s %s\n' "$operation" "${INFISICAL_TOKEN:-none}" >>"$INFISICAL_MOCK_LOG"
    ;;
  *) printf 'unexpected infisical command\n' >&2; exit 2 ;;
esac
MOCK
cat >"$TMP/bin/fleet-secrets" <<'MOCK'
#!/usr/bin/env bash
case "${2:-}" in
  SOURCE_KEY) printf 'local-value' ;;
esac
MOCK
chmod +x "$TMP/bin/infisical" "$TMP/bin/fleet-secrets"
export PATH="$TMP/bin:/usr/bin:/bin"
export INFISICAL_PROJECT_ID="project-test"
export INFISICAL_MOCK_LOG="$TMP/calls.log"
export INFISICAL_MOCK_DELETED="$TMP/deleted"
cat >"$TMP/fetch.mjs" <<'MOCK'
globalThis.fetch = async () => new Response(JSON.stringify({workspace:"project-test",permissions:[process.env.MOCK_PERMISSION || "read"],scopes:[{environment:"prod",secretPath:process.env.MOCK_PATH || "/"}],expiresAt:null}));
MOCK

bash -n "$SRC" || fail "bash -n"

INFISICAL_UM_READ_TOKEN="read-fake" bash "$SRC" names >/dev/null
grep -qx 'names read-fake' "$INFISICAL_MOCK_LOG" || fail "names did not use the read token"
NODE_OPTIONS="--import=$TMP/fetch.mjs" INFISICAL_UM_READ_TOKEN="st.fake-read" bash "$SRC" names >/dev/null
grep -qx 'names st.fake-read' "$INFISICAL_MOCK_LOG" || fail "metadata-verified read token was not used"
if NODE_OPTIONS="--import=$TMP/fetch.mjs" MOCK_PATH="/wrong" INFISICAL_UM_READ_TOKEN="st.fake-read" bash "$SRC" names >/dev/null 2>&1; then
  fail "wrong-folder metadata was accepted"
fi
if NODE_OPTIONS="--import=$TMP/fetch.mjs" INFISICAL_UM_WRITE_TOKEN="st.fake-read-only" bash "$SRC" set SOURCE_KEY >/dev/null 2>&1; then
  fail "read-only metadata was accepted for a write"
fi

INFISICAL_UM_WRITE_TOKEN="write-fake" bash "$SRC" set SOURCE_KEY >/dev/null
grep -qx 'set write-fake' "$INFISICAL_MOCK_LOG" || fail "set did not use the write token"

INFISICAL_UM_READ_TOKEN="read-fake" INFISICAL_UM_WRITE_TOKEN="write-fake" \
  bash "$SRC" delete FIRST >/dev/null
grep -qx 'delete write-fake' "$INFISICAL_MOCK_LOG" || fail "delete did not use the write token"
[ "$(grep -c '^names read-fake$' "$INFISICAL_MOCK_LOG")" -eq 3 ] \
  || fail "delete did not verify through the read token before and after"

if INFISICAL_UM_READ_TOKEN="read-fake" bash "$SRC" set SOURCE_KEY >/dev/null 2>&1; then
  fail "a read token was accepted for set"
fi
[ "$(grep -c '^set ' "$INFISICAL_MOCK_LOG")" -eq 1 ] \
  || fail "set ran without a write-capable credential"

INFISICAL_UM_CLIENT_ID="um-id" INFISICAL_UM_CLIENT_SECRET="um-secret" \
  bash "$SRC" names >/dev/null
grep -qx 'names mock-session' "$INFISICAL_MOCK_LOG" || fail "explicit UM machine identity was not retained"

if INFISICAL_CLIENT_ID="generic-id" INFISICAL_CLIENT_SECRET="generic-secret" \
  bash "$SRC" names >/dev/null 2>&1; then
  fail "generic machine-identity credentials were accepted"
fi

if grep -q 'INFISICAL_AUTOMATION_' "$SRC"; then
  fail "shared Automation credentials remain in the helper"
fi
if grep -q '\${INFISICAL_CLIENT_ID:-\|\${INFISICAL_CLIENT_SECRET:-' "$SRC"; then
  fail "generic machine-identity credentials remain in the helper"
fi

printf 'ok  infisical-secrets-safe offline auth checks\n'
