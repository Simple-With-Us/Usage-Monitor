#!/usr/bin/env bash
# Offline auth and synced-source checks; no inherited credentials or real stores.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/infisical-secrets-safe.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node runtime must be available before PATH isolation"
ln -s "$NODE_BIN" "$TMP/bin/node"

cat >"$TMP/run.mjs" <<'FIXTURE'
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const result = spawnSync("/bin/bash", process.argv.slice(2), {
  env: process.env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
});
if (result.error || result.signal || result.status === null) throw new Error("Fixture child failed to complete");
appendFileSync(process.env.FIXTURE_OUTPUT, result.stdout + result.stderr);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status;
FIXTURE
cat >"$TMP/bin/infisical" <<'FIXTURE'
#!/bin/bash
set -euo pipefail
[ "${1:-}" = secrets ] || { printf 'unexpected-command\n' >>"$FIXTURE_CALLS"; exit 99; }
[ "${INFISICAL_DOMAIN:-}" = "${FIXTURE_ORIGIN:-https://app.infisical.com}" ] || { printf 'unexpected-origin\n' >>"$FIXTURE_CALLS"; exit 88; }
for selector in INFISICAL_API_URL INFISICAL_BASE_URL TOKEN INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN INFISICAL_AUTOMATION_CLIENT_ID INFISICAL_AUTOMATION_CLIENT_SECRET INFISICAL_UM_CLIENT_ID INFISICAL_UM_CLIENT_SECRET INFISICAL_UM_READ_TOKEN INFISICAL_UM_WRITE_TOKEN; do
  [ -z "${!selector+x}" ] || { printf 'unexpected-auth-selector\n' >>"$FIXTURE_CALLS"; exit 87; }
done
printf 'cli-origin %s\n' "$INFISICAL_DOMAIN" >>"$FIXTURE_CALLS"
for argument in "$@"; do
  case "$argument" in *fake-source*|*fake-platform*|*fake-github*|*fake-retired*|*st.read*|*st.write*) exit 90 ;; esac
done
for flag in --projectId=project-fixture --env=prod --path=/; do
  [[ " $* " == *" $flag "* ]] || exit 89
done
case "${INFISICAL_TOKEN:-}" in
  st.read) purpose=read ;;
  st.write) purpose=write ;;
  *) printf 'unexpected-auth\n' >>"$FIXTURE_CALLS"; exit 98 ;;
esac
operation="${2:-names}"
[[ "$operation" != --projectId=* ]] || operation=names
case "$operation" in
  names)
    [ "$purpose" = read ] || exit 97
    if [ -e "$FIXTURE_DELETED" ]; then printf 'SECOND=fake-remote\n';
    else printf 'FIRST=fake-remote\nSECOND=fake-remote\n'; fi
    ;;
  set)
    [ "$purpose" = write ] || exit 96
    case "${3:-}" in
      SOURCE_KEY=@/dev/stdin) expected=fake-source ;;
      UPTIMEROBOT_API_KEY=@/dev/stdin) expected=fake-platform ;;
      GITHUB_TOKEN=@/dev/stdin) expected=fake-github ;;
      *) printf 'unexpected-destination\n' >>"$FIXTURE_CALLS"; exit 95 ;;
    esac
    [ "$(cat)" = "$expected" ] || exit 94
    ;;
  delete)
    [ "$purpose" = write ] && [ "${3:-}" = FIRST ] || exit 93
    [[ " $* " == *' --type=shared '* ]] || exit 92
    : >"$FIXTURE_DELETED"
    ;;
  *) printf 'unexpected-operation\n' >>"$FIXTURE_CALLS"; exit 91 ;;
esac
printf '%s %s\n' "$operation" "$purpose" >>"$FIXTURE_CALLS"
[ "$operation" != set ] || printf 'destination %s\n' "${3%%=*}" >>"$FIXTURE_CALLS"
FIXTURE
for trap_name in fleet-secrets security; do
  cat >"$TMP/bin/$trap_name" <<'FIXTURE'
#!/bin/sh
printf 'retired-reader\n' >>"$FIXTURE_CALLS"
exit 99
FIXTURE
done
chmod +x "$TMP/bin/infisical" "$TMP/bin/fleet-secrets" "$TMP/bin/security"
cat >"$TMP/fetch.mjs" <<'FIXTURE'
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
  // This replaces fetch before the actual verifier loads; it never opens a socket.
  const origin = process.env.FIXTURE_ORIGIN || "https://app.infisical.com";
  if (String(url) !== origin + "/api/v2/service-token" || options.redirect !== "error") throw new Error("Unexpected fixture metadata destination");
  appendFileSync(process.env.FIXTURE_CALLS, "metadata-origin " + origin + "\n");
  const authHeader = options.headers.authorization;
  const permission = authHeader === "Bearer st.read" ? "read" : authHeader === "Bearer st.write" ? "write" : null;
  appendFileSync(process.env.FIXTURE_CALLS, "metadata " + (permission || "unexpected") + "\n");
  if (!permission) throw new Error("Unexpected fixture metadata authentication");
  return new Response(JSON.stringify({ workspace: "project-fixture", permissions: [process.env.FIXTURE_PERMISSION || permission], scopes: [{ environment: "prod", secretPath: process.env.FIXTURE_PATH || "/" }], expiresAt: "2999-01-01T00:00:00Z" }));
};
FIXTURE

run_helper() {
  local inputs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do inputs+=("$1"); shift; done
  [ "${1:-}" = -- ] || fail "fixture requires argument separator"
  shift
  env -i PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" \
    NODE_OPTIONS="--import=$TMP/fetch.mjs" INFISICAL_UM_PROJECT_ID=project-fixture \
    INFISICAL_DOMAIN=https://wrong.invalid TOKEN=fake-alt \
    INFISICAL_CLIENT_ID=fixture-client INFISICAL_CLIENT_SECRET=fixture-secret \
    INFISICAL_UM_CLIENT_ID=fixture-client INFISICAL_UM_CLIENT_SECRET=fixture-secret \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=fixture-client INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=fixture-secret \
    INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN=fake-access \
    INFISICAL_AUTOMATION_CLIENT_ID=fixture-client INFISICAL_AUTOMATION_CLIENT_SECRET=fixture-secret \
    FIXTURE_CALLS="$TMP/calls" FIXTURE_DELETED="$TMP/deleted" FIXTURE_OUTPUT="$TMP/all-output" \
    SOURCE_KEY=fake-source "${inputs[@]}" "$NODE_BIN" "$TMP/run.mjs" "$SRC" "$@"
}
clear_calls() { : >"$TMP/calls"; }
expect_no_auth() {
  local expected="$1"; shift
  clear_calls
  if run_helper "$@" >"$TMP/out" 2>"$TMP/err"; then fail "unsafe binding unexpectedly succeeded"; fi
  grep -Fq -- "$expected" "$TMP/err" || fail "missing fixed refusal diagnostic"
  [ ! -s "$TMP/calls" ] || fail "refused input reached metadata, CLI or a retired reader"
}

bash -n "$SRC" || fail "bash syntax"
clear_calls
run_helper INFISICAL_UM_READ_TOKEN=st.read -- names >"$TMP/out" || fail "CLI transport disagreed with verified metadata"
grep -qx 'metadata read' "$TMP/calls" && grep -qx 'names read' "$TMP/calls" || fail "verified read route"
grep -qx FIRST "$TMP/out" && grep -qx SECOND "$TMP/out" || fail "names-only output"
run_helper INFISICAL_TOKEN=st.read -- has FIRST >/dev/null || fail "service-token read alias"

clear_calls
if run_helper INFISICAL_UM_READ_TOKEN=st.read FIXTURE_PATH=/wrong -- names >/dev/null 2>&1; then fail "wrong-folder metadata accepted"; fi
grep -qx 'metadata read' "$TMP/calls" || fail "wrong-folder fixture did not reach real verifier"
if grep -q '^names ' "$TMP/calls"; then fail "wrong-folder metadata reached CLI"; fi
clear_calls
if run_helper INFISICAL_UM_WRITE_TOKEN=st.write FIXTURE_PERMISSION=read -- set SOURCE_KEY >/dev/null 2>&1; then fail "read-only metadata accepted for write"; fi
if grep -q '^set ' "$TMP/calls"; then fail "wrong permission reached write"; fi

clear_calls
run_helper INFISICAL_TOKEN=st.read INFISICAL_UM_READ_TOKEN=st.read INFISICAL_UM_WRITE_TOKEN=st.write -- set SOURCE_KEY >"$TMP/out"
grep -qx 'metadata write' "$TMP/calls" && grep -qx 'set write' "$TMP/calls" || fail "verified stdin write"
clear_calls
run_helper INFISICAL_UM_READ_TOKEN=st.read INFISICAL_UM_WRITE_TOKEN=st.write -- delete FIRST >"$TMP/out"
grep -qx 'delete write' "$TMP/calls" || fail "shared delete route"
[ "$(grep -c '^names read$' "$TMP/calls")" -eq 2 ] || fail "delete must verify presence before and after"

expect_no_auth 'INFISICAL_UM_READ_TOKEN service token required' -- names
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' INFISICAL_TOKEN=st.read -- set SOURCE_KEY
expect_no_auth 'INFISICAL_UM_READ_TOKEN service token required' INFISICAL_UM_READ_TOKEN=opaque-fixture INFISICAL_UM_CLIENT_ID=fixture-client INFISICAL_UM_CLIENT_SECRET=fixture-secret -- names
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' INFISICAL_UM_WRITE_TOKEN=opaque-fixture -- set SOURCE_KEY
expect_no_auth 'INFISICAL_UM_READ_TOKEN service token required' INFISICAL_UM_CLIENT_ID=fixture-client INFISICAL_UM_CLIENT_SECRET=fixture-secret -- names
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' INFISICAL_UM_CLIENT_ID=fixture-client INFISICAL_UM_CLIENT_SECRET=fixture-secret -- set SOURCE_KEY
expect_no_auth 'Invalid secret key name.' INFISICAL_UM_WRITE_TOKEN=st.write -- set 'SOURCE_KEY;false'
expect_no_auth 'Invalid secret key name.' INFISICAL_UM_WRITE_TOKEN=st.write -- set SOURCE_KEY --bad
expect_no_auth 'Invalid secret key name.' INFISICAL_UM_READ_TOKEN=st.read -- has '[A-Z]*'
expect_no_auth 'Invalid secret key name.' INFISICAL_UM_WRITE_TOKEN=st.write -- delete FIRST 'bad key'
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' UPTIMEROBOT_API_KEY=fake-platform -- sync-platforms
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' INFISICAL_UM_WRITE_TOKEN=opaque-fixture UPTIMEROBOT_API_KEY=fake-platform -- sync-platforms
expect_no_auth 'INFISICAL_UM_READ_TOKEN service token required' INFISICAL_UM_WRITE_TOKEN=st.write -- delete FIRST
expect_no_auth 'INFISICAL_UM_READ_TOKEN service token required' INFISICAL_UM_READ_TOKEN=opaque-fixture INFISICAL_UM_WRITE_TOKEN=st.write -- delete FIRST
expect_no_auth 'INFISICAL_UM_WRITE_TOKEN service token required' -- sync-platforms
expect_no_auth 'Infisical target configuration rejected.' INFISICAL_BASE_URL=https://wrong.invalid INFISICAL_UM_READ_TOKEN=st.read -- names

for region in app us eu; do
  origin="https://$region.infisical.com"
  case "$region" in
    app) targets=("INFISICAL_BASE_URL=$origin/api") ;;
    us) targets=("INFISICAL_API_URL=$origin/api") ;;
    eu) targets=("INFISICAL_BASE_URL=$origin/api" "INFISICAL_API_URL=https://wrong.invalid") ;;
  esac
  clear_calls
  rm -f "$TMP/deleted"
  run_helper "FIXTURE_ORIGIN=$origin" "${targets[@]}" INFISICAL_UM_WRITE_TOKEN=st.write -- set SOURCE_KEY >"$TMP/out" || fail "regional write transport"
  run_helper "FIXTURE_ORIGIN=$origin" "${targets[@]}" INFISICAL_UM_READ_TOKEN=st.read INFISICAL_UM_WRITE_TOKEN=st.write -- delete FIRST >"$TMP/out" || fail "regional read/delete transport"
  [ "$(grep -Fxc "metadata-origin $origin" "$TMP/calls")" -eq 3 ] || fail "regional metadata origin mismatch"
  [ "$(grep -Fxc "cli-origin $origin" "$TMP/calls")" -eq 4 ] || fail "regional CLI origin mismatch"
done

clear_calls
if run_helper SOURCE_KEY= -- set SOURCE_KEY >"$TMP/out"; then fail "empty synced source accepted"; fi
grep -Fq 'not available in synced environment' "$TMP/out" || fail "source absence diagnostic"
[ ! -s "$TMP/calls" ] || fail "absent source attempted authentication"
clear_calls
run_helper INFISICAL_UM_WRITE_TOKEN=st.write UPTIMEROBOT_API_KEY=fake-platform GITHUB_MCP_TOKEN=fake-github INFISICAL_ST_CLIENT_SECRET=fake-retired -- sync-platforms >"$TMP/out"
[ "$(grep -c '^set write$' "$TMP/calls")" -eq 2 ] || fail "fixed platform map did not copy only present supported sources"
if grep -q 'INFISICAL_ST_CLIENT_SECRET\|retired-reader\|unexpected-' "$TMP/calls"; then fail "retired source or reader reached"; fi
grep -Fq 'Held back on purpose (not copied automatically)' "$TMP/out" || fail "held-back warning disappeared"
clear_calls
run_helper UPTIMEROBOT_API_KEY=fake-platform -- sync-platforms --dry-run >"$TMP/out"
[ ! -s "$TMP/calls" ] || fail "dry run authenticated or wrote"
for value in fake-source fake-platform fake-github fake-retired fake-remote opaque-fixture fake-alt fixture-client fixture-secret fake-access st.read st.write; do
  if grep -Fq "$value" "$TMP/all-output" "$TMP/calls"; then fail "fixture value disclosed"; fi
done
if grep -q 'fleet-secrets\|universal-auth\|INFISICAL_ST_CLIENT_SECRET' "$SRC"; then fail "retired source remains active in helper"; fi
printf 'ok  infisical-secrets-safe offline synced-source and service-token checks\n'
