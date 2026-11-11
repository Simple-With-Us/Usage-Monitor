#!/usr/bin/env bash
# Periodic Litestream replica heartbeat for /api/ready's backup gate.
# Install this file root-owned as /usr/local/sbin/usage-monitor-replica-status
# and drive it with usage-monitor-replica-status.timer (10-minute cadence).
#
# /api/ready no longer trusts the startup-only LITESTREAM_ACTIVE env claim for
# a required backup (see getBackupRuntimeStatus in src/lib/runtime-health.ts):
# it demands this side-channel status file unless
# LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false. This probe is the producer:
# it lists the newest Garage LTX object through the app container's own
# authenticated Litestream binary (the same per-level tip listing the deploy
# gate uses; never `-level all`, which timed out under Coolify load) and
# atomically writes a small JSON verdict where the app can read it.
#
# JSON contract (parsed by getBackupRuntimeStatus's JSON branch):
#   ok        - newest LTX object is younger than the freshness budget.
#   checkedAt - when THIS probe ran. Deliberately the only age signal the app
#               consumes: if this probe stops running, now-checkedAt grows past
#               LITESTREAM_REPLICA_MAX_AGE_SECONDS and readiness fails closed
#               with replica_status_stale. `ageSeconds` is intentionally NOT
#               written - the app prefers it over checkedAt, and a frozen
#               ageSeconds in a stale file would pass forever.
#   ltxAgeSeconds / reason - operator observability only; ignored by the app.
set -Eeuo pipefail
umask 022
export LC_ALL=C

readonly APP_CONTAINER="usage-monitor-app-1"
readonly DB_CONTAINER_PATH="/data/prod.db"
readonly STATUS_FILE="/data/.litestream-replica-status.json"
# Matches the deploy gate's freshness budget (deploy-production.sh) and the
# app's LITESTREAM_REPLICA_MAX_AGE_SECONDS default (src/lib/runtime-health.ts).
# 3h default: litestream.yml uses a 1h sync-interval for R2 free-tier calm.
readonly MAX_LTX_AGE_SECONDS=10800

log() {
  printf '[usage-monitor-replica-status] %s\n' "$*"
}

if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root."
  exit 1
fi

# Prefer L0 tip (fast, small), fall back L1..L5 when L0 is compacted away
# during quiet periods - identical strategy to list_garage_ltx_level in
# deploy-production.sh. Never `-level all`.
list_ltx_level() {
  local level="$1"
  timeout 60 docker exec "${APP_CONTAINER}" \
    /app/bin/litestream ltx -config /app/litestream.yml -level "${level}" \
    "${DB_CONTAINER_PATH}"
}

newest_ltx_created() {
  local listing level latest
  for level in 0 1 2 3 4 5; do
    if listing="$(list_ltx_level "${level}" 2>/dev/null)"; then
      latest="$(awk 'NF == 5 && $1 ~ /^[0-9]+$/ { print $5 }' \
        <<<"${listing}" | sort | tail -n 1)"
      if [[ -n "${latest}" ]]; then
        printf '%s\n' "${latest}"
        return 0
      fi
    fi
  done
  return 1
}

write_status() {
  local ok="$1" ltx_age="$2" reason="$3"
  local checked_at temporary
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temporary="$(mktemp "${STATUS_FILE}.XXXXXX")"
  jq -nc \
    --argjson ok "${ok}" \
    --argjson ltxAgeSeconds "${ltx_age}" \
    --arg reason "${reason}" \
    --arg checkedAt "${checked_at}" \
    '{ok: $ok, checkedAt: $checkedAt, ltxAgeSeconds: $ltxAgeSeconds,
      reason: (if $reason == "" then null else $reason end)}' \
    >"${temporary}"
  # World-readable on purpose: the app container reads it as uid 1000 and the
  # payload is a non-secret health verdict. Atomic rename so /api/ready never
  # reads a torn file.
  chmod 0644 "${temporary}"
  mv -f "${temporary}" "${STATUS_FILE}"
}

# Free-tier kill switch: Litestream is intentionally stopped so LTX stops
# advancing. Report that reason (not a mysterious age exceed) and exit 0 so
# the timer does not look like a broken unit — backup is observability-only.
if [[ -f /data/r2-disabled-70pct.flag ]]; then
  write_status false null "r2_free_tier_disabled"
  log "R2 free-tier kill switch engaged (/data/r2-disabled-70pct.flag); reporting intentional replica pause."
  exit 0
fi

latest_created=""
if ! latest_created="$(newest_ltx_created)"; then
  write_status false null "no_parseable_ltx"
  log "ERROR: replica returned no parseable LTX objects at levels 0-5."
  exit 1
fi

if ! latest_epoch="$(date -u -d "${latest_created}" +%s)"; then
  write_status false null "invalid_ltx_timestamp"
  log "ERROR: replica returned an invalid LTX timestamp: ${latest_created}"
  exit 1
fi

now_epoch="$(date -u +%s)"
age_seconds=$((now_epoch - latest_epoch))
if (( age_seconds < 0 || age_seconds > MAX_LTX_AGE_SECONDS )); then
  write_status false "${age_seconds}" "ltx_age_exceeds_budget"
  log "ERROR: newest LTX object is ${age_seconds}s old (limit ${MAX_LTX_AGE_SECONDS}s)."
  # Exit 0 after writing the verdict: a stale replica is a health signal, not a
  # broken probe. systemd oneshot failure noise was drowning the real reason.
  exit 0
fi

write_status true "${age_seconds}" ""
log "replica healthy: newest LTX object is ${age_seconds}s old."
