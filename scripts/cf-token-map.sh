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
#   (Infisical credentials come from the environment, else `fleet-secrets get`.)
#
# Env (all optional):
#   INFISICAL_PROJECT_ID   (see fleet-ops:ATTACK-MAP.md)
#   INFISICAL_ENV          default prod
#   INFISICAL_API_URL      Infisical host if not the public default
#   INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET
#     or INFISICAL_AUTOMATION_* / INFISICAL_UM_* / CID+CSEC aliases
#
# Output is names, lengths, an 8-hex SHA-256 fingerprint (so two names holding
# the same token can be spotted), and the Cloudflare account list each token
# is allowed to GET /accounts.  Token bytes never go to stdout/stderr.

set -euo pipefail

UM="${INFISICAL_PROJECT_ID:-${INFISICAL_UM_PROJECT_ID:-}}"
ENV_SLUG="${INFISICAL_ENV:-prod}"
INF_URL="${INFISICAL_API_URL:-${INF_URL:-}}"

die() { printf '%s\n' "$*" >&2; exit 1; }

command -v infisical >/dev/null 2>/dev/null || die "infisical CLI not found on PATH."
command -v curl >/dev/null 2>/dev/null || die "curl not found on PATH."
command -v python3 >/dev/null 2>/dev/null || die "python3 not found on PATH."

CID="${INFISICAL_CLIENT_ID:-${INFISICAL_UM_CLIENT_ID:-${INFISICAL_AUTOMATION_CLIENT_ID:-${CID:-}}}}"
CSEC="${INFISICAL_CLIENT_SECRET:-${INFISICAL_UM_CLIENT_SECRET:-${INFISICAL_AUTOMATION_CLIENT_SECRET:-${CSEC:-}}}}"
# OPS-818: the retired flat key file is no longer read.  Fall back to the
# Mac-side fleet-secrets CLI for the automation identity (captured, never echoed).
fleet_value() {
  command -v fleet-secrets >/dev/null 2>/dev/null || return 0
  fleet-secrets get "$1" --path / 2>/dev/null \
    || fleet-secrets get "$1" --path /global-api-keys 2>/dev/null \
    || true
}
[ -n "$CID" ] || CID="$(fleet_value INFISICAL_AUTOMATION_CLIENT_ID)"
[ -n "$CSEC" ] || CSEC="$(fleet_value INFISICAL_AUTOMATION_CLIENT_SECRET)"
[ -n "$CID" ] && [ -n "$CSEC" ] || die \
  "No Infisical credentials. Export INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET, or install fleet-secrets."

# Credentials via env, not argv (avoids `ps` / debug-echo leaks).
export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$CID"
export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$CSEC"
if [ -n "$INF_URL" ]; then
  export INFISICAL_API_URL="$INF_URL"
fi
TOKEN="$(infisical login --method=universal-auth --plain --silent 2>/dev/null || true)"
unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
[ -n "${TOKEN:-}" ] || die "infisical login failed"

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
      infisical secrets get "$name" --plain --projectId "$UM" --env "$ENV_SLUG" 2>/dev/null || true
  else
    INFISICAL_TOKEN="$TOKEN" \
      infisical secrets get "$name" --plain --projectId "$UM" --env "$ENV_SLUG" 2>/dev/null || true
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

# Token is a session JWT; drop it before exit.
unset TOKEN CID CSEC
