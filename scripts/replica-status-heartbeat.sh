#!/usr/bin/env bash
# Write /data/.litestream-replica-status.json for /api/ready backup verification.
#
# Runs *inside* the app container (or under Infisical-injected env) so
# litestream.yml expands LITESTREAM_S3_* the same way the replicate process
# does. Host-side `docker exec` without that env fails with "bucket required"
# on Coolify, where Infisical injects secrets into the process tree only.
#
# JSON contract matches getBackupRuntimeStatus (src/lib/runtime-health.ts):
#   ok, checkedAt (drives staleness), ltxAgeSeconds + reason (operator only).
# Deliberately omits ageSeconds so a frozen file cannot pass forever.
set -euo pipefail
umask 022
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LITESTREAM_BIN="${LITESTREAM_BIN_PATH:-${REPO_ROOT}/bin/litestream}"
LITESTREAM_CONFIG="${REPO_ROOT}/litestream.yml"
DB_PATH="${LITESTREAM_DB_PATH:-/data/prod.db}"
STATUS_FILE="${LITESTREAM_REPLICA_STATUS_PATH:-/data/.litestream-replica-status.json}"
# Align with runtime-health default + 1h litestream sync-interval.
MAX_LTX_AGE_SECONDS="${LITESTREAM_REPLICA_MAX_AGE_SECONDS:-10800}"
INTERVAL_SECONDS="${LITESTREAM_REPLICA_HEARTBEAT_INTERVAL_SECONDS:-600}"
ONCE=false
CONTINUOUS_LEVELS=(0 1 2 3)
SNAPSHOT_LEVEL=9

log() {
  printf '[replica-status-heartbeat] %s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --self-test)
      REPLICA_PROBE_SELF_TEST=1
      shift
      ;;
    *)
      log "ERROR: unknown arg: $1"
      exit 2
      ;;
  esac
done

# Normalize unified AWS_* names (same as start-with-litestream.sh).
: "${LITESTREAM_S3_BUCKET:=${AWS_S3_BUCKET_NAME:-}}"
: "${LITESTREAM_S3_ENDPOINT:=${AWS_S3_ENDPOINT:-}}"
: "${LITESTREAM_S3_REGION:=${AWS_REGION:-auto}}"
: "${LITESTREAM_S3_ACCESS_KEY_ID:=${AWS_ACCESS_KEY_ID:-}}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY:=${AWS_SECRET_ACCESS_KEY:-}}"
export LITESTREAM_S3_BUCKET LITESTREAM_S3_ENDPOINT LITESTREAM_S3_REGION \
  LITESTREAM_S3_ACCESS_KEY_ID LITESTREAM_S3_SECRET_ACCESS_KEY

write_status() {
  local ok="$1" ltx_age="$2" reason="$3"
  local checked_at temporary dir
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dir="$(dirname "${STATUS_FILE}")"
  mkdir -p "${dir}"
  temporary="$(mktemp "${STATUS_FILE}.XXXXXX")"
  if command -v jq >/dev/null 2>&1; then
    jq -nc \
      --argjson ok "${ok}" \
      --argjson ltxAgeSeconds "${ltx_age}" \
      --arg reason "${reason}" \
      --arg checkedAt "${checked_at}" \
      '{ok: $ok, checkedAt: $checkedAt, ltxAgeSeconds: $ltxAgeSeconds,
        reason: (if $reason == "" then null else $reason end)}' \
      >"${temporary}"
  else
    # Minimal JSON without jq (Alpine/node image may lack it).
    local reason_json=null
    if [[ -n "${reason}" ]]; then
      reason_json="\"${reason//\"/\\\"}\""
    fi
    printf '{"ok":%s,"checkedAt":"%s","ltxAgeSeconds":%s,"reason":%s}\n' \
      "${ok}" "${checked_at}" "${ltx_age}" "${reason_json}" >"${temporary}"
  fi
  chmod 0644 "${temporary}"
  mv -f "${temporary}" "${STATUS_FILE}"
}

classify_list_failure() {
  local rc="$1"
  local stderr="$2"
  if (( rc == 124 )); then
    printf '%s\n' "list_timeout"
    return 0
  fi
  if grep -qiE 'TLS handshake timeout|i/o timeout|connection timed out|context deadline exceeded|Client\.Timeout exceeded while awaiting headers' <<<"${stderr}"; then
    printf '%s\n' "list_timeout"
    return 0
  fi
  if grep -qiE 'ListObjectsV2|failed to list|list ltx' <<<"${stderr}" \
    && grep -qiE 'timeout|timed out|deadline exceeded' <<<"${stderr}"; then
    printf '%s\n' "list_timeout"
    return 0
  fi
  printf '%s\n' "list_error"
}

newest_timestamp_from_json() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[] | select(.timestamp != null) | .timestamp' <<<"${json}" 2>/dev/null \
      | sort | tail -n 1
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      try {
        const data = JSON.parse(process.argv[1] || "[]");
        if (Array.isArray(data)) {
          const stamps = data.map(d => d.timestamp).filter(Boolean).sort();
          if (stamps.length > 0) process.stdout.write(stamps[stamps.length - 1] + "\n");
        }
      } catch (e) {}
    ' "${json}" 2>/dev/null
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import sys, json
try:
    data = json.loads(sys.argv[1] or "[]")
    if isinstance(data, list):
        stamps = sorted([d["timestamp"] for d in data if isinstance(d, dict) and d.get("timestamp")])
        if stamps:
            print(stamps[-1])
except Exception:
    pass
' "${json}" 2>/dev/null
    return 0
  fi
  grep -o '"timestamp"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"${json}" 2>/dev/null \
    | sed 's/.*"timestamp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' \
    | sort | tail -n 1
}

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${seconds}" "$@"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import subprocess, sys
try:
    sec = float(sys.argv[1])
    res = subprocess.run(sys.argv[2:], timeout=sec)
    sys.exit(res.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
except Exception as e:
    sys.exit(1)
' "${seconds}" "$@"
  else
    "$@"
  fi
}

list_ltx_level_json() {
  local level="$1"
  local stderr_file stdout_file rc=0
  stderr_file="$(mktemp)"
  stdout_file="$(mktemp)"
  run_with_timeout 60 "${LITESTREAM_BIN}" ltx \
    -config "${LITESTREAM_CONFIG}" \
    -json \
    -level "${level}" \
    "${DB_PATH}" >"${stdout_file}" 2>"${stderr_file}" || rc=$?
  LIST_LTX_STDOUT="$(<"${stdout_file}")"
  LIST_LTX_STDERR="$(<"${stderr_file}")"
  LIST_LTX_RC="${rc}"
  rm -f "${stderr_file}" "${stdout_file}"
}

timestamp_to_epoch() {
  local ts="$1"
  local epoch=""
  epoch="$(date -u -d "${ts}" +%s 2>/dev/null || true)"
  if [[ -n "${epoch}" ]]; then
    printf '%s\n' "${epoch}"
    return 0
  fi
  epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${ts}" +%s 2>/dev/null || true)"
  if [[ -n "${epoch}" ]]; then
    printf '%s\n' "${epoch}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    epoch="$(node -e 'const d = new Date(process.argv[1]); if (!isNaN(d)) console.log(Math.floor(d.getTime()/1000));' "${ts}" 2>/dev/null || true)"
    if [[ -n "${epoch}" ]]; then
      printf '%s\n' "${epoch}"
      return 0
    fi
  fi
  if command -v python3 >/dev/null 2>&1; then
    epoch="$(python3 -c '
import datetime, sys
try:
    dt = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
    print(int(dt.timestamp()))
except Exception:
    pass
' "${ts}" 2>/dev/null || true)"
    if [[ -n "${epoch}" ]]; then
      printf '%s\n' "${epoch}"
      return 0
    fi
  fi
  return 1
}

evaluate_ltx_probe() {
  EVAL_OK=false
  EVAL_AGE_SECONDS=""
  EVAL_REASON=""
  local continuous_newest="" snapshot_newest=""
  local saw_empty_success=false
  local saw_list_timeout=false
  local saw_list_error=false
  local level listing newest stripped

  for level in "${CONTINUOUS_LEVELS[@]}"; do
    list_ltx_level_json "${level}"
    if (( LIST_LTX_RC == 0 )); then
      stripped="${LIST_LTX_STDOUT//[[:space:]]/}"
      if [[ "${stripped}" == "[]" || -z "${stripped}" ]]; then
        saw_empty_success=true
        continue
      fi
      if newest="$(newest_timestamp_from_json "${LIST_LTX_STDOUT}")" && [[ -n "${newest}" ]]; then
        if [[ -z "${continuous_newest}" || "${newest}" > "${continuous_newest}" ]]; then
          continuous_newest="${newest}"
        fi
        continue
      fi
      saw_list_error=true
    else
      case "$(classify_list_failure "${LIST_LTX_RC}" "${LIST_LTX_STDERR}")" in
        list_timeout) saw_list_timeout=true ;;
        *) saw_list_error=true ;;
      esac
    fi
  done

  list_ltx_level_json "${SNAPSHOT_LEVEL}"
  if (( LIST_LTX_RC == 0 )); then
    stripped="${LIST_LTX_STDOUT//[[:space:]]/}"
    if [[ "${stripped}" == "[]" || -z "${stripped}" ]]; then
      saw_empty_success=true
    elif newest="$(newest_timestamp_from_json "${LIST_LTX_STDOUT}")" && [[ -n "${newest}" ]]; then
      snapshot_newest="${newest}"
    else
      saw_list_error=true
    fi
  else
    case "$(classify_list_failure "${LIST_LTX_RC}" "${LIST_LTX_STDERR}")" in
      list_timeout) saw_list_timeout=true ;;
      *) saw_list_error=true ;;
    esac
  fi

  local chosen_ts="" probe_reason=""
  if [[ -n "${continuous_newest}" ]]; then
    chosen_ts="${continuous_newest}"
  elif [[ -n "${snapshot_newest}" ]]; then
    chosen_ts="${snapshot_newest}"
    probe_reason="snapshot_only"
  elif [[ "${saw_empty_success}" == "true" && "${saw_list_timeout}" != "true" && "${saw_list_error}" != "true" ]]; then
    EVAL_REASON="empty_ltx"
    return 1
  elif [[ "${saw_list_timeout}" == "true" ]]; then
    EVAL_REASON="list_timeout"
    return 1
  elif [[ "${saw_list_error}" == "true" ]]; then
    EVAL_REASON="list_error"
    return 1
  else
    EVAL_REASON="no_parseable_ltx"
    return 1
  fi

  local latest_epoch now_epoch age_seconds
  if ! latest_epoch="$(timestamp_to_epoch "${chosen_ts}")"; then
    EVAL_REASON="invalid_ltx_timestamp"
    return 1
  fi

  now_epoch="$(date -u +%s)"
  age_seconds=$((now_epoch - latest_epoch))
  EVAL_AGE_SECONDS="${age_seconds}"
  EVAL_REASON="${probe_reason}"
  if (( age_seconds < 0 || age_seconds > MAX_LTX_AGE_SECONDS )); then
    EVAL_OK=false
    EVAL_REASON="ltx_age_exceeds_budget"
    return 0
  fi

  EVAL_OK=true
  return 0
}

probe_once() {
  # R2-only kill: when endpoint is R2 and kill is engaged, report intentional pause.
  local endpoint_lc
  endpoint_lc="$(printf '%s' "${LITESTREAM_S3_ENDPOINT:-}" | tr '[:upper:]' '[:lower:]')"
  local is_r2=false
  if [[ "${endpoint_lc}" == *"r2.cloudflarestorage.com"* || "${endpoint_lc}" == *".r2.cloudflare.com"* ]]; then
    is_r2=true
  fi
  if [[ "${is_r2}" == "true" ]] && {
    [[ "${LITESTREAM_EMERGENCY_DISABLE:-false}" == "true" ]] \
      || [[ "${R2_WRITES_DISABLED:-false}" == "true" ]] \
      || [[ -f /data/r2-disabled-70pct.flag ]]
  }; then
    write_status false null "r2_free_tier_disabled"
    log "R2 free-tier kill engaged; reporting intentional replica pause."
    return 0
  fi

  if [[ ! -x "${LITESTREAM_BIN}" ]]; then
    write_status false null "litestream_binary_missing"
    log "ERROR: litestream binary missing at ${LITESTREAM_BIN}"
    return 1
  fi

  if [[ -z "${LITESTREAM_S3_BUCKET:-}" || -z "${LITESTREAM_S3_ENDPOINT:-}" \
    || -z "${LITESTREAM_S3_ACCESS_KEY_ID:-}" || -z "${LITESTREAM_S3_SECRET_ACCESS_KEY:-}" ]]; then
    write_status false null "replica_credentials_missing"
    log "ERROR: LITESTREAM_S3_* incomplete; cannot list LTX."
    return 1
  fi

  if evaluate_ltx_probe; then
    if [[ "${EVAL_OK}" == "true" ]]; then
      write_status true "${EVAL_AGE_SECONDS}" "${EVAL_REASON}"
      log "replica healthy: newest LTX is ${EVAL_AGE_SECONDS}s old (${EVAL_REASON:-continuous})."
      return 0
    fi
    write_status false "${EVAL_AGE_SECONDS}" "${EVAL_REASON}"
    log "newest LTX is ${EVAL_AGE_SECONDS}s old (limit ${MAX_LTX_AGE_SECONDS}s)."
    return 0
  fi

  write_status false null "${EVAL_REASON}"
  log "ERROR: replica probe failed (${EVAL_REASON})."
  return 1
}

run_self_tests() {
  if ! command -v jq >/dev/null 2>&1; then
    log "self-test skipped: jq required"
    return 0
  fi

  local tmpdir mock_bin prior_bin prior_status prior_max
  tmpdir="$(mktemp -d)"
  mock_bin="${tmpdir}/litestream"
  prior_bin="${LITESTREAM_BIN}"
  prior_status="${STATUS_FILE}"
  prior_max="${MAX_LTX_AGE_SECONDS}"
  LITESTREAM_BIN="${mock_bin}"
  STATUS_FILE="${tmpdir}/status.json"
  MAX_LTX_AGE_SECONDS=999999999

  cat >"${mock_bin}" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
level=""
json=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -json) json=true; shift ;;
    -level) level="$2"; shift 2 ;;
    -config|-*) shift; shift ;;
    *) shift ;;
  esac
done
case "${level}" in
  0)
    if [[ "${MOCK_SCENARIO:-}" == "timeout" ]]; then
      echo "ListObjectsV2: TLS handshake timeout" >&2
      exit 1
    fi
    echo '[]'
    ;;
  1|2|3) echo '[]' ;;
  9)
    if [[ "${MOCK_SCENARIO:-}" == "snapshot" ]]; then
      echo '[{"level":9,"min_txid":"1","max_txid":"1","size":100,"timestamp":"2025-01-21T12:00:00Z"}]'
    else
      echo '[]'
    fi
    ;;
  *) echo '[]' ;;
esac
MOCK
  chmod +x "${mock_bin}"

  local rc=0

  MOCK_SCENARIO=snapshot
  export MOCK_SCENARIO
  if evaluate_ltx_probe && [[ "${EVAL_REASON}" == "snapshot_only" && "${EVAL_OK}" == "true" ]]; then
    log "self-test ok: snapshot_only"
  else
    log "self-test FAIL: expected snapshot_only ok=true got reason=${EVAL_REASON} ok=${EVAL_OK}"
    rc=1
  fi

  MOCK_SCENARIO=timeout
  export MOCK_SCENARIO
  if ! evaluate_ltx_probe; then
    [[ "${EVAL_REASON}" == "list_timeout" ]] || {
      log "self-test FAIL: expected list_timeout got ${EVAL_REASON}"
      rc=1
    }
  else
    log "self-test FAIL: expected list_timeout failure"
    rc=1
  fi

  MOCK_SCENARIO=empty
  export MOCK_SCENARIO
  if ! evaluate_ltx_probe; then
    [[ "${EVAL_REASON}" == "empty_ltx" ]] || {
      log "self-test FAIL: expected empty_ltx got ${EVAL_REASON}"
      rc=1
    }
  else
    log "self-test FAIL: expected empty_ltx failure"
    rc=1
  fi

  LITESTREAM_BIN="${prior_bin}"
  STATUS_FILE="${prior_status}"
  MAX_LTX_AGE_SECONDS="${prior_max}"
  rm -rf "${tmpdir}"
  return "${rc}"
}

if [[ "${REPLICA_PROBE_SELF_TEST:-}" == "1" ]]; then
  run_self_tests
  exit $?
fi

if [[ "${ONCE}" == "true" ]]; then
  probe_once
  exit $?
fi

log "looping every ${INTERVAL_SECONDS}s → ${STATUS_FILE}"
while true; do
  probe_once || true
  sleep "${INTERVAL_SECONDS}"
done
