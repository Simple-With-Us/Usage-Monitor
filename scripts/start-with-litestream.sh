#!/usr/bin/env bash
# Render startCommand entrypoint. Replaces the raw
# "node scripts/migrate-safe.mjs && npm start" tail with an opt-in wrapper:
#
#   - LITESTREAM_S3_* unset (default): create and integrity-check a bounded
#     local backup of an existing DB, run migrate-safe, then exec npm start.
#     `exec` makes npm start PID 1 so it receives Render's SIGTERM directly
#     instead of a wrapper shell swallowing it.
#   - LITESTREAM_S3_* all set AND bin/litestream present (see
#     scripts/fetch-litestream.sh): restore from R2 if the disk has no DB yet
#     (fresh disk / disaster recovery), run migrate-safe, then exec litestream
#     as PID 1 with npm start as its supervised child (-exec), so every write
#     to /data/prod.db is continuously replicated to R2.
#
# Partial replication configuration, a configured replica with no verified
# binary, or LITESTREAM_REQUIRED=true without an active replica is a startup
# error. This prevents a deploy from silently running without its intended
# backup path.
#
# backup-sqlite-before-migrate.mjs then migrate-safe.mjs run exactly once in
# both paths, before the server starts, and always against the post-restore (or
# existing) database file. An existing database cannot be migrated unless a
# transaction-consistent local backup passes SQLite integrity verification.
#
# Uses `exec` for the final process in each branch so it becomes PID 1 (or
# litestream's supervised child) and receives Render's SIGTERM directly for
# graceful shutdown — no wrapper shell left holding the signal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="/data/prod.db"
export APP_STARTUP_WRAPPER="start-with-litestream-v2"

log() {
  echo "[start-with-litestream] $*"
}

# Normalize AWS_* unified secret names into LITESTREAM_S3_* for litestream.yml expansion
: "${LITESTREAM_S3_BUCKET:=${AWS_S3_BUCKET_NAME:-}}"
: "${LITESTREAM_S3_ENDPOINT:=${AWS_S3_ENDPOINT:-}}"
: "${LITESTREAM_S3_REGION:=${AWS_REGION:-auto}}"
: "${LITESTREAM_S3_ACCESS_KEY_ID:=${AWS_ACCESS_KEY_ID:-}}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY:=${AWS_SECRET_ACCESS_KEY:-}}"
export LITESTREAM_S3_BUCKET LITESTREAM_S3_ENDPOINT LITESTREAM_S3_REGION LITESTREAM_S3_ACCESS_KEY_ID LITESTREAM_S3_SECRET_ACCESS_KEY

REQUIRED_KEYS=(
  LITESTREAM_S3_BUCKET
  LITESTREAM_S3_ENDPOINT
  LITESTREAM_S3_ACCESS_KEY_ID
  LITESTREAM_S3_SECRET_ACCESS_KEY
)

case "${LITESTREAM_REQUIRED:-false}" in
  true|false) ;;
  *)
    log "ERROR: LITESTREAM_REQUIRED must be exactly true or false."
    exit 1
    ;;
esac

configured_keys=0
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -n "${!key:-}" ]]; then
    configured_keys=$((configured_keys + 1))
  fi
done

if (( configured_keys > 0 && configured_keys < ${#REQUIRED_KEYS[@]} )); then
  log "ERROR: Litestream is partially configured (${configured_keys}/${#REQUIRED_KEYS[@]} required values set)."
  log "Set all bucket/endpoint/access-key-id/secret-access-key values together, or unset all four."
  exit 1
fi

# Cloudflare R2 free-tier kill switch applies ONLY when the replica endpoint is
# R2. Production primary is Backblaze B2 (jays-usage-monitor-eu, 2026-08-07);
# R2 is historic freeze and must not gate B2 replication.
litestream_endpoint_is_r2=false
litestream_endpoint_is_b2=false
endpoint_lc="$(printf '%s' "${LITESTREAM_S3_ENDPOINT:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "${endpoint_lc}" == *"r2.cloudflarestorage.com"* || "${endpoint_lc}" == *".r2.cloudflare.com"* ]]; then
  litestream_endpoint_is_r2=true
fi
if [[ "${endpoint_lc}" == *"backblazeb2.com"* ]]; then
  litestream_endpoint_is_b2=true
fi

# R2 free-tier kill switch. Precedence must match isR2AutoDisabled() in
# src/lib/r2-usage.ts exactly:
#   1. the disable flag FILE wins — an explicit, persisted kill
#   2. otherwise an env-set kill applies UNLESS the auto-resume marker exists
#   3. otherwise replication runs
# The marker exists because an env-sourced kill used to be unclearable: the
# app could only resume by mutating its own process.env, so every restart
# re-injected the variable from deploy config and undid it.
r2_free_tier_kill=false
if [[ -f "/data/r2-disabled-70pct.flag" ]]; then
  r2_free_tier_kill=true
elif [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" || "${R2_WRITES_DISABLED:-false}" == "true" ]]; then
  if [[ -f "/data/r2-auto-resumed.flag" ]]; then
    log "R2 kill switch is set in the environment, but /data/r2-auto-resumed.flag records an auto-resume — honouring the resume. Remove the stale env vars."
  else
    r2_free_tier_kill=true
  fi
fi

litestream_enabled=false
if (( configured_keys == ${#REQUIRED_KEYS[@]} )); then
  if [[ ! -x "${LITESTREAM_BIN}" ]]; then
    log "ERROR: Litestream is configured but the verified binary is unavailable at ${LITESTREAM_BIN}."
    exit 1
  fi
  litestream_enabled=true
  if [[ "${r2_free_tier_kill}" == "true" && "${litestream_endpoint_is_r2}" == "true" ]]; then
    log "WARNING: Litestream replication disabled via R2 free-tier kill switch (70% threshold)."
    log "Delete /data/r2-disabled-70pct.flag and clear LITESTREAM_EMERGENCY_DISABLE to resume after pruning R2."
    log "Prefer switching LITESTREAM_S3_* to Backblaze B2 (jays-usage-monitor-eu) — R2 kill does not apply to B2."
    litestream_enabled=false
  elif [[ "${r2_free_tier_kill}" == "true" && "${litestream_endpoint_is_b2}" == "true" ]]; then
    log "R2 free-tier kill switch is set, but Litestream endpoint is Backblaze B2 — leaving replication ENABLED."
  elif [[ "${r2_free_tier_kill}" == "true" && "${litestream_endpoint_is_r2}" != "true" ]]; then
    log "R2 free-tier kill switch is set, but Litestream endpoint is not R2 — leaving replication ENABLED."
  fi
elif [[ "${LITESTREAM_REQUIRED:-false}" == "true" ]]; then
  log "ERROR: LITESTREAM_REQUIRED=true but no replica credentials are configured."
  exit 1
fi

if [[ "${STARTUP_PREFLIGHT_ONLY:-false}" == "true" ]]; then
  log "preflight OK (replication ${litestream_enabled}; r2_endpoint=${litestream_endpoint_is_r2}; r2_kill=${r2_free_tier_kill})."
  exit 0
fi

# Datadog APM fail-closed (existing fleet vars only).  Partial keys or a
# production start without DD_SERVICE refuse to boot instead of running
# half-blind.  DD_TRACE_ENABLED=false is the throwaway-container opt-out.
dd_opted_out=false
case "${DD_TRACE_ENABLED:-}" in
  0|false|FALSE|off|OFF|no|NO) dd_opted_out=true ;;
esac
dd_signaled=false
for dd_key in DD_SERVICE DD_ENV DD_AGENT_HOST DD_TRACE_AGENT_PORT DD_API_KEY DD_SITE DD_TRACE_ENABLED DD_TRACE_SAMPLE_RATE; do
  if [[ -n "${!dd_key:-}" ]]; then
    dd_signaled=true
    break
  fi
done
if [[ "${dd_opted_out}" != "true" ]]; then
  if [[ -z "${DD_SERVICE:-}" && ( "${dd_signaled}" == "true" || "${NODE_ENV:-}" == "production" ) ]]; then
    log "ERROR: Datadog is required or partially configured but DD_SERVICE is missing."
    log "Reuse the existing fleet DD_* vars. Do not invent secrets. Set DD_TRACE_ENABLED=false only for throwaway containers."
    exit 1
  fi
  if [[ -n "${DD_SERVICE:-}" ]]; then
    case " ${NODE_OPTIONS:-} " in
      *" --require dd-trace/init "*|*" --require dd-trace/init") ;;
      *)
        export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--require dd-trace/init"
        ;;
    esac
  fi
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  export LITESTREAM_ACTIVE=true
  # Side-channel path consumed by getBackupRuntimeStatus. Coolify/Infisical
  # may also set this; default so /api/ready never stays env_active_unverified
  # when replication is actually on.
  export LITESTREAM_REPLICA_STATUS_PATH="${LITESTREAM_REPLICA_STATUS_PATH:-/data/.litestream-replica-status.json}"
  log "replication ENABLED (LITESTREAM_S3_* set, bin/litestream present, r2=${litestream_endpoint_is_r2}, b2=${litestream_endpoint_is_b2})."
  log "replica status path: ${LITESTREAM_REPLICA_STATUS_PATH}"

  if [[ ! -f "${DB_PATH}" ]]; then
    log "no local DB at ${DB_PATH} — attempting restore from replica (no-op if none exists yet)."
    "${LITESTREAM_BIN}" restore -config "${LITESTREAM_CONFIG}" -if-db-not-exists -if-replica-exists "${DB_PATH}"
  else
    log "local DB already present at ${DB_PATH} — skipping restore."
  fi
else
  export LITESTREAM_ACTIVE=false
  log "replication DISABLED (set LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,"
  log "LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY to enable — see docs/litestream.md)."
fi

# Background LTX tip probe → status file for /api/ready. Must run under the
# same Infisical-injected env as litestream (Coolify). Host timers are optional.
start_replica_heartbeat() {
  local heartbeat="${REPO_ROOT}/scripts/replica-status-heartbeat.sh"
  if [[ ! -x "${heartbeat}" ]]; then
    if [[ -f "${heartbeat}" ]]; then
      chmod +x "${heartbeat}" 2>/dev/null || true
    fi
  fi
  if [[ ! -f "${heartbeat}" ]]; then
    log "WARNING: replica-status-heartbeat.sh missing — /api/ready backup stays env_active_unverified."
    return 0
  fi
  # One immediate write so readiness is green before the first 10m tick.
  bash "${heartbeat}" --once || log "WARNING: initial replica heartbeat failed (will retry in loop)."
  bash "${heartbeat}" &
  REPLICA_HEARTBEAT_PID=$!
  log "replica heartbeat started pid=${REPLICA_HEARTBEAT_PID}"
}

stop_replica_heartbeat() {
  if [[ -n "${REPLICA_HEARTBEAT_PID:-}" ]] && kill -0 "${REPLICA_HEARTBEAT_PID}" 2>/dev/null; then
    kill "${REPLICA_HEARTBEAT_PID}" 2>/dev/null || true
    wait "${REPLICA_HEARTBEAT_PID}" 2>/dev/null || true
  fi
  REPLICA_HEARTBEAT_PID=""
}

log "Disk space on /data before backup:"
df -h /data || true
du -sh /data/.* 2>/dev/null || true
du -sh /data/* 2>/dev/null || true

if [[ -d "/data/.pre-migration-backups" ]]; then
  log "cleaning up old partial pre-migration backups to prevent disk full errors."
  # Only collect partials older than twice the resolved snapshot deadline: a
  # partial being written by a live snapshot child (possibly in another
  # container sharing this volume) is younger and must survive startup cleanup.
  stale_guard_out=""
  stale_guard_status=0
  stale_guard_out="$(
    node "${REPO_ROOT}/scripts/lib/sqlite-pre-migration-backup-timing.mjs" --guard-minutes
  )" || stale_guard_status=$?
  if (( stale_guard_status != 0 )) || [[ ! "${stale_guard_out}" =~ ^[0-9]+$ ]]; then
    log "ERROR: stale-partial guard could not be computed; stale .partial cleanup is SKIPPED this boot."
  else
    find /data/.pre-migration-backups -maxdepth 1 -type f -name '*.partial' -mmin +"${stale_guard_out}" -delete 2>/dev/null || true
  fi
fi

log "creating and verifying pre-migration SQLite backup when a database exists."
node "${REPO_ROOT}/scripts/backup-sqlite-before-migrate.mjs"


log "checking provider billing links before enforcing uniqueness."
node "${REPO_ROOT}/scripts/audit-subscription-links.mjs"
node "${REPO_ROOT}/scripts/ensure-subscription-link-unique-index.mjs"

node "${REPO_ROOT}/scripts/migrate-safe.mjs"

if [[ "${litestream_enabled}" == "true" && "${litestream_endpoint_is_r2}" == "true" ]]; then
  # R2 path: run litestream as a sibling of npm so the free-tier kill switch can
  # stop replication mid-cycle without taking the app down. A watcher polls the
  # flag every 30s: stop litestream when killed, and RESTART it after the flag
  # is cleared (auto-resume after tip-prune) without requiring a container bounce.
  log "starting litestream replicate (R2) as supervised sibling of npm start."
  LITESTREAM_PID_FILE="$(mktemp /tmp/um-litestream-pid.XXXXXX)"
  start_r2_litestream() {
    "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" &
    echo $! >"${LITESTREAM_PID_FILE}"
    log "litestream started pid=$(cat "${LITESTREAM_PID_FILE}")"
  }
  stop_r2_litestream() {
    local pid=""
    if [[ -f "${LITESTREAM_PID_FILE}" ]]; then
      pid="$(cat "${LITESTREAM_PID_FILE}" 2>/dev/null || true)"
    fi
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      log "stopping litestream pid=${pid}"
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
    : >"${LITESTREAM_PID_FILE}"
  }
  # Same precedence as the boot-time check above and isR2AutoDisabled().
  r2_kill_active() {
    if [[ -f "/data/r2-disabled-70pct.flag" ]]; then return 0; fi
    if [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" \
      || "${R2_WRITES_DISABLED:-false}" == "true" ]]; then
      [[ -f "/data/r2-auto-resumed.flag" ]] && return 1
      return 0
    fi
    return 1
  }
  start_replica_heartbeat
  start_r2_litestream
  (
    was_killed=false
    while true; do
      if r2_kill_active; then
        if [[ "${was_killed}" != "true" ]]; then
          log "R2 free-tier kill switch active — stopping litestream."
          stop_r2_litestream
          was_killed=true
        fi
      else
        pid=""
        if [[ -f "${LITESTREAM_PID_FILE}" ]]; then
          pid="$(cat "${LITESTREAM_PID_FILE}" 2>/dev/null || true)"
        fi
        if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
          if [[ "${was_killed}" == "true" ]]; then
            log "R2 kill cleared — restarting litestream."
          else
            log "litestream not running (unexpected exit) — restarting."
          fi
          start_r2_litestream
          was_killed=false
        fi
      fi
      sleep 30
    done
  ) &
  R2_WATCH_PID=$!
  cleanup_r2_litestream() {
    log "shutting down R2 litestream sibling, watcher, and replica heartbeat."
    kill "${R2_WATCH_PID}" 2>/dev/null || true
    stop_r2_litestream
    stop_replica_heartbeat
    rm -f "${LITESTREAM_PID_FILE}" 2>/dev/null || true
  }
  trap cleanup_r2_litestream SIGTERM SIGINT EXIT
  # npm start as the foreground process (receives container SIGTERM via trap).
  npm start
  app_status=$?
  cleanup_r2_litestream
  trap - SIGTERM SIGINT EXIT
  exit "${app_status}"
fi

if [[ "${litestream_enabled}" == "true" ]]; then
  # Non-R2 (B2 primary): litestream as PID 1 with -exec. Heartbeat runs beside
  # npm under scripts/run-app-with-replica-heartbeat.sh so Infisical env is
  # inherited and /api/ready gets a live LTX side-channel.
  log "starting litestream replicate (non-R2/B2) wrapping app+heartbeat as supervised child."
  exec "${LITESTREAM_BIN}" replicate -config "${LITESTREAM_CONFIG}" \
    -exec "bash ${REPO_ROOT}/scripts/run-app-with-replica-heartbeat.sh"
fi

exec npm start
