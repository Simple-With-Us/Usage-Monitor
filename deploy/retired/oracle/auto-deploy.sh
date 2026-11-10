#!/usr/bin/env bash
# Root-owned systemd entrypoint. Polls public GitHub main without any deploy
# credential, then delegates the exact SHA to the fail-closed deploy transaction.
set -euo pipefail
umask 027

readonly REPOSITORY_URL="https://github.com/jaywedgeworth22/Usage-Monitor.git"
readonly HOST_ENV="/etc/usage-monitor/host.env"
readonly PAUSE_FILE="/etc/usage-monitor/auto-deploy.paused"
readonly STATE_DIR="/var/lib/usage-monitor-deploy"
readonly FAILURE_FILE="${STATE_DIR}/failure-state"
readonly BLOCKED_FILE="${STATE_DIR}/blocked-sha"
readonly BLOCKED_REASON_FILE="${STATE_DIR}/blocked-sha.json"
readonly CHECK_RETRY_FILE="${STATE_DIR}/check-retry-state"
readonly DEPLOY_COMMAND="/usr/local/sbin/usage-monitor-deploy"
readonly LOCK_FILE="/run/lock/usage-monitor-deploy.lock"
readonly PUBLIC_READY_URL="https://usage.jays.services/api/ready?strict=1"
readonly DATA_DIR="/data"
readonly MAX_FAILURES=3
readonly CHECK_RETRY_SECONDS=300

log() {
  printf '[usage-monitor-auto-deploy] %s\n' "$*"
}

read_env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v wanted="${key}" '
    $1 == wanted {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      apostrophe = sprintf("%c", 39)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") ||
          (first == apostrophe && last == apostrophe)) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "${file}"
}

write_atomic() {
  local destination="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${STATE_DIR}/.state.XXXXXX")"
  printf '%s\n' "${value}" >"${temporary}"
  chmod 0600 "${temporary}"
  mv -f "${temporary}" "${destination}"
}

clear_failure_state() {
  unlink "${FAILURE_FILE}" 2>/dev/null || true
  unlink "${BLOCKED_FILE}" 2>/dev/null || true
  unlink "${BLOCKED_REASON_FILE}" 2>/dev/null || true
  unlink "${CHECK_RETRY_FILE}" 2>/dev/null || true
}

# Latch a revision AND record why: blocked-sha alone told an operator nothing.
# blocked-sha.json carries {blockedRevision, reason, blockedAt} so recovery
# starts from the journal-independent state file, not an archaeology dig.
block_revision() {
  local revision="$1"
  local reason="$2"
  write_atomic "${BLOCKED_FILE}" "${revision}"
  write_atomic "${BLOCKED_REASON_FILE}" "$(jq -nc \
    --arg blockedRevision "${revision}" \
    --arg reason "${reason}" \
    --arg blockedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{blockedRevision: $blockedRevision, reason: $reason, blockedAt: $blockedAt}')"
  unlink "${FAILURE_FILE}" 2>/dev/null || true
}

recover_current_app_if_stopped() {
  local revision="$1"
  local container_ids count container_id restart_policy body
  # Accept either the clear usage-monitor project name or the legacy oracle name
  # until the first rename cutover lands.
  if ! container_ids="$(timeout 30 docker ps \
    --filter 'label=com.docker.compose.project=usage-monitor' \
    --filter 'label=com.docker.compose.service=app' \
    --format '{{.ID}}')"; then
    log "Docker state is temporarily unavailable."
    return 75
  fi
  if [[ -z "${container_ids//[$'\t\n\r ']/}" ]]; then
    container_ids="$(timeout 30 docker ps \
      --filter 'label=com.docker.compose.project=oracle' \
      --filter 'label=com.docker.compose.service=app' \
      --format '{{.ID}}' 2>/dev/null || true)"
  fi
  count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"${container_ids}")"
  if [[ "${count}" == "1" ]]; then
    container_id="$(awk 'NF { print; exit }' <<<"${container_ids}")"
    if ! restart_policy="$(timeout 30 docker inspect \
      --format '{{.HostConfig.RestartPolicy.Name}}' "${container_id}")"; then
      log "ERROR: could not inspect the accepted app restart policy."
      return 1
    fi
    if [[ "${restart_policy}" != "no" ]]; then
      log "disabling Docker-level restart so only the mount-gated systemd unit can start the writer."
      if ! timeout 30 docker update --restart=no "${container_id}" >/dev/null; then
        log "ERROR: could not disable Docker-level app restart."
        return 1
      fi
    fi
    if [[ "$(timeout 30 docker inspect \
      --format '{{.HostConfig.RestartPolicy.Name}}' "${container_id}")" != "no" ]]; then
      log "ERROR: accepted app restart policy is not no."
      return 1
    fi
    return 0
  fi
  if [[ "${count}" != "0" ]]; then
    log "ERROR: expected at most one app container, found ${count}; refusing recovery."
    return 1
  fi
  if ! mountpoint -q "${DATA_DIR}"; then
    log "ERROR: ${DATA_DIR} is not mounted; refusing to start the SQLite writer."
    return 1
  fi

  log "the accepted app container is stopped; restarting it through the mount-gated systemd unit."
  if ! timeout --signal=TERM --kill-after=30s 600 \
    systemctl restart usage-monitor.service; then
    log "ERROR: mount-gated usage-monitor.service recovery failed."
    return 1
  fi
  for _ in {1..60}; do
    # No curl -f: strict ready returns HTTP 503 when not_ready, but the JSON
    # body is still the gate signal (R2 free-tier kill switch is intentional).
    if body="$(curl -sS --max-time 15 "${PUBLIC_READY_URL}" 2>/dev/null)" && \
      public_ready_matches_revision "${body}" "${revision}"; then
      log "mount-gated recovery restored accepted revision ${revision}."
      return 0
    fi
    sleep 5
  done
  log "ERROR: recovered app did not become ready at ${revision} within ten minutes."
  return 1
}

# Public readiness gate shared by recovery and the already-current short-circuit.
# When /data/r2-disabled-70pct.flag is present, backup.active is intentionally
# false and status is not_ready — require only live revision + DB + scheduler.
public_ready_matches_revision() {
  local body="$1"
  local revision="$2"
  if [[ -f /data/r2-disabled-70pct.flag ]]; then
    jq -e --arg revision "${revision}" '
      .revision == $revision and
      .checks.database.ok == true and
      .checks.scheduler.ok == true and
      .checks.scheduler.required == true and
      .checks.scheduler.lastTickSucceeded == true
    ' >/dev/null <<<"${body}"
    return $?
  fi
  jq -e --arg revision "${revision}" '
    .status == "ready" and .revision == $revision and
    .checks.database.ok == true and .checks.backup.ok == true and
    .checks.backup.required == true and .checks.scheduler.ok == true and
    .checks.scheduler.required == true
  ' >/dev/null <<<"${body}"
}

if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root."
  exit 1
fi

install -d -o root -g root -m 0750 "${STATE_DIR}"

if [[ "${1:-}" == "--retry-blocked" ]]; then
  log "operator cleared the blocked-revision circuit breaker."
  clear_failure_state
  shift
fi
if (( $# != 0 )); then
  log "ERROR: unsupported arguments."
  exit 64
fi

# Recovery and the deployment transaction share one lock. This prevents a
# timer pass from reviving the accepted writer while a manual transaction is
# inside its deliberate writer-stop cutover window.
exec 8>"${LOCK_FILE}"
if ! flock -w 10 8; then
  log "deployment lock is already held; deferring app recovery."
  exit 75
fi

current_sha="$(read_env_value "${HOST_ENV}" USAGE_MONITOR_REVISION)"
if [[ ! "${current_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  log "ERROR: host state contains no valid accepted revision."
  exit 1
fi
set +e
recover_current_app_if_stopped "${current_sha}"
recovery_status=$?
set -e
if (( recovery_status != 0 )); then
  exit "${recovery_status}"
fi

# The child transaction acquires this same lock itself. Release the recovery
# lease first so the timer never self-deadlocks; any competing transaction that
# wins the gap remains protected and makes the child defer with status 75.
flock -u 8
exec 8>&-

if [[ -e "${PAUSE_FILE}" ]]; then
  log "deployments paused by ${PAUSE_FILE}; mount-gated app recovery remains active."
  exit 0
fi

target_sha="$(git ls-remote "${REPOSITORY_URL}" refs/heads/main | cut -f1)"
if [[ ! "${target_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  log "ERROR: GitHub returned no valid main SHA."
  exit 75
fi

if [[ -f "${BLOCKED_FILE}" ]]; then
  blocked_sha="$(tr -d '[:space:]' <"${BLOCKED_FILE}")"
  if [[ "${blocked_sha}" == "${target_sha}" ]]; then
    # exit 1, not 0: a latched breaker must keep this unit visibly failed so
    # `systemctl is-failed usage-monitor-auto-deploy.service` is a reliable
    # wedge signal. The previous exit 0 let the next timer pass repaint the
    # unit green ~60s after the latch, hiding the wedge from operators.
    log "revision ${target_sha} is blocked (see ${BLOCKED_REASON_FILE}); production stays on ${current_sha}. Recover with: usage-monitor-auto-deploy --retry-blocked"
    exit 1
  fi
  log "main advanced beyond blocked revision ${blocked_sha}; resetting the circuit breaker."
  clear_failure_state
fi

if [[ -f "${CHECK_RETRY_FILE}" ]]; then
  read -r retry_sha retry_after <"${CHECK_RETRY_FILE}" || true
  if [[ "${retry_sha:-}" == "${target_sha}" && "${retry_after:-}" =~ ^[0-9]+$ ]] && \
    (( $(date -u +%s) < retry_after )); then
    log "revision ${target_sha} has a failed required check; waiting for a possible GitHub rerun."
    exit 0
  fi
  unlink "${CHECK_RETRY_FILE}"
fi

if [[ "${current_sha}" == "${target_sha}" ]]; then
  if body="$(curl -sS --max-time 15 "${PUBLIC_READY_URL}" 2>/dev/null)" && \
    public_ready_matches_revision "${body}" "${target_sha}"; then
    clear_failure_state
    log "production is already healthy at ${target_sha}."
    exit 0
  fi
  log "host state names ${target_sha}, but public readiness does not; requesting an idempotent repair deploy."
fi

set +e
"${DEPLOY_COMMAND}" "${target_sha}"
deploy_status=$?
set -e

case "${deploy_status}" in
  0)
    clear_failure_state
    log "deployment transaction completed for ${target_sha}."
    exit 0
    ;;
  75)
    log "revision ${target_sha} is not deployable yet; required GitHub checks may still be running."
    exit 75
    ;;
  77)
    retry_after=$(( $(date -u +%s) + CHECK_RETRY_SECONDS ))
    write_atomic "${CHECK_RETRY_FILE}" "${target_sha} ${retry_after}"
    unlink "${FAILURE_FILE}" 2>/dev/null || true
    log "revision ${target_sha} has a failed required check; it will be re-evaluated after ${CHECK_RETRY_SECONDS}s."
    exit 0
    ;;
  78)
    block_revision "${target_sha}" "terminal_eligibility"
    log "revision ${target_sha} failed a terminal eligibility guard and is now blocked."
    exit 0
    ;;
  79)
    # Host-environment preflight failure (full disk, unhealthy mount, SQLite
    # integrity, runtime-env invariants): a property of the box, not of the
    # revision. Never counts toward the revision circuit breaker; exit 1 keeps
    # the unit loudly failed until the host condition is fixed, and the timer
    # keeps retrying every minute.
    log "revision ${target_sha} deferred by a host-environment preflight failure; not counting it against the revision circuit breaker."
    exit 1
    ;;
esac

failure_count=1
if [[ -f "${FAILURE_FILE}" ]]; then
  read -r failed_sha previous_count <"${FAILURE_FILE}" || true
  if [[ "${failed_sha:-}" == "${target_sha}" && "${previous_count:-}" =~ ^[0-9]+$ ]]; then
    failure_count=$((previous_count + 1))
  fi
fi

if (( failure_count >= MAX_FAILURES )); then
  block_revision "${target_sha}" "max_failures"
  log "revision ${target_sha} failed ${failure_count} deployment attempts and is now blocked."
  exit 1
fi

write_atomic "${FAILURE_FILE}" "${target_sha} ${failure_count}"
log "revision ${target_sha} deployment failed (attempt ${failure_count}/${MAX_FAILURES}); the timer will retry."
exit 1
