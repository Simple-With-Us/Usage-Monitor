#!/usr/bin/env bash
# Sync the Usage Monitor production runtime environment from Infisical (the
# sole source of truth) into a root-owned tmpfs file that Docker Compose and
# the deploy transaction consume.
#
# Install this file root-owned as /usr/local/sbin/usage-monitor-env-sync.
#
# Inputs (the ONLY on-disk secret material): /etc/usage-monitor/infisical-bootstrap.env
#   INFISICAL_AUTOMATION_CLIENT_ID      (required; "automation" machine identity)
#   INFISICAL_AUTOMATION_CLIENT_SECRET  (required)
#   INFISICAL_UM_PROJECT_ID             (required; usage-monitor project)
#   INFISICAL_BASE_URL                  (optional; default https://app.infisical.com)
#   INFISICAL_UM_SECRET_PATH            (optional; default /)
#   INFISICAL_ENV                       (optional; default prod)
#
# Outputs (tmpfs; never persisted to a disk-backed .env):
#   /run/usage-monitor/usage-monitor.env   (mode 0600, root:root)
#   /run/usage-monitor/sync-metadata.json  (mode 0600, counts/scope only, NO values)
#
# Exit codes:
#   0  sync succeeded
#   1  sync failed (credentials, CLI, validation, or write failure)
#   2  bootstrap file absent — callers fall back to the legacy disk env file
#
# Never logs secret values, the JWT, or secret-bearing command output.
#
# Path overrides below exist so the sync logic can be exercised by tests and
# staging hosts without touching /etc or /run; production leaves them unset.
# USAGE_MONITOR_ENV_SYNC_TEST_UNSAFE additionally skips the root/ownership
# gates and must NEVER be set on a production host.
set -euo pipefail
umask 077
export LC_ALL=C

readonly BOOTSTRAP_FILE="${USAGE_MONITOR_ENV_SYNC_BOOTSTRAP:-/etc/usage-monitor/infisical-bootstrap.env}"
readonly OUTPUT_DIR="${USAGE_MONITOR_ENV_SYNC_OUTPUT_DIR:-/run/usage-monitor}"
readonly OUTPUT_ENV="${OUTPUT_DIR}/usage-monitor.env"
readonly OUTPUT_METADATA="${OUTPUT_DIR}/sync-metadata.json"
readonly DEFAULT_BASE_URL="https://app.infisical.com"
# Keys the deploy transaction and compose stack hard-require. USAGE_MONITOR_HOSTNAME
# is included because the Caddy service interpolates it from the project env-file.
readonly -a REQUIRED_KEYS=(
  DATABASE_URL
  ENCRYPTION_KEY
  DASHBOARD_PASSWORD
  SESSION_SECRET
  USAGE_INGEST_TOKEN
  USAGE_READ_TOKEN
  CRON_SECRET
  NODE_ENV
  USAGE_SCHEDULER_ENABLED
  LITESTREAM_REQUIRED
  LITESTREAM_S3_BUCKET
  USAGE_MONITOR_HOSTNAME
)

log() {
  printf '[usage-monitor-env-sync] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

# Same tolerant parser as deploy-production.sh: KEY=value with optional
# surrounding single/double quotes; values never echoed.
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

if [[ -z "${USAGE_MONITOR_ENV_SYNC_TEST_UNSAFE:-}" ]]; then
  if [[ "${EUID}" -ne 0 ]]; then
    log "ERROR: must run as root." >&2
    exit 1
  fi
fi

if [[ ! -f "${BOOTSTRAP_FILE}" || -L "${BOOTSTRAP_FILE}" ]]; then
  # Exit 2 is the documented "no Infisical bootstrap" signal; callers fall back
  # to the legacy /etc/usage-monitor/usage-monitor.env path.
  log "bootstrap file ${BOOTSTRAP_FILE} is absent; nothing to sync." >&2
  exit 2
fi
if [[ -z "${USAGE_MONITOR_ENV_SYNC_TEST_UNSAFE:-}" ]]; then
  if [[ "$(stat -c '%U:%G' "${BOOTSTRAP_FILE}")" != "root:root" || \
        "$(stat -c '%a' "${BOOTSTRAP_FILE}")" != "600" ]]; then
    fail "${BOOTSTRAP_FILE} must be a root-owned regular file with mode 0600"
  fi
fi

command -v infisical >/dev/null || fail "infisical CLI is not installed"
command -v jq >/dev/null || fail "jq is not installed"

CLIENT_ID="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_AUTOMATION_CLIENT_ID)"
CLIENT_SECRET="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_AUTOMATION_CLIENT_SECRET)"
PROJECT_ID="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_UM_PROJECT_ID)"
BASE_URL="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_BASE_URL)"
SECRET_PATH="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_UM_SECRET_PATH)"
INFISICAL_ENV_NAME="$(read_env_value "${BOOTSTRAP_FILE}" INFISICAL_ENV)"

[[ -n "${CLIENT_ID}" ]] || fail "INFISICAL_AUTOMATION_CLIENT_ID missing from bootstrap"
[[ -n "${CLIENT_SECRET}" ]] || fail "INFISICAL_AUTOMATION_CLIENT_SECRET missing from bootstrap"
[[ -n "${PROJECT_ID}" ]] || fail "INFISICAL_UM_PROJECT_ID missing from bootstrap"
[[ -n "${SECRET_PATH}" ]] || SECRET_PATH="/"
[[ -n "${INFISICAL_ENV_NAME}" ]] || INFISICAL_ENV_NAME="prod"

WORK_DIR="$(mktemp -d /tmp/usage-monitor-env-sync.XXXXXX)"
cleanup() {
  rm -rf -- "${WORK_DIR}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

# CLI quirks (verified against CLI 0.43.114):
#  - `infisical login --method=universal-auth ... --plain --silent` prints a JWT
#    on stdout. Credentials are passed via environment variables (the CLI's
#    documented INFISICAL_UNIVERSAL_AUTH_* inputs) so they never appear in argv.
#  - `infisical export`'s own auto-login flow fails with "Unable to parse
#    domain url"; always pass the JWT explicitly via --token.
#  - Do NOT pass --domain against the default Infisical cloud; only pass it
#    when INFISICAL_BASE_URL overrides the default (self-hosted).
DOMAIN_ARGS=()
if [[ -n "${BASE_URL}" && "${BASE_URL}" != "${DEFAULT_BASE_URL}" ]]; then
  DOMAIN_ARGS=("--domain=${BASE_URL}")
fi

TOKEN=""
# CLI stderr is captured, not inherited: an error message could echo a
# mistyped base URL or credential fragment, and operators only need the fact.
if ! TOKEN="$(
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="${CLIENT_ID}" \
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="${CLIENT_SECRET}" \
  infisical login --method=universal-auth --plain --silent \
    ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} 2>"${WORK_DIR}/login.stderr"
)"; then
  fail "infisical universal-auth login failed (credentials, network, or base URL)"
fi
unset CLIENT_ID CLIENT_SECRET
[[ -n "${TOKEN}" ]] || fail "infisical login returned an empty token"

EXPORT_JSON="${WORK_DIR}/export.json"
if ! infisical export \
  --token="${TOKEN}" \
  --projectId="${PROJECT_ID}" \
  --env="${INFISICAL_ENV_NAME}" \
  --path="${SECRET_PATH}" \
  --format=json --silent \
  ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} >"${EXPORT_JSON}" 2>"${WORK_DIR}/export.stderr"; then
  fail "infisical export failed (project ${PROJECT_ID}, env ${INFISICAL_ENV_NAME}, path ${SECRET_PATH})"
fi
unset TOKEN

# Structural validation: export JSON must be an array of {key,value,...} with
# valid environment-variable key names and single-line string values. Failure
# output lists only key NAMES / structural facts, never values.
if ! jq -e 'type == "array"' "${EXPORT_JSON}" >/dev/null; then
  fail "infisical export did not return a JSON array"
fi
invalid_keys="$(jq -r '
  [ .[] | select(
      (type != "object") or
      (.key | type != "string") or
      (.key | test("^[A-Za-z_][A-Za-z0-9_]*$") | not) or
      (.value | type != "string") or
      (.value | contains("\n"))
    ) | (if (type == "object" and (.key | type == "string")) then .key else "<malformed-entry>" end)
  ] | unique | join(" ")
' "${EXPORT_JSON}")"
if [[ -n "${invalid_keys}" ]]; then
  fail "export contained entries this writer refuses to persist (bad key name, non-string or multi-line value): ${invalid_keys}"
fi

missing_keys="$(jq -r --arg required "${REQUIRED_KEYS[*]}" '
  ($required | split(" ")) as $req
  | ([ .[].key ] | unique) as $present
  | [ $req[] | select(. as $k | ($present | index($k)) == null) ]
  | join(" ")
' "${EXPORT_JSON}")"
if [[ -n "${missing_keys}" ]]; then
  fail "required keys missing from Infisical (env ${INFISICAL_ENV_NAME}, path ${SECRET_PATH}): ${missing_keys}"
fi

KEY_COUNT="$(jq '[ .[].key ] | unique | length' "${EXPORT_JSON}")"

# Dotenv escaping decision: write RAW `KEY=value` lines, one per line, with no
# quoting, no escaping, and no comment lines. This is deliberate:
#  - `docker run --env-file` (used by the deploy transaction for the offline
#    Litestream listing) treats every line literally; quotes would become part
#    of the value.
#  - Docker Compose `env_file` does NOT execute shell; unquoted values keep
#    spaces, `$`, quotes, and backslashes verbatim, and inline `#` is not
#    treated as a comment in service env_file lines.
#  - The deploy transaction's read_env_value parser reads raw values exactly.
# Multi-line values are impossible in this format and are rejected above.
mkdir -p "${OUTPUT_DIR}"
chmod 0700 "${OUTPUT_DIR}"

TEMP_ENV="$(mktemp "${OUTPUT_DIR}/.usage-monitor.env.XXXXXX")"
jq -rj 'sort_by(.key) | .[] | .key + "=" + .value + "\n"' "${EXPORT_JSON}" >"${TEMP_ENV}"
chmod 0600 "${TEMP_ENV}"
mv "${TEMP_ENV}" "${OUTPUT_ENV}"

TEMP_METADATA="$(mktemp "${OUTPUT_DIR}/.sync-metadata.XXXXXX")"
jq -n \
  --arg syncedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson keyCount "${KEY_COUNT}" \
  --arg projectId "${PROJECT_ID}" \
  --arg path "${SECRET_PATH}" \
  --arg env "${INFISICAL_ENV_NAME}" \
  '{syncedAt:$syncedAt,keyCount:$keyCount,projectId:$projectId,path:$path,env:$env}' \
  >"${TEMP_METADATA}"
chmod 0600 "${TEMP_METADATA}"
mv "${TEMP_METADATA}" "${OUTPUT_METADATA}"

log "synced ${KEY_COUNT} keys from Infisical project ${PROJECT_ID} (env ${INFISICAL_ENV_NAME}, path ${SECRET_PATH}) to ${OUTPUT_ENV}."
