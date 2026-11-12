#!/usr/bin/env bash
# cf-token-map.sh — show which Cloudflare token names in UM Infisical can see
# which CF accounts.  Agents use this to pick the right token.  Never prints a
# token value.
#
# Monet started this (chat "Version availability question") and hit the weekly
# usage cap mid-script.  Finished 2026-08-14.
#
# Usage:
#   bash scripts/cf-token-map.sh
#   (Infisical credentials come from the environment.)
#
# Env (all optional):
#   INFISICAL_PROJECT_ID   (see fleet-ops:ATTACK-MAP.md)
#   INFISICAL_ENV          default prod
#   INFISICAL_API_URL      Infisical host if not the public default
#   INFISICAL_UM_READ_TOKEN, or an explicit UM machine-identity pair
#
# Output is names, lengths, an 8-hex SHA-256 fingerprint (so two names holding
# the same token can be spotted), and the Cloudflare account list each token
# is allowed to GET /accounts.  Token bytes never go to stdout/stderr.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UM="${INFISICAL_UM_PROJECT_ID:-${INFISICAL_PROJECT_ID:-${INFISICAL_APP_PROJECT_ID:-}}}"
SECRET_PATH="${INFISICAL_UM_SECRET_PATH:-${INFISICAL_PATH:-/}}"
ENV_SLUG="${INFISICAL_ENV:-prod}"
INF_URL="${INFISICAL_API_URL:-${INF_URL:-}}"

die() { printf '%s\n' "$*" >&2; exit 1; }

command -v infisical >/dev/null 2>/dev/null || die "infisical CLI not found on PATH."
command -v curl >/dev/null 2>/dev/null || die "curl not found on PATH."
command -v python3 >/dev/null 2>/dev/null || die "python3 not found on PATH."
node "$ROOT/scripts/check-infisical-token.mjs" config || die "Infisical target configuration rejected."

TOKEN="${INFISICAL_UM_READ_TOKEN:-${INFISICAL_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  CID="${INFISICAL_UM_CLIENT_ID:-}"
  CSEC="${INFISICAL_UM_CLIENT_SECRET:-}"
  [ -n "$CID" ] && [ -n "$CSEC" ] || die \
    "No Infisical read credential. Export INFISICAL_UM_READ_TOKEN or an explicit project machine-identity pair."

  # Credentials via env, not argv (avoids `ps` / debug-echo leaks).
  export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$CID"
  export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$CSEC"
  if [ -n "$INF_URL" ]; then
    export INFISICAL_API_URL="$INF_URL"
  fi
  TOKEN="$(infisical login --method=universal-auth --plain --silent 2>/dev/null || true)"
  unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET CID CSEC
fi
[ -n "${TOKEN:-}" ] || die "infisical login failed"
INFISICAL_TOKEN="$TOKEN" INFISICAL_UM_PROJECT_ID="$UM" INFISICAL_UM_SECRET_PATH="$SECRET_PATH" \
  node "$ROOT/scripts/check-infisical-token.mjs" read || die "Infisical credential verification failed."

# Expected slots (same as src/lib/ensure-cloudflare-fleet-providers.ts).
# Probe every name that has ever been used for a CF dashboard token in UM.
TOKEN_NAMES=(
  CLOUDFLARE_FLEET_API_TOKEN
  CLOUDFLARE_JAY_API_TOKEN
  CLOUDFLARE_ST_API_TOKEN
  CLOUDFLARE_CT_API_TOKEN
  CLOUDFLARE_OLD_API_TOKEN
  CLOUDFLARE_API_TOKEN
  R2_USAGE_API_TOKEN
)

ACCOUNT_ID_NAMES=(
  R2_USAGE_ACCOUNT_ID
  CLOUDFLARE_JAY_ACCOUNT_ID
  CLOUDFLARE_ST_ACCOUNT_ID
  CLOUDFLARE_CT_ACCOUNT_ID
  CLOUDFLARE_OLD_ACCOUNT_ID
  CLOUDFLARE_ACCOUNT_ID
)

infisical_get() {
  local name="$1"
  if [ -n "$INF_URL" ]; then
    INFISICAL_API_URL="$INF_URL" INFISICAL_TOKEN="$TOKEN" \
      infisical secrets get "$name" --plain --projectId "$UM" --env "$ENV_SLUG" --path "$SECRET_PATH" 2>/dev/null || true
  else
    INFISICAL_TOKEN="$TOKEN" \
      infisical secrets get "$name" --plain --projectId "$UM" --env "$ENV_SLUG" --path "$SECRET_PATH" 2>/dev/null || true
  fi
}

printf '%s\n' \
  "Cloudflare token map  (UM Infisical ${ENV_SLUG})" \
  "Which name to use:" \
  "  fleet-wide analytics     CLOUDFLARE_FLEET_API_TOKEN" \
  "  Usage.Jays.Services      CLOUDFLARE_JAY_API_TOKEN  (then R2_USAGE_API_TOKEN)" \
  "  Socratic.Trade account   CLOUDFLARE_ST_API_TOKEN   (fleet fallback)" \
  "  Congress.Trade account   CLOUDFLARE_CT_API_TOKEN   (fleet fallback)" \
  "  Jay Old account          CLOUDFLARE_OLD_API_TOKEN  (often absent; fleet fallback)" \
  "  legacy alias             CLOUDFLARE_API_TOKEN" \
  "" \
  "Stored account ids (not secret; used to match the probe below):"

for NAME in "${ACCOUNT_ID_NAMES[@]}"; do
  VAL="$(infisical_get "$NAME")"
  if [ -z "$VAL" ]; then
    printf '  %s: (absent)\n' "$NAME"
  else
    printf '  %s: %s\n' "$NAME" "$VAL"
  fi
  unset VAL
done

printf '\n%s\n' "Token probes  (GET /accounts — name, length, fingerprint, visible accounts):"

for NAME in "${TOKEN_NAMES[@]}"; do
  VAL="$(infisical_get "$NAME")"
  if [ -z "$VAL" ]; then
    printf '%s: (absent)\n' "$NAME"
    continue
  fi

  HDR="$(mktemp)"
  chmod 600 "$HDR"
  # Header file so the token is not on a curl argv.
  printf 'Authorization: Bearer %s\n' "$VAL" >"$HDR"
  LEN="${#VAL}"
  # Hash from the header file so the token is never a process argument.
  FP="$(python3 - "$HDR" <<'PY'
import hashlib, sys
path = sys.argv[1]
text = open(path, "r", encoding="utf-8").read()
prefix = "Authorization: Bearer "
line = next((ln[len(prefix):].strip() for ln in text.splitlines() if ln.startswith(prefix)), "")
print(hashlib.sha256(line.encode("utf-8")).hexdigest()[:8] if line else "????????")
PY
)"
  unset VAL

  OUT="$(
    curl -sS -m 25 -H @"$HDR" https://api.cloudflare.com/client/v4/accounts 2>/dev/null \
      | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("   unparseable")
    raise SystemExit
if not d.get("success"):
    errs = "; ".join(e.get("message", "") for e in (d.get("errors") or [])[:1])
    print("   REJECTED: " + errs[:80])
    raise SystemExit
rows = d.get("result") or []
if not rows:
    print("   (token accepted, 0 accounts)")
    raise SystemExit
for a in rows:
    print("   -> %s  (%s)" % (a.get("name"), a.get("id")))
'
  )"
  rm -f "$HDR"

  printf '%s: len=%s fp=%s\n' "$NAME" "$LEN" "$FP"
  if [ -z "$OUT" ]; then
    printf '   (empty/error)\n'
  else
    printf '%s\n' "$OUT"
  fi
done

# Drop the Infisical credential from this shell before exit.
unset TOKEN
