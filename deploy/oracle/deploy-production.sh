#!/usr/bin/env bash
# Exact-SHA, single-writer Oracle production deployment transaction.
# Install this file root-owned as /usr/local/sbin/usage-monitor-deploy. The
# installed copy is deliberately outside the fetched repository: a newly
# merged revision may supply app code and a Dockerfile, but never the root-level
# compose policy or deployment transaction that constrains it.
set -Eeuo pipefail
umask 027
export LC_ALL=C

readonly REPOSITORY="jaywedgeworth22/Usage-Monitor"
readonly REPOSITORY_URL="https://github.com/${REPOSITORY}.git"
readonly GITHUB_API="https://api.github.com/repos/${REPOSITORY}"
readonly GITHUB_ACTIONS_APP_ID="15368"
readonly STATE_DIR="/var/lib/usage-monitor-deploy"
readonly MIRROR_DIR="${STATE_DIR}/repository.git"
readonly RELEASES_DIR="${STATE_DIR}/releases"
readonly RECEIPT_FILE="${STATE_DIR}/current.json"
readonly LOCK_FILE="/run/lock/usage-monitor-deploy.lock"
readonly HOST_ENV="/etc/usage-monitor/host.env"
readonly RUNTIME_ENV="/etc/usage-monitor/usage-monitor.env"
readonly COMPOSE_FILE="/etc/usage-monitor/compose.yaml"
readonly RENDER_RETIREMENT_PROOF="/etc/usage-monitor/render-retired.json"
readonly RENDER_CURL_CONFIG="/etc/usage-monitor/render-api.curl.conf"
readonly DATA_DIR="/data"
readonly DB_PATH="${DATA_DIR}/prod.db"
readonly DEPLOY_BACKUP_DIR="${DATA_DIR}/.deploy-backups"
readonly SCRATCH_ROOT="${DATA_DIR}/.deploy-scratch"
readonly EXPECTED_DATA_UUID="31ccf4c4-43bd-441c-8a4a-9d7f6b40d023"
readonly EXPECTED_DATA_DEVICE="/dev/sdb"
readonly PUBLIC_HOST="usage.jays.services"
readonly PUBLIC_READY_URL="https://${PUBLIC_HOST}/api/ready?strict=1"
readonly LEGACY_HEALTH_URL="https://api-usage-monitor.onrender.com/api/health"
readonly APP_CONTAINER="oracle-app-1"
readonly APP_NETWORK="oracle_internal"
readonly APP_IMAGE_REPOSITORY="usage-monitor"
readonly COMPOSE_TIMEOUT_SECONDS=300
readonly MIN_ROOT_FREE_BYTES=$((8 * 1024 * 1024 * 1024))
readonly MIN_DATA_FREE_BYTES=$((5 * 1024 * 1024 * 1024))
readonly MAX_BACKUPS=5

TARGET_SHA="${1:-}"
PREVIOUS_SHA=""
CUTOVER_STARTED=false
DEPLOY_SUCCEEDED=false
SCRATCH_DIR=""
RESTORE_SCRATCH=""
FINAL_BACKUP=""
CANDIDATE_STARTED_AT=""
RELEASE_DIR=""
LAST_BACKUP_MAX_TXID=""
LAST_BACKUP_CREATED=""
PRE_CUTOVER_BACKUP_MAX_TXID=""

log() {
  printf '[usage-monitor-deploy] %s\n' "$*"
}

die() {
  log "ERROR: $*"
  return 1
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

require_secure_root_file() {
  local path="$1"
  local expected_mode="$2"
  local owner mode
  [[ -f "${path}" && ! -L "${path}" ]] || die "required regular file missing: ${path}"
  owner="$(stat -c '%U:%G' "${path}")"
  mode="$(stat -c '%a' "${path}")"
  [[ "${owner}" == "root:root" ]] || die "${path} must be owned by root:root (got ${owner})"
  [[ "${mode}" == "${expected_mode}" ]] || die "${path} must have mode ${expected_mode} (got ${mode})"
}

free_bytes() {
  local path="$1"
  local available block_size
  read -r available block_size < <(stat -f -c '%a %S' "${path}")
  printf '%s\n' "$((available * block_size))"
}

compose_for_revision() {
  local revision="$1"
  shift
  timeout --signal=TERM --kill-after=30s "${COMPOSE_TIMEOUT_SECONDS}" \
    env USAGE_MONITOR_REVISION="${revision}" \
      docker compose \
      --project-name oracle \
      --env-file "${HOST_ENV}" \
      --file "${COMPOSE_FILE}" \
      "$@"
}

fetch_public_ready() {
  curl -fsS --max-time 15 "${PUBLIC_READY_URL}"
}

fetch_local_ready() {
  curl -fsS --max-time 5 \
    --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
    "${PUBLIC_READY_URL}"
}

ready_matches_revision() {
  local body="$1"
  local revision="$2"
  jq -e --arg revision "${revision}" '
    .status == "ready" and
    .revision == $revision and
    .checks.database.ok == true and
    .checks.backup.ok == true and
    .checks.backup.required == true and
    .checks.backup.active == true and
    .checks.startup.active == true and
    .checks.scheduler.ok == true and
    .checks.scheduler.required == true
  ' >/dev/null <<<"${body}"
}

ready_has_fresh_scheduler_tick() {
  local body="$1"
  local revision="$2"
  local started_after="$3"
  ready_matches_revision "${body}" "${revision}" && \
    jq -e --arg started_after "${started_after}" '
      .checks.scheduler.startedAt >= $started_after and
      .checks.scheduler.lastTickSucceeded == true and
      .checks.scheduler.lastTickCompletedAt != null and
      .checks.scheduler.lastTickCompletedAt >= .checks.scheduler.startedAt
    ' >/dev/null <<<"${body}"
}

wait_for_revision() {
  local revision="$1"
  local started_after="$2"
  local label="$3"
  local body
  # Local TLS should answer promptly. Sixty attempts bounded to five seconds
  # plus five-second spacing keep the true worst case within ten minutes.
  for _ in {1..60}; do
    if body="$(fetch_local_ready 2>/dev/null)" && \
      ready_has_fresh_scheduler_tick "${body}" "${revision}" "${started_after}"; then
      log "${label} reached exact readiness with a fresh scheduler tick."
      return 0
    fi
    sleep 5
  done
  die "${label} did not reach exact readiness within 10 minutes"
}

verify_public_revision_samples() {
  local revision="$1"
  local body sample
  for sample in 1 2 3; do
    if ! body="$(fetch_public_ready)"; then
      die "public readiness sample ${sample} was unavailable"
      return 1
    fi
    if ! ready_matches_revision "${body}" "${revision}"; then
      die "public readiness sample ${sample} did not report ${revision}"
      return 1
    fi
    if (( sample < 3 )); then sleep 5; fi
  done
  log "three public readiness samples report ${revision}."
}

github_get() {
  local url="$1"
  curl -fsS --max-time 20 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${url}"
}

require_github_eligibility() {
  local revision="$1"
  local commit_json pulls_json checks_json check_name check_state

  # Check status is the only GitHub API call repeated while CI is pending.
  # Commit and PR provenance are fetched only after all exact-SHA checks pass,
  # keeping the unauthenticated public API well below its hourly rate limit.
  if ! checks_json="$(github_get "${GITHUB_API}/commits/${revision}/check-runs?per_page=100")"; then
    log "GitHub exact-SHA checks are temporarily unavailable."
    return 75
  fi
  for check_name in verify gitleaks 'Analyze JavaScript and TypeScript'; do
    check_state="$(jq -r \
      --arg name "${check_name}" \
      --argjson app_id "${GITHUB_ACTIONS_APP_ID}" '
        [.check_runs[] | select(.name == $name and .app.id == $app_id)] |
        if length == 0 then "missing"
        else (max_by(.id) | "\(.status)|\(.conclusion // "")")
        end
      ' <<<"${checks_json}")"
    case "${check_state}" in
      completed\|success) ;;
      missing|queued\|*|in_progress\|*|requested\|*|waiting\|*|pending\|*)
        log "required check ${check_name} is not complete (${check_state})."
        return 75
        ;;
      *)
        log "required check ${check_name} is terminal but not successful (${check_state}); a rerun may supersede it."
        return 77
        ;;
    esac
  done

  if ! commit_json="$(github_get "${GITHUB_API}/commits/${revision}")"; then
    log "GitHub commit verification is temporarily unavailable."
    return 75
  fi
  if [[ "$(jq -r '.commit.verification.verified // false' <<<"${commit_json}")" != "true" ]]; then
    log "revision ${revision} does not have a valid GitHub commit verification."
    return 78
  fi

  if ! pulls_json="$(github_get "${GITHUB_API}/commits/${revision}/pulls")"; then
    log "GitHub merged-PR verification is temporarily unavailable."
    return 75
  fi
  if ! jq -e --arg revision "${revision}" '
    any(.[]; .merged_at != null and .base.ref == "main" and .merge_commit_sha == $revision)
  ' >/dev/null <<<"${pulls_json}"; then
    log "revision ${revision} is not the result of a merged PR into main."
    return 78
  fi

  log "GitHub verified a merged PR and all required exact-SHA checks for ${revision}."
}

remote_main_sha() {
  timeout --signal=TERM --kill-after=15s 60 \
    git ls-remote "${REPOSITORY_URL}" refs/heads/main | cut -f1
}

require_current_main() {
  local expected="$1"
  local actual
  actual="$(remote_main_sha)"
  [[ "${actual}" =~ ^[0-9a-f]{40}$ ]] || die "could not resolve origin main"
  if [[ "${actual}" != "${expected}" ]]; then
    log "revision ${expected} was superseded by ${actual}; no production mutation required."
    exit 0
  fi
}

require_single_app_container() {
  local count
  count="$(timeout 30 docker ps \
    --filter 'label=com.docker.compose.project=oracle' \
    --filter 'label=com.docker.compose.service=app' \
    --format '{{.ID}}' | awk 'NF { count += 1 } END { print count + 0 }')"
  [[ "${count}" == "1" ]] || die "expected exactly one running Oracle app container, found ${count}"
}

verify_backup_path() {
  local latest_epoch now_epoch age_seconds dry_run_path
  dry_run_path="${DATA_DIR}/.deploy-garage-dry-run.db"
  unlink "${dry_run_path}" 2>/dev/null || true

  # Freshness + max TXID prefer level-0 tip listing. Full `-level all` lists
  # thousands of compacted objects over the S3 link and has timed out the
  # deploy gate (false "no parseable LTX") under Coolify load even when Garage
  # was healthy. When L0 is empty after compaction/quiet periods, fall back
  # through higher levels without ever listing all compacted history.
  if ! read_backup_state; then
    die "Garage returned no parseable LTX objects at levels 0-5 (list timeout, empty tip, or parse failure)"
    return 1
  fi
  if ! latest_epoch="$(date -u -d "${LAST_BACKUP_CREATED}" +%s)"; then
    die "Garage returned an invalid LTX timestamp"
    return 1
  fi
  now_epoch="$(date -u +%s)"
  age_seconds=$((now_epoch - latest_epoch))
  if (( age_seconds < 0 || age_seconds > 3600 )); then
    die "Garage newest LTX object is ${age_seconds}s old (limit 3600s)"
    return 1
  fi

  if ! timeout 180 docker exec "${APP_CONTAINER}" \
      /app/bin/litestream restore \
        -config /app/litestream.yml \
        -dry-run \
        -o "${dry_run_path}" \
        /data/prod.db >/dev/null; then
    die "Garage authenticated restore dry-run failed"
    return 1
  fi
  if [[ -e "${dry_run_path}" ]]; then
    die "Litestream dry-run unexpectedly wrote ${dry_run_path}"
    return 1
  fi
  log "Garage LTX freshness and authenticated restore dry-run passed."
}

# Prefer L0 tip (fast, small). Fall back L1..L5 when L0 is pruned during quiet
# periods (Litestream's default L0 retention is brief; scheduler ticks every
# 15m). Never use `-level all` — that listing timed out under Coolify load and
# falsely blocked deploys. Authenticity remains covered by restore dry-run.
list_garage_ltx_level() {
  local level="$1"
  timeout 60 docker exec "${APP_CONTAINER}" \
    /app/bin/litestream ltx -config /app/litestream.yml -level "${level}" /data/prod.db
}

list_garage_ltx_level_offline() {
  local revision="$1"
  local level="$2"
  local image="${APP_IMAGE_REPOSITORY}:${revision}"
  timeout --signal=TERM --kill-after=15s 90 \
    docker run --rm --pull=never --read-only \
      --network "${APP_NETWORK}" \
      --env-file "${RUNTIME_ENV}" \
      --user 1000:1000 \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      -e DATABASE_URL=file:/data/prod.db \
      -v "${DATA_DIR}:/data:ro" \
      --entrypoint /app/bin/litestream \
      "${image}" \
      ltx -config /app/litestream.yml -level "${level}" /data/prod.db
}

read_backup_state_from_levels() {
  local list_fn="$1"
  shift
  local listing level
  for level in 0 1 2 3 4 5; do
    if listing="$("${list_fn}" "$@" "${level}")" && \
      set_backup_state_from_listing "${listing}"; then
      return 0
    fi
  done
  return 1
}

read_backup_state() {
  read_backup_state_from_levels list_garage_ltx_level
}

read_backup_state_offline() {
  local revision="$1"
  read_backup_state_from_levels list_garage_ltx_level_offline "${revision}"
}

set_backup_state_from_listing() {
  local listing="$1"
  local max_txid latest_created
  max_txid="$(awk 'NF == 5 && $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9A-Fa-f]{16}$/ { print tolower($3) }' \
    <<<"${listing}" | sort | tail -n 1)"
  latest_created="$(awk 'NF == 5 && $1 ~ /^[0-9]+$/ { print $5 }' \
    <<<"${listing}" | sort | tail -n 1)"
  [[ "${max_txid}" =~ ^[0-9a-f]{16}$ && -n "${latest_created}" ]] || return 1
  LAST_BACKUP_MAX_TXID="${max_txid}"
  LAST_BACKUP_CREATED="${latest_created}"
}

wait_for_backup_advancement() {
  local prior_txid="$1"
  for _ in {1..60}; do
    if read_backup_state && [[ "${LAST_BACKUP_MAX_TXID}" > "${prior_txid}" ]]; then
      log "Garage advanced from TXID ${prior_txid} to ${LAST_BACKUP_MAX_TXID} after candidate start."
      return 0
    fi
    sleep 5
  done
  die "Garage did not advance beyond pre-cutover TXID ${prior_txid} within 5 minutes"
}

capture_quiescent_backup_watermark() {
  local revision="$1"
  local previous_observation=""
  for _ in {1..12}; do
    read_backup_state_offline "${revision}" || return 1
    if [[ -n "${previous_observation}" && "${LAST_BACKUP_MAX_TXID}" == "${previous_observation}" ]]; then
      PRE_CUTOVER_BACKUP_MAX_TXID="${LAST_BACKUP_MAX_TXID}"
      log "captured quiescent post-stop Garage TXID ${PRE_CUTOVER_BACKUP_MAX_TXID}."
      return 0
    fi
    previous_observation="${LAST_BACKUP_MAX_TXID}"
    sleep 5
  done
  die "Garage did not reach a stable post-stop watermark within one minute"
}

cleanup_restore_scratch() {
  if [[ -n "${RESTORE_SCRATCH}" ]]; then
    unlink "${RESTORE_SCRATCH}" 2>/dev/null || true
    unlink "${RESTORE_SCRATCH}-wal" 2>/dev/null || true
    unlink "${RESTORE_SCRATCH}-shm" 2>/dev/null || true
    RESTORE_SCRATCH=""
  fi
}

verify_backup_restore() {
  local live_schema restored_schema
  RESTORE_SCRATCH="${DATA_DIR}/.deploy-garage-acceptance-${TARGET_SHA}.$$.db"
  cleanup_restore_scratch
  RESTORE_SCRATCH="${DATA_DIR}/.deploy-garage-acceptance-${TARGET_SHA}.$$.db"

  timeout 600 docker exec "${APP_CONTAINER}" \
    /app/bin/litestream restore \
      -config /app/litestream.yml \
      -integrity-check full \
      -o "${RESTORE_SCRATCH}" \
      /data/prod.db >/dev/null
  [[ -s "${RESTORE_SCRATCH}" ]] || die "Garage acceptance restore did not create a database"
  [[ "$(sqlite3 -readonly "${RESTORE_SCRATCH}" 'PRAGMA integrity_check;')" == "ok" ]] || \
    die "Garage acceptance restore failed SQLite integrity"
  [[ -z "$(sqlite3 -readonly "${RESTORE_SCRATCH}" 'PRAGMA foreign_key_check;')" ]] || \
    die "Garage acceptance restore failed SQLite foreign-key validation"

  live_schema="$(sqlite3 -readonly "${DB_PATH}" \
    "SELECT coalesce(group_concat(sql, char(10)), '') FROM (SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name != '_deploy_heartbeat' ORDER BY type, name);")"
  restored_schema="$(sqlite3 -readonly "${RESTORE_SCRATCH}" \
    "SELECT coalesce(group_concat(sql, char(10)), '') FROM (SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name != '_deploy_heartbeat' ORDER BY type, name);")"
  [[ "${restored_schema}" == "${live_schema}" ]] || die "Garage acceptance restore schema differs from live SQLite"
  cleanup_restore_scratch
  log "Garage post-cutover restore, full integrity, foreign keys, and schema comparison passed."
}

verify_render_retirement() {
  local legacy_status service_json env_json
  jq -e '
    .serviceId == "srv-d9181tpo3t8c73crf310" and
    .hostname == "api-usage-monitor.onrender.com" and
    .state == "suspended" and
    (.suspenders | index("user")) != null and
    .autoDeploy == "off" and
    .schedulerEnabled == false and
    .writerAuthority == "oracle"
  ' "${RENDER_RETIREMENT_PROOF}" >/dev/null || die "Render retirement proof is invalid"

  if ! service_json="$(curl -fsS --max-time 20 \
    --config "${RENDER_CURL_CONFIG}" \
    --url 'https://api.render.com/v1/services/srv-d9181tpo3t8c73crf310')"; then
    log "Render service status is temporarily unavailable; deferring deployment."
    return 75
  fi
  jq -e '
    .id == "srv-d9181tpo3t8c73crf310" and
    .suspended == "suspended" and
    (.suspenders | index("user")) != null and
    .autoDeploy == "no" and
    .autoDeployTrigger == "off" and
    .serviceDetails.url == "https://api-usage-monitor.onrender.com"
  ' >/dev/null <<<"${service_json}" || die "live Render service is not safely suspended with auto-deploy disabled"

  if ! env_json="$(curl -fsS --max-time 20 \
    --config "${RENDER_CURL_CONFIG}" \
    --url 'https://api.render.com/v1/services/srv-d9181tpo3t8c73crf310/env-vars/USAGE_SCHEDULER_ENABLED')"; then
    log "Render scheduler configuration is temporarily unavailable; deferring deployment."
    return 75
  fi
  jq -e '
    .key == "USAGE_SCHEDULER_ENABLED" and .value == "false"
  ' >/dev/null <<<"${env_json}" || die "live Render USAGE_SCHEDULER_ENABLED is not exactly false"
  unset env_json

  legacy_status="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "${LEGACY_HEALTH_URL}" || printf '000')"
  case "${legacy_status}" in
    404|410|503) ;;
    *) die "legacy Render health returned ambiguous HTTP ${legacy_status}; refusing a possible second writer" ;;
  esac
}

preflight_current_production() {
  local ready scheduler backup_required backup_bucket running_image expected_image

  mountpoint -q "${DATA_DIR}" || die "${DATA_DIR} is not a mount point"
  [[ "$(findmnt -n -o SOURCE --target "${DATA_DIR}")" == "${EXPECTED_DATA_DEVICE}" ]] || \
    die "${DATA_DIR} is not mounted from ${EXPECTED_DATA_DEVICE}"
  [[ "$(findmnt -n -o UUID --target "${DATA_DIR}")" == "${EXPECTED_DATA_UUID}" ]] || \
    die "${DATA_DIR} filesystem UUID does not match the pinned production volume"
  findmnt -n -o OPTIONS --target "${DATA_DIR}" | tr ',' '\n' | grep -qx rw || \
    die "${DATA_DIR} is not mounted read-write"

  [[ -f "${DB_PATH}" && ! -L "${DB_PATH}" ]] || die "production database is missing or not a regular file"
  [[ "$(stat -c '%u:%g' "${DB_PATH}")" == "1000:1000" ]] || die "production database must be uid/gid 1000"
  [[ "$(stat -c '%a' "${DB_PATH}")" == "600" ]] || die "production database must have mode 0600"
  [[ "$(timeout 120 sqlite3 -readonly "${DB_PATH}" 'PRAGMA integrity_check;')" == "ok" ]] || die "production SQLite integrity check failed"
  [[ -z "$(timeout 120 sqlite3 -readonly "${DB_PATH}" 'PRAGMA foreign_key_check;')" ]] || die "production SQLite foreign-key check failed"

  (( $(free_bytes /) >= MIN_ROOT_FREE_BYTES )) || die "root/Docker volume has less than 8 GiB free"
  (( $(free_bytes "${DATA_DIR}") >= MIN_DATA_FREE_BYTES )) || die "data volume has less than 5 GiB free"

  scheduler="$(read_env_value "${RUNTIME_ENV}" USAGE_SCHEDULER_ENABLED)"
  backup_required="$(read_env_value "${RUNTIME_ENV}" LITESTREAM_REQUIRED)"
  backup_bucket="$(read_env_value "${RUNTIME_ENV}" LITESTREAM_S3_BUCKET)"
  [[ "${scheduler}" == "true" ]] || die "USAGE_SCHEDULER_ENABLED must be exactly true"
  [[ "${backup_required}" == "true" ]] || die "LITESTREAM_REQUIRED must be exactly true"
  [[ "${backup_bucket}" == "usage-monitor-prod-v3" ]] || die "production must use Garage bucket usage-monitor-prod-v3"

  require_single_app_container
  expected_image="$(timeout 30 docker image inspect --format '{{.Id}}' \
    "${APP_IMAGE_REPOSITORY}:${PREVIOUS_SHA}")"
  running_image="$(timeout 30 docker inspect --format '{{.Image}}' "${APP_CONTAINER}")"
  [[ "${running_image}" == "${expected_image}" ]] || \
    die "running app image does not match the accepted ${PREVIOUS_SHA} image"
  ready="$(fetch_public_ready)"
  ready_matches_revision "${ready}" "${PREVIOUS_SHA}" || die "current public production is not healthy at ${PREVIOUS_SHA}"

  verify_render_retirement
  verify_backup_path
}

ensure_mirror_and_release() {
  local revision="$1"
  local temporary_mirror
  install -d -o root -g root -m 0750 "${STATE_DIR}" "${RELEASES_DIR}"

  if [[ ! -d "${MIRROR_DIR}" ]]; then
    temporary_mirror="${STATE_DIR}/repository.git.partial.$$"
    timeout --signal=TERM --kill-after=30s 600 \
      git clone --bare --filter=blob:none "${REPOSITORY_URL}" "${temporary_mirror}"
    chown -R root:root "${temporary_mirror}"
    chmod -R go-w "${temporary_mirror}"
    mv "${temporary_mirror}" "${MIRROR_DIR}"
  fi
  [[ "$(stat -c '%U:%G' "${MIRROR_DIR}")" == "root:root" ]] || die "release mirror is not root-owned"

  timeout --signal=TERM --kill-after=30s 300 \
    git --git-dir="${MIRROR_DIR}" fetch --force --prune origin \
      'refs/heads/main:refs/remotes/origin/main'
  [[ "$(git --git-dir="${MIRROR_DIR}" rev-parse refs/remotes/origin/main)" == "${revision}" ]] || \
    die "root-owned mirror main does not equal ${revision}"
  git --git-dir="${MIRROR_DIR}" cat-file -e "${revision}^{commit}"

  RELEASE_DIR="${RELEASES_DIR}/${revision}"
  if [[ ! -d "${RELEASE_DIR}" ]]; then
    timeout --signal=TERM --kill-after=30s 180 \
      git --git-dir="${MIRROR_DIR}" worktree add --detach "${RELEASE_DIR}" "${revision}"
  fi
  [[ "$(git -C "${RELEASE_DIR}" rev-parse HEAD)" == "${revision}" ]] || die "release checkout does not equal ${revision}"
  [[ "$(stat -c '%U:%G' "${RELEASE_DIR}")" == "root:root" ]] || die "release checkout is not root-owned"
}

build_and_verify_image() {
  local revision="$1"
  local release_dir="$2"
  local image="${APP_IMAGE_REPOSITORY}:${revision}"
  local architecture label

  log "building ${image} from the root-owned exact release checkout."
  DOCKER_BUILDKIT=1 timeout --signal=TERM --kill-after=60s 2700 \
    nice -n 10 ionice -c2 -n7 docker build \
      --pull=false \
      --label "org.opencontainers.image.revision=${revision}" \
      --tag "${image}" \
      --file "${release_dir}/Dockerfile" \
      "${release_dir}"

  architecture="$(timeout 30 docker image inspect "${image}" --format '{{.Architecture}}')"
  label="$(timeout 30 docker image inspect "${image}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "${architecture}" == "arm64" ]] || die "candidate image architecture is ${architecture}, expected arm64"
  [[ "${label}" == "${revision}" ]] || die "candidate image revision label does not match ${revision}"

  timeout --signal=TERM --kill-after=30s 180 \
    docker run --rm --network none \
    -e STARTUP_PREFLIGHT_ONLY=true \
    -e LITESTREAM_REQUIRED=false \
    "${image}" >/dev/null
  timeout --signal=TERM --kill-after=15s 60 \
    docker run --rm --network none --entrypoint test "${image}" -x /app/bin/litestream

  compose_for_revision "${revision}" config --quiet
  log "candidate image architecture, revision label, startup preflight, and stable compose config passed."
}

create_sqlite_backup() {
  local destination="$1"
  local partial="${destination}.partial"
  local destination_dir="${destination%/*}"
  unlink "${partial}" 2>/dev/null || true
  timeout --signal=TERM --kill-after=30s 300 \
    sqlite3 -cmd '.timeout 30000' "${DB_PATH}" ".backup '${partial}'"
  [[ "$(sqlite3 -readonly "${partial}" 'PRAGMA integrity_check;')" == "ok" ]] || die "backup integrity check failed"
  [[ -z "$(sqlite3 -readonly "${partial}" 'PRAGMA foreign_key_check;')" ]] || die "backup foreign-key check failed"
  chown 1000:1000 "${partial}"
  chmod 0600 "${partial}"
  sync -f "${partial}"
  mv "${partial}" "${destination}"
  sync -f "${destination_dir}"
}

verify_target_migration_on_scratch() {
  local revision="$1"
  local image="${APP_IMAGE_REPOSITORY}:${revision}"
  local scratch_db
  SCRATCH_DIR="${SCRATCH_ROOT}/${revision}.$$"
  install -d -o 1000 -g 1000 -m 0700 "${SCRATCH_DIR}"
  scratch_db="${SCRATCH_DIR}/prod.db"
  create_sqlite_backup "${scratch_db}"

  timeout --signal=TERM --kill-after=30s 900 \
    docker run --rm --network none \
    --user 1000:1000 \
    -e DATABASE_URL=file:/preflight/prod.db \
    -v "${SCRATCH_DIR}:/preflight" \
    --entrypoint bash \
    "${image}" \
    -lc 'node scripts/audit-subscription-links.mjs && node scripts/ensure-subscription-link-unique-index.mjs && node scripts/migrate-safe.mjs'

  [[ "$(sqlite3 -readonly "${scratch_db}" 'PRAGMA integrity_check;')" == "ok" ]] || die "target scratch migration corrupted SQLite"
  [[ -z "$(sqlite3 -readonly "${scratch_db}" 'PRAGMA foreign_key_check;')" ]] || die "target scratch migration introduced foreign-key violations"
  log "target startup migration passed against a transaction-consistent scratch database."
}

cleanup_scratch() {
  cleanup_restore_scratch
  if [[ -n "${SCRATCH_DIR}" && -d "${SCRATCH_DIR}" ]]; then
    find "${SCRATCH_DIR}" -maxdepth 1 -type f -name 'prod.db*' -exec unlink -- {} \; 2>/dev/null || true
    rmdir "${SCRATCH_DIR}" 2>/dev/null || true
  fi
}

write_host_revision() {
  local revision="$1"
  local temporary
  temporary="$(mktemp /etc/usage-monitor/.host.env.XXXXXX)" || return 1
  if ! awk -F= -v revision="${revision}" '
    BEGIN { replaced = 0 }
    $1 == "USAGE_MONITOR_REVISION" {
      print "USAGE_MONITOR_REVISION=" revision
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print "USAGE_MONITOR_REVISION=" revision
    }
  ' "${HOST_ENV}" >"${temporary}"; then
    unlink "${temporary}" 2>/dev/null || true
    return 1
  fi
  if ! chown root:root "${temporary}" || \
    ! chmod 0600 "${temporary}" || \
    ! mv "${temporary}" "${HOST_ENV}"; then
    unlink "${temporary}" 2>/dev/null || true
    return 1
  fi
}

# Production Caddy receives USAGE_MONITOR_HOSTNAME from host.env. Old bootstrap
# copies still encode the deleted sslip.io IP hostname; refuse/migrate those
# before cutover so ACME cannot renew the wrong certificate. When the value
# changes, recreate the running Caddy container so it picks up the new env.
reload_caddy_proxy() {
  log "recreating Caddy so it loads the migrated USAGE_MONITOR_HOSTNAME."
  # Use PREVIOUS_SHA image/env path — Caddy does not depend on the app image.
  if ! timeout "${COMPOSE_TIMEOUT_SECONDS}" docker compose \
    --project-name oracle \
    --env-file "${HOST_ENV}" \
    --file "${COMPOSE_FILE}" \
    up --detach --no-deps --no-build --force-recreate caddy >/dev/null; then
    return 1
  fi
}

ensure_public_caddy_hostname() {
  local configured rewritten temporary migrated=false
  configured="$(read_env_value "${HOST_ENV}" USAGE_MONITOR_HOSTNAME)"
  if [[ -z "${configured}" ]]; then
    log "USAGE_MONITOR_HOSTNAME unset; writing ${PUBLIC_HOST}."
    temporary="$(mktemp /etc/usage-monitor/.host.env.XXXXXX)" || return 1
    {
      printf 'USAGE_MONITOR_HOSTNAME=%s\n' "${PUBLIC_HOST}"
      awk -F= '$1 != "USAGE_MONITOR_HOSTNAME" { print }' "${HOST_ENV}"
    } >"${temporary}" || {
      unlink "${temporary}" 2>/dev/null || true
      return 1
    }
    chown root:root "${temporary}" && chmod 0600 "${temporary}" && mv "${temporary}" "${HOST_ENV}"
    migrated=true
  elif [[ "${configured}" == *sslip.io* || "${configured}" == *132.226.90.164* ]]; then
    # Preserve any additional public SANs after the first host, but drop the
    # deleted IP-derived sslip label. Always ensure usage.jays.services leads.
    # Host lists may be comma- and/or space-separated (historical host.env
    # formats used both). Normalize either delimiter before filtering.
    rewritten="$(
      printf '%s\n' "${configured}" \
        | tr ', ' '\n\n' \
        | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
        | awk -v public="${PUBLIC_HOST}" '
            BEGIN { print public }
            $0 != "" && $0 != public && index($0, "sslip.io") == 0 && index($0, "132.226.90.164") == 0 { print }
          ' \
        | paste -sd ', ' -
    )"
    # Caddy site addresses require ", " (comma+space), not bare commas.

    log "migrating stale USAGE_MONITOR_HOSTNAME away from deleted IP sslip labels."
    temporary="$(mktemp /etc/usage-monitor/.host.env.XXXXXX)" || return 1
    if ! awk -F= -v host="${rewritten}" '
      BEGIN { replaced = 0 }
      $1 == "USAGE_MONITOR_HOSTNAME" {
        print "USAGE_MONITOR_HOSTNAME=" host
        replaced = 1
        next
      }
      { print }
      END {
        if (!replaced) print "USAGE_MONITOR_HOSTNAME=" host
      }
    ' "${HOST_ENV}" >"${temporary}"; then
      unlink "${temporary}" 2>/dev/null || true
      return 1
    fi
    if ! chown root:root "${temporary}" || \
      ! chmod 0600 "${temporary}" || \
      ! mv "${temporary}" "${HOST_ENV}"; then
      unlink "${temporary}" 2>/dev/null || true
      return 1
    fi
    migrated=true
  elif [[ "${configured}" != *"${PUBLIC_HOST}"* ]]; then
    die "USAGE_MONITOR_HOSTNAME must include ${PUBLIC_HOST} (got a non-public value)"
  fi
  if [[ "${migrated}" == "true" ]]; then
    reload_caddy_proxy || die "failed to recreate Caddy after hostname migration"
  fi
}

write_receipt() {
  local status="$1"
  local active_revision="$2"
  local previous_revision="$3"
  local backup_path="$4"
  local image_digest temporary
  image_digest="$(timeout 30 docker image inspect "${APP_IMAGE_REPOSITORY}:${active_revision}" --format '{{.Id}}')" || return 1
  temporary="$(mktemp "${STATE_DIR}/.receipt.XXXXXX")" || return 1
  if ! jq -n \
    --arg status "${status}" \
    --arg activeRevision "${active_revision}" \
    --arg previousRevision "${previous_revision}" \
    --arg imageDigest "${image_digest}" \
    --arg backupPath "${backup_path}" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{status:$status,activeRevision:$activeRevision,previousRevision:$previousRevision,imageDigest:$imageDigest,backupPath:$backupPath,completedAt:$completedAt}' \
    >"${temporary}"; then
    unlink "${temporary}" 2>/dev/null || true
    return 1
  fi
  if ! chmod 0600 "${temporary}" || ! mv "${temporary}" "${RECEIPT_FILE}"; then
    unlink "${temporary}" 2>/dev/null || true
    return 1
  fi
}

prune_old_backups() {
  local -a old_backups=()
  mapfile -t old_backups < <(
    find "${DEPLOY_BACKUP_DIR}" -maxdepth 1 -type f -name 'prod-*.db' -printf '%T@ %p\n' \
      | sort -nr \
      | tail -n "+$((MAX_BACKUPS + 1))" \
      | cut -d' ' -f2-
  )
  local backup
  for backup in "${old_backups[@]}"; do
    [[ "${backup}" == "${DEPLOY_BACKUP_DIR}/"prod-*.db ]] || die "refusing unexpected backup path ${backup}"
    unlink "${backup}"
  done
}

rollback_candidate() {
  local failed_status="$1"
  local rollback_started
  local rollback_ok=true
  trap - ERR INT TERM HUP
  set +e
  log "candidate failed (exit ${failed_status}); rolling code back to ${PREVIOUS_SHA} without restoring SQLite."
  if ! compose_for_revision "${TARGET_SHA}" stop --timeout 60 app >/dev/null 2>&1; then
    log "rollback warning: candidate stop command failed; validation remains fail-closed."
  fi

  if ! timeout 30 docker image inspect "${APP_IMAGE_REPOSITORY}:${PREVIOUS_SHA}" >/dev/null 2>&1; then
    log "FATAL: previous image ${PREVIOUS_SHA} is unavailable; leaving all app writers stopped."
    compose_for_revision "${TARGET_SHA}" stop --timeout 60 app >/dev/null 2>&1
    exit "${failed_status}"
  fi

  rollback_started="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if ! compose_for_revision "${PREVIOUS_SHA}" up \
      --detach --no-deps --no-build --force-recreate app; then
    log "rollback validation: previous image did not start."
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && \
    ! timeout 30 docker update --restart=no "${APP_CONTAINER}" >/dev/null; then
    log "rollback validation: could not enforce restart=no."
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && \
    ! wait_for_revision "${PREVIOUS_SHA}" "${rollback_started}" "rollback"; then
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && ! verify_backup_path; then
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && ! verify_public_revision_samples "${PREVIOUS_SHA}"; then
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && ! write_host_revision "${PREVIOUS_SHA}"; then
    log "rollback validation: could not restore the reboot revision pointer."
    rollback_ok=false
  fi
  if [[ "${rollback_ok}" == "true" ]] && \
    ! write_receipt "rolled_back" "${PREVIOUS_SHA}" "${TARGET_SHA}" "${FINAL_BACKUP}"; then
    log "rollback validation: could not persist the rollback receipt."
    rollback_ok=false
  fi

  if [[ "${rollback_ok}" == "true" ]]; then
    log "rollback to ${PREVIOUS_SHA} succeeded; SQLite was preserved in place."
    exit "${failed_status}"
  fi

  log "FATAL: both candidate and rollback validation failed; stopping every app writer."
  compose_for_revision "${PREVIOUS_SHA}" stop --timeout 60 app >/dev/null 2>&1
  exit "${failed_status}"
}

on_error() {
  local status=$?
  local line="${1:-unknown}"
  log "transaction failed at line ${line} (exit ${status})."
  if [[ "${CUTOVER_STARTED}" == "true" && "${DEPLOY_SUCCEEDED}" != "true" ]]; then
    rollback_candidate "${status}"
  fi
  exit "${status}"
}

on_signal() {
  local signal_name="$1"
  local status="$2"
  trap - INT TERM HUP
  log "received ${signal_name}; terminating the deployment transaction safely."
  if [[ "${CUTOVER_STARTED}" == "true" && "${DEPLOY_SUCCEEDED}" != "true" ]]; then
    rollback_candidate "${status}"
  fi
  exit "${status}"
}

trap 'on_error ${LINENO}' ERR
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap cleanup_scratch EXIT

if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root."
  exit 1
fi
if [[ ! "${TARGET_SHA}" =~ ^[0-9a-f]{40}$ || $# -ne 1 ]]; then
  log "ERROR: usage-monitor-deploy requires exactly one lowercase 40-hex SHA."
  exit 64
fi

exec 9>"${LOCK_FILE}"
if ! flock -w 10 9; then
  log "deployment lock is already held."
  exit 75
fi

for command in awk curl cut date docker find findmnt flock git grep install ionice jq mountpoint nice sqlite3 stat sync timeout; do
  command -v "${command}" >/dev/null || die "required command is unavailable: ${command}"
done
install -d -o root -g root -m 0750 "${STATE_DIR}"
require_secure_root_file "${HOST_ENV}" 600
require_secure_root_file "${RUNTIME_ENV}" 600
require_secure_root_file "${COMPOSE_FILE}" 644
require_secure_root_file "${RENDER_RETIREMENT_PROOF}" 600
require_secure_root_file "${RENDER_CURL_CONFIG}" 600
require_secure_root_file "/usr/local/sbin/usage-monitor-deploy" 755

PREVIOUS_SHA="$(read_env_value "${HOST_ENV}" USAGE_MONITOR_REVISION)"
[[ "${PREVIOUS_SHA}" =~ ^[0-9a-f]{40}$ ]] || die "host.env has no valid current revision"
ensure_public_caddy_hostname || die "USAGE_MONITOR_HOSTNAME preflight failed"

require_current_main "${TARGET_SHA}"
set +e
require_github_eligibility "${TARGET_SHA}"
eligibility_status=$?
set -e
if (( eligibility_status != 0 )); then
  exit "${eligibility_status}"
fi

preflight_current_production

if [[ "${PREVIOUS_SHA}" == "${TARGET_SHA}" ]]; then
  current_ready="$(fetch_public_ready)"
  clear_candidate_start="$(jq -r '.checks.scheduler.startedAt' <<<"${current_ready}")"
  wait_for_revision "${TARGET_SHA}" "${clear_candidate_start}" "idempotent production"
  verify_backup_path
  verify_public_revision_samples "${TARGET_SHA}"
  timeout 30 docker update --restart=no "${APP_CONTAINER}" >/dev/null
  write_receipt "already_current" "${TARGET_SHA}" "${PREVIOUS_SHA}" ""
  DEPLOY_SUCCEEDED=true
  exit 0
fi

ensure_mirror_and_release "${TARGET_SHA}"
build_and_verify_image "${TARGET_SHA}" "${RELEASE_DIR}"
verify_target_migration_on_scratch "${TARGET_SHA}"

# A merge can land during the build or scratch migration. Stale candidates
# never stop production; the next timer run handles the new exact main SHA.
require_current_main "${TARGET_SHA}"
preflight_current_production
# Close the build/preflight TOCTOU window immediately before writer mutation.
require_current_main "${TARGET_SHA}"

log "stopping the sole app writer for the brief SQLite cutover."
CUTOVER_STARTED=true
compose_for_revision "${PREVIOUS_SHA}" stop --timeout 60 app
capture_quiescent_backup_watermark "${PREVIOUS_SHA}"

install -d -o 1000 -g 1000 -m 0750 "${DEPLOY_BACKUP_DIR}"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_BACKUP="${DEPLOY_BACKUP_DIR}/prod-${backup_stamp}-${PREVIOUS_SHA}-to-${TARGET_SHA}.db"
create_sqlite_backup "${FINAL_BACKUP}"
log "preserved verified offline rollback snapshot ${FINAL_BACKUP}."

# If main changes during writer stop or snapshot creation, restore the accepted
# previous image and let the next timer transaction build the new main.
if ! post_stop_main="$(remote_main_sha)"; then
  log "could not re-resolve main during cutover; restoring ${PREVIOUS_SHA}."
  rollback_candidate 75
fi
if [[ ! "${post_stop_main}" =~ ^[0-9a-f]{40}$ || "${post_stop_main}" != "${TARGET_SHA}" ]]; then
  log "main changed to ${post_stop_main:-unknown} during cutover; restoring ${PREVIOUS_SHA}."
  rollback_candidate 75
fi

CANDIDATE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
compose_for_revision "${TARGET_SHA}" up \
  --detach --no-deps --no-build --force-recreate app
timeout 30 docker update --restart=no "${APP_CONTAINER}" >/dev/null

wait_for_revision "${TARGET_SHA}" "${CANDIDATE_STARTED_AT}" "candidate"
require_single_app_container
wait_for_backup_advancement "${PRE_CUTOVER_BACKUP_MAX_TXID}"
verify_backup_path
verify_backup_restore
verify_public_revision_samples "${TARGET_SHA}"

# Candidate validation can take minutes. Never commit a reboot pointer for a
# revision that ceased to be main during scheduler/backup acceptance.
if ! accepted_main="$(remote_main_sha)"; then
  log "could not re-resolve main after candidate acceptance; restoring ${PREVIOUS_SHA}."
  rollback_candidate 75
fi
if [[ ! "${accepted_main}" =~ ^[0-9a-f]{40}$ || "${accepted_main}" != "${TARGET_SHA}" ]]; then
  log "main changed to ${accepted_main:-unknown} during candidate acceptance; restoring ${PREVIOUS_SHA}."
  rollback_candidate 75
fi

# Commit the reboot pointer only after the candidate is independently green.
write_host_revision "${TARGET_SHA}"
timeout 30 docker update --restart=no "${APP_CONTAINER}" >/dev/null
write_receipt "deployed" "${TARGET_SHA}" "${PREVIOUS_SHA}" "${FINAL_BACKUP}"
prune_old_backups
DEPLOY_SUCCEEDED=true
log "deployment committed: ${PREVIOUS_SHA} -> ${TARGET_SHA}."
