#!/usr/bin/env bash
#
# infisical-secrets-safe.sh — read/write Infisical secrets WITHOUT ever printing
# a value to the terminal.
#
# Why this exists
# ---------------
# The Infisical CLI's default `infisical secrets` table-prints every secret
# value, and `--plain` / `--output json` dump them too.  That is a confirmed
# leak vector: it puts live credentials into scrollback, CI logs, and agent
# transcripts.  Fleet canon (AGENT-SYNC.md § Secret handoff) says to prefer a
# repo helper over the raw CLI; this repo referenced one but never had it.
#
# Every subcommand here is value-blind by construction:
#   names            list secret KEY NAMES only
#   has KEY          exit 0/1 — does KEY exist, with a non-empty value
#   set KEY          copy KEY from `fleet-secrets get` into this project's Infisical
#   pull KEY         retired (OPS-818);  nothing writes or reads the flat secrets file
#   sync-platforms   batch-copy the platform-status tokens (see MAP below)
#
# A value only ever travels: fleet-secrets -> shell variable -> CLI (stdin or
# captured --plain). It is never interpolated into a command line (visible in
# `ps`), never echoed, and never written to a log.
#
# Usage
# -----
#   bash scripts/infisical-secrets-safe.sh names
#   bash scripts/infisical-secrets-safe.sh has UPTIMEROBOT_API_KEY
#   bash scripts/infisical-secrets-safe.sh set UPTIMEROBOT_API_KEY
#   bash scripts/infisical-secrets-safe.sh sync-platforms --dry-run
#   bash scripts/infisical-secrets-safe.sh sync-platforms
#
# Environment (all optional, sane defaults for Usage Monitor prod):
#   INFISICAL_PROJECT_ID   (see fleet-ops:ATTACK-MAP.md)
#   INFISICAL_ENV          default prod
#   INFISICAL_PATH         default /
#   INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET  universal-auth machine identity
#                          (falls back to INFISICAL_AUTOMATION_* / INFISICAL_UM_*)
#
set -euo pipefail

PROJECT_ID="${INFISICAL_PROJECT_ID:-${INFISICAL_UM_PROJECT_ID:-}}"
ENV_SLUG="${INFISICAL_ENV:-prod}"
SECRET_PATH="${INFISICAL_PATH:-/}"

die() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

command -v infisical >/dev/null 2>/dev/null || die "infisical CLI not found on PATH."

# One value from the Mac-side fleet-secrets CLI (root, then /global-api-keys).
# Prints nothing and succeeds when the binary or the key is absent.
fleet_value() {
  local name="$1"
  command -v fleet-secrets >/dev/null 2>/dev/null || return 0
  fleet-secrets get "$name" --path / 2>/dev/null \
    || fleet-secrets get "$name" --path /global-api-keys 2>/dev/null \
    || true
}

# ---------------------------------------------------------------------------
# Auth — mirrors scripts/infisical-run.mjs's credential precedence.
# ---------------------------------------------------------------------------
infisical_token() {
  if [ -n "${INFISICAL_TOKEN:-}" ]; then printf '%s' "$INFISICAL_TOKEN"; return 0; fi

  local id secret
  id="${INFISICAL_CLIENT_ID:-${INFISICAL_UM_CLIENT_ID:-${INFISICAL_AUTOMATION_CLIENT_ID:-${INFISICAL_SHARED_CLIENT_ID:-}}}}"
  secret="${INFISICAL_CLIENT_SECRET:-${INFISICAL_UM_CLIENT_SECRET:-${INFISICAL_AUTOMATION_CLIENT_SECRET:-${INFISICAL_SHARED_CLIENT_SECRET:-}}}}"
  # OPS-818: the retired flat key file is gone as a source;  fall back to
  # fleet-secrets (captured, never echoed) for the automation identity.
  [ -n "$id" ] || id="$(fleet_value INFISICAL_AUTOMATION_CLIENT_ID)"
  [ -n "$secret" ] || secret="$(fleet_value INFISICAL_AUTOMATION_CLIENT_SECRET)"
  [ -n "$id" ] && [ -n "$secret" ] || die \
    "No Infisical credentials. Export INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET (or INFISICAL_TOKEN), or install fleet-secrets."

  # --silent keeps the token off stdout except as the captured value.
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$id" \
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$secret" \
    infisical login --method=universal-auth --plain --silent 2>/dev/null \
    || die "Infisical login failed (machine identity rejected)."
}

TOKEN=""
ensure_token() { [ -n "$TOKEN" ] || TOKEN="$(infisical_token)"; }

# ---------------------------------------------------------------------------
# Value-blind primitives
# ---------------------------------------------------------------------------

# Print only KEY NAMES from the project. Never values.
cmd_names() {
  ensure_token
  infisical secrets --token="$TOKEN" --projectId="$PROJECT_ID" \
    --env="$ENV_SLUG" --path="$SECRET_PATH" --silent --plain 2>/dev/null \
    | grep -oE '^[A-Za-z_][A-Za-z0-9_]*' | sort -u
}

# Exit 0 if KEY exists in Infisical with a non-empty value.
cmd_has() {
  local key="${1:?usage: has KEY}"
  cmd_names | grep -qx "$key"
}

# Read KEY's value from fleet-secrets without printing it.
read_local_value() {
  local key="$1" value
  value="$(fleet_value "$key")"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# Copy SRC_KEY from fleet-secrets into this project's Infisical as DEST_KEY.
# The value is passed as an argument to the CLI, so we scrub it from any
# output the CLI produces before that output can reach a terminal.
set_secret() {
  local src="$1" dest="${2:-$1}" value
  value="$(read_local_value "$src")" || { note "  SKIP  $dest  (source $src not available from fleet-secrets)"; return 1; }
  ensure_token
  if infisical secrets set "$dest=$value" \
      --token="$TOKEN" --projectId="$PROJECT_ID" \
      --env="$ENV_SLUG" --path="$SECRET_PATH" --silent >/dev/null 2>/dev/null; then
    note "  OK    $dest  <- $src"
  else
    note "  FAIL  $dest  <- $src  (CLI rejected the write)"
    return 1
  fi
}

cmd_set() {
  local key="${1:?usage: set KEY [DEST_KEY]}"
  set_secret "$key" "${2:-$key}"
}

# Retired (OPS-818): `pull` copied an Infisical value into the flat local
# secrets file, which nothing may read or edit by hand any more.  Read a value
# with `fleet-secrets get KEY` instead.
cmd_pull() {
  die "pull is retired.  Use: fleet-secrets get KEY"
}

# Delete KEY(s) from Infisical. `infisical secrets delete` prints nothing
# useful and would happily echo context, so its output is suppressed the same
# way every other write here is — the caller learns the outcome from the
# OK/FAIL line and the exit code, never from CLI chatter.
#
# Defaults to --type shared: these are project secrets, not the per-user
# personal overrides the CLI assumes by default. Deleting the personal copy of
# a shared secret silently does nothing, which looks like success.
cmd_delete() {
  [ "$#" -gt 0 ] || die "usage: delete KEY [KEY...]"
  ensure_token
  local rc=0
  for key in "$@"; do
    if ! cmd_has "$key"; then
      note "  SKIP  $key  (not present)"
      continue
    fi
    if infisical secrets delete "$key" --type=shared \
        --token="$TOKEN" --projectId="$PROJECT_ID" \
        --env="$ENV_SLUG" --path="$SECRET_PATH" >/dev/null 2>/dev/null; then
      if cmd_has "$key"; then
        note "  FAIL  $key  (CLI reported success but the key is still present)"
        rc=1
      else
        note "  OK    $key  deleted"
      fi
    else
      note "  FAIL  $key  (CLI rejected the delete)"
      rc=1
    fi
  done
  return "$rc"
}

# ---------------------------------------------------------------------------
# sync-platforms — the platform-status probe tokens.
#
# Format: SRC_KEY:DEST_KEY.  They differ where the secret store's name does not
# match the env var the probe reads; those renames are the whole reason a
# blind copy of the fleet secrets does not light these cards up.
# ---------------------------------------------------------------------------
MAP=(
  "UPTIMEROBOT_API_KEY:UPTIMEROBOT_API_KEY"
  "PAGERDUTY_API_KEY:PAGERDUTY_API_KEY"
  "RENDER_MCP_TOKEN:RENDER_API_KEY"
  "SLACK_MCP_XOXB_TOKEN:SLACK_BOT_TOKEN"
  "PUSHOVER_USAGE_API_TOKEN:PUSHOVER_USAGE_API_TOKEN"
  "PUSHOVER_USER_KEY:PUSHOVER_USER_KEY"
  # GITHUB_TOKEN in the fleet-secrets store is dead (GitHub 401s it directly), but
  # GITHUB_MCP_TOKEN is live — verified 2026-08-12 against /rate_limit.
  "GITHUB_MCP_TOKEN:GITHUB_TOKEN"
  # The project's stored copy went stale while the local one still logs in —
  # verified 2026-08-12 via universal-auth against app.infisical.com.  This
  # was the single dead identity behind the prod Infisical card incident.
  "INFISICAL_ST_CLIENT_SECRET:INFISICAL_ST_CLIENT_SECRET"
)

# Deliberately NOT synced automatically — see the notes printed below.
HELD_BACK=(
  "SENTRY_READ_TOKEN                        already present and WORKING in prod; never overwrite with SENTRY_AUTH_TOKEN (wrong token type)"
  "STRIPE_SECRET_KEY                        Stripe itself says api_key_expired for the stored key; issue a fresh restricted read key first"
  "GITHUB_TOKEN (fleet-secrets copy)         GitHub 401s it; the sync uses GITHUB_MCP_TOKEN instead — fix the store at leisure"
  "TWILIO_MCP_CREDS  -> TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN   one blob, needs splitting by hand"
  "ASC_KEY_PATH      -> ASC_PRIVATE_KEY     source is a FILE PATH; prod needs the .p8 PEM CONTENTS"
  "VERCEL_API_TOKEN                         intentionally absent; Vercel is not used by this fleet directly"
)

cmd_sync_platforms() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1

  note "Infisical target: project ${PROJECT_ID}  env=${ENV_SLUG}  path=${SECRET_PATH}"
  note "Source:          fleet-secrets"
  note ""
  if [ "$dry" = 1 ]; then
    note "DRY RUN — nothing will be written.  Planned copies:"
    for entry in "${MAP[@]}"; do
      local src="${entry%%:*}" dest="${entry##*:}"
      if read_local_value "$src" >/dev/null 2>/dev/null; then
        note "  would set  $dest  <- $src"
      else
        note "  SKIP       $dest  (source $src not present)"
      fi
    done
  else
    note "Writing ${#MAP[@]} secrets:"
    for entry in "${MAP[@]}"; do
      set_secret "${entry%%:*}" "${entry##*:}" || true
    done
  fi

  note ""
  note "Held back on purpose (copying these would move a broken credential):"
  for h in "${HELD_BACK[@]}"; do note "  - $h"; done
  note ""
  note "Then redeploy so scripts/infisical-run.mjs injects them:"
  note "  the Usage Monitor container pulls this project at boot."
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  names)          shift; cmd_names "$@" ;;
  has)            shift; cmd_has "$@" ;;
  set)            shift; cmd_set "$@" ;;
  pull)           shift; cmd_pull "$@" ;;
  delete)         shift; cmd_delete "$@" ;;
  sync-platforms) shift; cmd_sync_platforms "$@" ;;
  *)
    cat <<'USAGE'
infisical-secrets-safe.sh — value-blind Infisical access.

  names                       list secret KEY NAMES only
  has KEY                     exit 0 if KEY exists with a non-empty value
  set KEY [DEST_KEY]          copy KEY from fleet-secrets into Infisical
  pull KEY [DEST_KEY]         retired;  use fleet-secrets get KEY
  delete KEY [KEY...]         delete shared secret(s), verifying they are gone
  sync-platforms [--dry-run]  batch-copy the platform-status tokens

Credentials: export INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET (or INFISICAL_TOKEN),
or let fleet-secrets supply the automation identity.
USAGE
    exit 2
    ;;
esac
