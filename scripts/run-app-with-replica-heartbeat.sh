#!/usr/bin/env bash
# Supervised child of `litestream replicate -exec …` (B2 / non-R2 path).
# Starts the replica status heartbeat, then execs npm start so litestream
# remains PID 1 for signal routing while /api/ready gets a live side-channel.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export LITESTREAM_ACTIVE="${LITESTREAM_ACTIVE:-true}"
export LITESTREAM_REPLICA_STATUS_PATH="${LITESTREAM_REPLICA_STATUS_PATH:-/data/.litestream-replica-status.json}"

HEARTBEAT="${REPO_ROOT}/scripts/replica-status-heartbeat.sh"
if [[ -f "${HEARTBEAT}" ]]; then
  bash "${HEARTBEAT}" --once || echo "[run-app-with-replica-heartbeat] initial probe failed (will retry)" >&2
  bash "${HEARTBEAT}" &
  HEARTBEAT_PID=$!
  cleanup() {
    if kill -0 "${HEARTBEAT_PID}" 2>/dev/null; then
      kill "${HEARTBEAT_PID}" 2>/dev/null || true
      wait "${HEARTBEAT_PID}" 2>/dev/null || true
    fi
  }
  trap cleanup SIGTERM SIGINT EXIT
fi

exec npm start
