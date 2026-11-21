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
# transcripts.  Fleet canon (FLEET-PROTOCOL.md § Secret handoff) says to prefer a
# repo helper over the raw CLI; this repo referenced one but never had it.
#
# Every subcommand here is value-blind by construction:
#   names            list secret KEY NAMES only
#   has KEY          exit 0/1 — does KEY exist, with a non-empty value
#   set KEY          copy an Infisical-synced environment value into this project
#   pull KEY         retired (OPS-818);  nothing writes or reads the flat secrets file
#   sync-platforms   batch-copy the platform-status tokens (see MAP below)
#
# A value only ever travels: synced environment -> shell variable -> CLI (stdin or
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
#   INFISICAL_UM_READ_TOKEN                read-only service token for names/has
#   INFISICAL_UM_WRITE_TOKEN               write-only service token for set/delete
#   INFISICAL_TOKEN                        legacy read token only; never used for writes
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${INFISICAL_UM_PROJECT_ID:-${INFISICAL_PROJECT_ID:-${INFISICAL_APP_PROJECT_ID:-}}}"
ENV_SLUG="${INFISICAL_ENV:-prod}"
SECRET_PATH="${INFISICAL_UM_SECRET_PATH:-${INFISICAL_PATH:-/}}"

die() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
validate_key() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Invalid secret key name."; }

case "${1:-}" in
  has|set|delete) for key in "${@:2}"; do validate_key "$key"; done ;;
esac
command -v infisical >/dev/null 2>/dev/null || die "infisical CLI not found on PATH."
node "$ROOT/scripts/check-infisical-token.mjs" config || die "Infisical target configuration rejected."
INFISICAL_ORIGIN="$(node -e 'process.stdout.write(new URL(process.env.INFISICAL_BASE_URL || process.env.INFISICAL_API_URL || "https://app.infisical.com").origin)')" \
  || die "Infisical target configuration rejected."

# Use the same approved origin and selected token as the metadata verifier.
# Subshell changes never alter the caller's environment or bootstrap inputs.
infisical_cli() (
  unset INFISICAL_BASE_URL INFISICAL_API_URL TOKEN \
    INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET \
    INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN \
    INFISICAL_AUTOMATION_CLIENT_ID INFISICAL_AUTOMATION_CLIENT_SECRET \
    INFISICAL_UM_CLIENT_ID INFISICAL_UM_CLIENT_SECRET \
    INFISICAL_UM_READ_TOKEN INFISICAL_UM_WRITE_TOKEN
  export INFISICAL_DOMAIN="$INFISICAL_ORIGIN"
  command infisical "$@"
)

# One explicitly named Infisical-synced environment value; no store discovery.
synced_value() {
  local name="$1"
  validate_key "$name"
  printf '%s' "${!name-}"
}

# ---------------------------------------------------------------------------
# Auth — permission-specific project service tokens only.
# ---------------------------------------------------------------------------
infisical_token() {
  local permission="$1" token token_name
  case "$permission" in
    read)
      token_name="INFISICAL_UM_READ_TOKEN"
      token="${INFISICAL_UM_READ_TOKEN:-${INFISICAL_TOKEN:-}}"
      ;;
    write)
      token_name="INFISICAL_UM_WRITE_TOKEN"
      token="${INFISICAL_UM_WRITE_TOKEN:-}"
      ;;
    *) die "Unsupported Infisical permission" ;;
  esac
  [[ "$token" == st.* ]] || die "$token_name service token required for Infisical $permission access."
  INFISICAL_TOKEN="$token" INFISICAL_UM_PROJECT_ID="$PROJECT_ID" INFISICAL_UM_SECRET_PATH="$SECRET_PATH" \
    node "$ROOT/scripts/check-infisical-token.mjs" "$permission" || die "Infisical credential verification failed."
  printf '%s' "$token"
}

READ_TOKEN=""
WRITE_TOKEN=""
ensure_read_token() { [ -n "$READ_TOKEN" ] || READ_TOKEN="$(infisical_token read)"; }
ensure_write_token() { [ -n "$WRITE_TOKEN" ] || WRITE_TOKEN="$(infisical_token write)"; }

# ---------------------------------------------------------------------------
# Value-blind primitives
# ---------------------------------------------------------------------------

# Print only KEY NAMES from the project. Never values.
cmd_names() {
  ensure_read_token || return 1
  INFISICAL_TOKEN="$READ_TOKEN" infisical_cli secrets --projectId="$PROJECT_ID" \
    --env="$ENV_SLUG" --path="$SECRET_PATH" --silent --plain 2>/dev/null \
    | grep -oE '^[A-Za-z_][A-Za-z0-9_]*' | sort -u
}

# Exit 0 if KEY exists in Infisical with a non-empty value.
cmd_has() {
  local key="${1:?usage: has KEY}"
  validate_key "$key"
  cmd_names | grep -Fxq -- "$key"
}

# Read KEY's synced environment value without printing it.
read_local_value() {
  local key="$1" value
  value="$(synced_value "$key")"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# Copy synced SRC_KEY into this project's Infisical as DEST_KEY.
# The CLI reads the value from stdin using its supported @file input.
set_secret() {
  local src="$1" dest="${2:-$1}" value
  validate_key "$src"
  validate_key "$dest"
  value="$(read_local_value "$src")" || { note "  SKIP  $dest  (source $src not available in synced environment)"; return 1; }
  ensure_write_token || return 1
  if printf '%s' "$value" | INFISICAL_TOKEN="$WRITE_TOKEN" infisical_cli secrets set "$dest=@/dev/stdin" \
      --projectId="$PROJECT_ID" \
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
# secrets file, which nothing may read or edit by hand any more.
cmd_pull() {
  die "pull is retired.  Use an Infisical-synced environment value."
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
  for key in "$@"; do validate_key "$key"; done
  ensure_read_token || return 1
  ensure_write_token || return 1
  local rc=0
  for key in "$@"; do
    if ! cmd_has "$key"; then
      note "  SKIP  $key  (not present)"
      continue
    fi
    if INFISICAL_TOKEN="$WRITE_TOKEN" infisical_cli secrets delete "$key" --type=shared \
        --projectId="$PROJECT_ID" \
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
  # Use the explicit synced source; do not substitute a generic GITHUB_TOKEN.
  "GITHUB_MCP_TOKEN:GITHUB_TOKEN"
)

# Deliberately NOT synced automatically — see the notes printed below.
HELD_BACK=(
  "SENTRY_READ_TOKEN                        never overwrite with SENTRY_AUTH_TOKEN (wrong token type)"
  "STRIPE_SECRET_KEY                        requires separately qualified restricted read credentials"
  "GITHUB_TOKEN                            the sync uses only the explicit GITHUB_MCP_TOKEN source"
  "TWILIO_MCP_CREDS  -> TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN   one blob, needs splitting by hand"
  "ASC_KEY_PATH      -> ASC_PRIVATE_KEY     source is a FILE PATH; prod needs the .p8 PEM CONTENTS"
  "VERCEL_API_TOKEN                         intentionally absent; Vercel is not used by this fleet directly"
)

cmd_sync_platforms() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1

  note "Infisical target: project ${PROJECT_ID}  env=${ENV_SLUG}  path=${SECRET_PATH}"
  note "Source:          Infisical-synced environment"
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
    ensure_write_token || return 1
    note "Writing ${#MAP[@]} secrets:"
    for entry in "${MAP[@]}"; do
      set_secret "${entry%%:*}" "${entry##*:}" || true
    done
  fi

  note ""
  note "Held back on purpose (not copied automatically):"
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
  set KEY [DEST_KEY]          copy a synced environment value into Infisical
  pull KEY [DEST_KEY]         retired;  use synced environment values
  delete KEY [KEY...]         delete shared secret(s), verifying they are gone
  sync-platforms [--dry-run]  batch-copy the platform-status tokens

Credentials: use INFISICAL_UM_READ_TOKEN for names/has and
INFISICAL_UM_WRITE_TOKEN for set/delete; service tokens are required.
USAGE
    exit 2
    ;;
esac
