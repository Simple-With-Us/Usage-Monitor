#!/usr/bin/env bash
# Regenerate /etc/usage-monitor/usage-monitor.env from Infisical prod.
# Infisical is the sole source of truth for app secrets. This file is a
# host-side materialization for Docker Compose env_file (and deploy preflight)
# until the image entrypoint injects secrets directly via infisical-run.
set -euo pipefail
umask 077

BOOTSTRAP="${INFISICAL_BOOTSTRAP_ENV:-/etc/usage-monitor/infisical-bootstrap.env}"
OUT="${USAGE_MONITOR_RUNTIME_ENV:-/etc/usage-monitor/usage-monitor.env}"
PROJECT_ID_DEFAULT="${INFISICAL_UM_PROJECT_ID:-}"
ENV_NAME_DEFAULT="prod"
PATH_DEFAULT="/"

[[ -f "${BOOTSTRAP}" ]] || {
  echo "missing bootstrap env: ${BOOTSTRAP}" >&2
  exit 1
}

mode="$(stat -c '%a' "${BOOTSTRAP}" 2>/dev/null || stat -f '%Lp' "${BOOTSTRAP}")"
[[ "${mode}" == "600" ]] || {
  echo "bootstrap env must be mode 600 (got ${mode})" >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
source "${BOOTSTRAP}"
set +a

PROJECT_ID="${INFISICAL_UM_PROJECT_ID:-${INFISICAL_PROJECT_ID:-${PROJECT_ID_DEFAULT}}}"
ENV_NAME="${INFISICAL_ENV:-${ENV_NAME_DEFAULT}}"
SECRET_PATH="${INFISICAL_UM_SECRET_PATH:-${INFISICAL_PATH:-${PATH_DEFAULT}}}"
BASE_URL="${INFISICAL_BASE_URL:-https://app.infisical.com}"

command -v infisical >/dev/null || {
  echo "infisical CLI not on PATH" >&2
  exit 127
}

CLIENT_ID="${INFISICAL_AUTOMATION_CLIENT_ID:-${INFISICAL_CLIENT_ID:-}}"
CLIENT_SECRET="${INFISICAL_AUTOMATION_CLIENT_SECRET:-${INFISICAL_CLIENT_SECRET:-}}"
[[ -n "${CLIENT_ID}" && -n "${CLIENT_SECRET}" ]] || {
  echo "bootstrap must set INFISICAL_AUTOMATION_CLIENT_ID and INFISICAL_AUTOMATION_CLIENT_SECRET" >&2
  exit 2
}

export INFISICAL_TOKEN
INFISICAL_TOKEN="$(
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="${CLIENT_ID}" \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="${CLIENT_SECRET}" \
    infisical login --method=universal-auth --silent --plain --domain="${BASE_URL}"
)"
[[ -n "${INFISICAL_TOKEN}" ]] || {
  echo "infisical login failed" >&2
  exit 1
}

TMP="$(mktemp "${OUT}.tmp.XXXXXX")"
cleanup() {
  rm -f "${TMP}"
  unset INFISICAL_TOKEN || true
}
trap cleanup EXIT

{
  echo "# GENERATED from Infisical — do not edit by hand"
  echo "# project=${PROJECT_ID} env=${ENV_NAME} path=${SECRET_PATH}"
  echo "# regenerated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# source_of_truth=infisical"
  echo
  infisical export \
    --env "${ENV_NAME}" \
    --path "${SECRET_PATH}" \
    --projectId "${PROJECT_ID}" \
    --format dotenv \
    --domain "${BASE_URL}" \
    --token "${INFISICAL_TOKEN}"
} >"${TMP}"

# Strip surrounding quotes Infisical export may add so Docker Compose env_file
# and deploy preflight parsers see bare values.
python3 - "${TMP}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
out_lines = []
vals: dict[str, str] = {}
for raw in path.read_text().splitlines():
    if not raw or raw.startswith("#") or "=" not in raw:
        out_lines.append(raw)
        continue
    key, value = raw.split("=", 1)
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    vals[key.strip()] = value
    # dotenv-safe: quote only if needed
    if any(c in value for c in ' \t\n#"\'\\'):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        out_lines.append(f'{key.strip()}="{escaped}"')
    else:
        out_lines.append(f"{key.strip()}={value}")

required = [
    "ENCRYPTION_KEY",
    "SESSION_SECRET",
    "USAGE_INGEST_TOKEN",
    "USAGE_READ_TOKEN",
    "LITESTREAM_S3_BUCKET",
    "LITESTREAM_S3_ENDPOINT",
    "LITESTREAM_S3_ACCESS_KEY_ID",
    "LITESTREAM_S3_SECRET_ACCESS_KEY",
    "LITESTREAM_REQUIRED",
    "DASHBOARD_PASSWORD",
    "CRON_SECRET",
]
bucket = vals.get("LITESTREAM_S3_BUCKET") or vals.get("AWS_S3_BUCKET_NAME")
if not bucket:
    missing.append("LITESTREAM_S3_BUCKET / AWS_S3_BUCKET_NAME")
missing_keys = [k for k in required if not vals.get(k) and not (k.startswith("LITESTREAM_S3_") and vals.get("AWS_" + k.replace("LITESTREAM_S3_", "").replace("BUCKET", "S3_BUCKET_NAME").replace("REGION", "REGION").replace("ACCESS_KEY_ID", "ACCESS_KEY_ID").replace("SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY")))]
if missing_keys and not bucket:
    raise SystemExit(f"missing required keys from Infisical: {', '.join(missing_keys)}")

errors = []
if vals.get("LITESTREAM_REQUIRED") != "true":
    errors.append("LITESTREAM_REQUIRED must be true")
# B2 primary (2026-08-07). R2 usage-monitor-prod-v3 is historic freeze only.
if bucket not in ("jays-usage-monitor-eu", "usage-monitor-prod-v3"):
    errors.append(
        "LITESTREAM_S3_BUCKET/AWS_S3_BUCKET_NAME must be jays-usage-monitor-eu "
        "(B2 primary) or historic R2 usage-monitor-prod-v3 during cutover"
    )
endpoint = (vals.get("LITESTREAM_S3_ENDPOINT") or vals.get("AWS_S3_ENDPOINT") or "").lower()
if bucket == "jays-usage-monitor-eu" and "backblazeb2.com" not in endpoint:
    errors.append(
        "B2 bucket jays-usage-monitor-eu requires a backblazeb2.com S3 endpoint "
        "(e.g. https://s3.eu-central-003.backblazeb2.com)"
    )
sched = vals.get("USAGE_SCHEDULER_ENABLED")
if sched not in (None, "", "true"):
    errors.append("USAGE_SCHEDULER_ENABLED must be true when set")
if errors:
    raise SystemExit("invariant failures: " + "; ".join(errors))

path.write_text("\n".join(out_lines) + "\n")
print(f"materialized {len(vals)} keys from Infisical")
PY

install -o root -g root -m 0600 "${TMP}" "${OUT}"
echo "wrote ${OUT} from Infisical (${ENV_NAME})"
