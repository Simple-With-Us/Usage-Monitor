#!/usr/bin/env bash
#
# cursor-cloud-start.sh — runs every Cursor cloud agent boot.  When
# INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are set (Cursor injects at
# boot), logs in to Infisical and exports the prod-env secrets for Usage-Monitor
# into $HOME/.cursor-cloud-env/Usage-Monitor.env (mode 0600).  Also writes a
# companion Usage-Monitor.source.sh that sources it with `set -a` so the
# downstream app / test process picks every key up.
#
# When credentials are missing: print the missing dashboard secret NAMES and
# exit 0 — never fail the agent boot.  The repo .env.example carries the local
# SQLite defaults needed for typecheck / vitest without prod DB.
#
# Never print secret values.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REPO_NAME="Usage-Monitor"
ENV_DIR="${HOME}/.cursor-cloud-env"
ENV_FILE="${ENV_DIR}/${REPO_NAME}.env"
SOURCE_FILE="${ENV_DIR}/${REPO_NAME}.source.sh"
INFISICAL_ENV_FILE="${REPO_ROOT}/.cursor/infisical.env"

log() { printf '[cursor-start] %s\n' "$*" >&2; }

# ---- Load non-secret Infisical address from .cursor/infisical.env ---------
if [[ -f "${INFISICAL_ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${INFISICAL_ENV_FILE}"; set +a
  log "Loaded ${INFISICAL_ENV_FILE}"
fi

INFISICAL_DOMAIN_DEFAULT="https://app.infisical.com"
export INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-${INFISICAL_DOMAIN_DEFAULT}}"
export INFISICAL_ENV="${INFISICAL_ENV:-prod}"
export INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-86e35e51-91bc-4dfd-a045-4484726b9c40}"

mkdir -p "${ENV_DIR}"
chmod 0700 "${ENV_DIR}" 2>/dev/null || true

# ---- Load .env.example into the .env if absent (local sqlite defaults) -----
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
LOCAL_ENV="${REPO_ROOT}/.env"
if [[ -f "${ENV_EXAMPLE}" && ! -f "${LOCAL_ENV}" ]]; then
  cp "${ENV_EXAMPLE}" "${LOCAL_ENV}"
  chmod 0600 "${LOCAL_ENV}" 2>/dev/null || true
  log "Seeded ${LOCAL_ENV} from .env.example (local sqlite defaults for typecheck / vitest)"
fi

# ---- Missing-credential early exit (do not print values) -----------------
client_id_set=0
client_secret_set=0
[[ -n "${INFISICAL_CLIENT_ID:-}" ]]     && client_id_set=1
[[ -n "${INFISICAL_CLIENT_SECRET:-}" ]] && client_secret_set=1

if [[ "${client_id_set}" -eq 0 || "${client_secret_set}" -eq 0 ]]; then
  missing_names=()
  [[ "${client_id_set}"     -eq 0 ]] && missing_names+=("INFISICAL_CLIENT_ID")
  [[ "${client_secret_set}" -eq 0 ]] && missing_names+=("INFISICAL_CLIENT_SECRET")
  log "Infisical Universal Auth credentials not set in Cursor dashboard."
  log "Missing dashboard secret names: ${missing_names[*]}"
  log "Skipping Infisical inject (boot continues with .env.example sqlite defaults)."
  log "Local typecheck/test available via:  npm run typecheck   and   npm test"
  exit 0
fi

# ---- Prod only (owner directive 2026-10-10) ----------------------------------
# dev and staging are being retired.  Refuse anything else rather than reading
# it; this runs after the missing-credential exit so an uncredentialed boot
# still continues with the sqlite defaults.
if [[ "${INFISICAL_ENV}" != "prod" ]]; then
  log "INFISICAL_ENV must be prod (dev and staging are retired); refusing to load."
  exit 1
fi

# ---- Choose loader: repo helper > CLI > curl+python3 fallback ------------
fetch_via_helper() {
  if [[ -f "${REPO_ROOT}/scripts/infisical-run.mjs" ]]; then
    log "Fetching secrets via scripts/infisical-run.mjs (Universal Auth)"
    INFISICAL_PATH="${INFISICAL_PATH:-/}" node "${REPO_ROOT}/scripts/infisical-run.mjs" -- env >"${ENV_FILE}.tmp" 2>"${ENV_DIR}/${REPO_NAME}.fetch.err" || return $?
    return 0
  fi
  return 127
}

fetch_via_cli() {
  if command -v infisical >/dev/null 2>&1; then
    log "Fetching secrets via infisical CLI (Universal Auth)"
    INFISICAL_PATH="${INFISICAL_PATH:-/}" \
      infisical run --domain "${INFISICAL_DOMAIN}" --project "${INFISICAL_PROJECT_ID}" --env "${INFISICAL_ENV}" --path / --silent -- \
        env >"${ENV_FILE}.tmp" 2>"${ENV_DIR}/${REPO_NAME}.fetch.err" || return $?
    return 0
  fi
  return 127
}

fetch_via_curl() {
  if ! command -v python3 >/dev/null 2>&1; then
    log "curl+python3 fallback unavailable (no python3)"
    return 127
  fi
  log "Fetching secrets via curl + python3 (Universal Auth, value-blind)"
  python3 - <<'PYEOF' >"${ENV_FILE}.tmp" 2>"${ENV_DIR}/${REPO_NAME}.fetch.err" || exit $?
import json, os, subprocess, sys, urllib.request, urllib.parse, urllib.error, shlex, tempfile

DOMAIN = os.environ.get("INFISICAL_DOMAIN", "https://app.infisical.com")
PROJECT_ID = os.environ["INFISICAL_PROJECT_ID"]
ENV_NAME = os.environ.get("INFISICAL_ENV", "prod")
SECRET_PATH = os.environ.get("INFISICAL_PATH") or "/"
CLIENT_ID = os.environ["INFISICAL_CLIENT_ID"]
CLIENT_SECRET = os.environ["INFISICAL_CLIENT_SECRET"]

def post(path, body):
    req = urllib.request.Request(
        DOMAIN.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

token = post(
    "/api/v1/auth/universal-auth/login",
    {"clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET},
)["accessToken"]

secrets_list = []
ws = None
while True:
    body = {"workspaceSlug": ws, "environment": ENV_NAME, "secretPath": SECRET_PATH} if ws else {"environment": ENV_NAME, "secretPath": SECRET_PATH}
    req = urllib.request.Request(
        DOMAIN.rstrip("/") + f"/api/v3/secrets/raw?projectId={urllib.parse.quote(PROJECT_ID)}&environmentSlug={urllib.parse.quote(ENV_NAME)}&secretPath={urllib.parse.quote(SECRET_PATH)}&includeImports=false&recursive=false&expandSecretReferences=false",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        payload = json.loads(r.read().decode())
    secrets_list.extend(payload.get("secrets", []))
    nxt = payload.get("next") or payload.get("nextOffset") or None
    if not nxt:
        break

for s in secrets_list:
    key = s.get("secretKey") or s.get("key")
    val = s.get("secretValue") or s.get("value")
    if not key or val is None:
        continue
    sys.stdout.write(f'{key}={val}\n')
PYEOF
  return 0
}

fetch_ok=1
if fetch_via_helper; then
  fetch_ok=0
elif fetch_via_cli; then
  fetch_ok=0
elif fetch_via_curl; then
  fetch_ok=0
fi

if [[ "${fetch_ok}" -ne 0 ]] || [[ ! -s "${ENV_FILE}.tmp" ]]; then
  log "Infisical secret fetch failed; see ${ENV_DIR}/${REPO_NAME}.fetch.err (names-only, no values)"
  log "Agent boot continues with .env.example sqlite defaults for typecheck / vitest"
  rm -f "${ENV_FILE}.tmp" 2>/dev/null || true
  exit 0
fi

mv "${ENV_FILE}.tmp" "${ENV_FILE}"
chmod 0600 "${ENV_FILE}" 2>/dev/null || true

# ---- Write the silent .source.sh companion --------------------------------
cat >"${SOURCE_FILE}" <<'SOURCE_EOF'
#!/usr/bin/env bash
# Auto-generated by scripts/cursor-cloud-start.sh — sources Usage-Monitor.env
# without printing values.  Use as:  source ~/.cursor-cloud-env/Usage-Monitor.source.sh
set -a
# shellcheck disable=SC1090
source "${HOME}/.cursor-cloud-env/Usage-Monitor.env"
set +a
SOURCE_EOF
chmod 0600 "${SOURCE_FILE}" 2>/dev/null || true

# Strip the scratch err file on success
rm -f "${ENV_DIR}/${REPO_NAME}.fetch.err" 2>/dev/null || true

log "Wrote ${ENV_FILE} (mode 0600) for env=${INFISICAL_ENV} project=${INFISICAL_PROJECT_ID}"
log "To source secrets in this shell:  source ${SOURCE_FILE}"