#!/usr/bin/env bash
# Production entrypoint wrapper:
#   - When explicit app machine-identity or service-token credentials are present, inject
#     secrets from the usage-monitor Infisical project and then start.
#   - Otherwise run start-with-litestream.sh with the process environment as-is
#     (Docker Compose env_file materialization path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

has_bootstrap=false
if [[ -n "${INFISICAL_UM_READ_TOKEN:-${INFISICAL_TOKEN:-}}" ||
  -n "${INFISICAL_CLIENT_ID:-}${INFISICAL_CLIENT_SECRET:-}${INFISICAL_UM_CLIENT_ID:-}${INFISICAL_UM_CLIENT_SECRET:-}" ]]; then
  has_bootstrap=true
fi

if [[ "${has_bootstrap}" == "true" ]]; then
  if ! command -v infisical >/dev/null 2>&1; then
    echo "[start-with-infisical] configured Infisical bootstrap requires the CLI" >&2
    exit 127
  fi
  export INFISICAL_ENV="${INFISICAL_ENV:-prod}"
  # Project UUID is an address, not a credential. Coolify no longer stores
  # INFISICAL_UM_PROJECT_ID (#1211 deleted it from the app env). #1315
  # removed this fallback and every later deploy rolled back: Infisical 404
  # `projectId=undefined`. Keep the bake here AND in the Dockerfile.
  UM_INFISICAL_PROJECT_ID="86e35e51-91bc-4dfd-a045-4484726b9c40"
  export INFISICAL_UM_PROJECT_ID="${INFISICAL_UM_PROJECT_ID:-${INFISICAL_PROJECT_ID:-${INFISICAL_APP_PROJECT_ID:-${UM_INFISICAL_PROJECT_ID}}}}"
  if [[ -z "${INFISICAL_UM_PROJECT_ID}" ]]; then
    echo "[start-with-infisical] INFISICAL_UM_PROJECT_ID missing; refusing Infisical inject" >&2
    exit 2
  fi
  echo "[start-with-infisical] injecting secrets from Infisical (env=${INFISICAL_ENV}, project=${INFISICAL_UM_PROJECT_ID})"
  exec node "${REPO_ROOT}/scripts/infisical-run.mjs" -- bash "${REPO_ROOT}/scripts/start-with-litestream.sh"
fi

echo "[start-with-infisical] no Infisical bootstrap credentials; using process env"
exec bash "${REPO_ROOT}/scripts/start-with-litestream.sh"
