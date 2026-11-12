#!/usr/bin/env bash
# Thin wrapper: ship Usage Monitor Local to TestFlight (no Xcode UI).
# Canonical implementation: scripts/ios-fleet/ship-testflight.sh (in this repo).
# The hosted macos-latest ios-ship.yml calls this as its second ship step, so a
# merge to main that touches ios/ uploads Local as well as Client.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

IN_REPO="${ROOT}/scripts/ios-fleet/ship-testflight.sh"
HOST_COPY="/Users/jay/apps/ios-fleet/ship-testflight.sh"
if [[ -f "$IN_REPO" ]]; then
  SHIP_SCRIPT="$IN_REPO"
  echo "[ios-ship] using in-repo fleet script: ${SHIP_SCRIPT}"
elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "error: hosted macos-latest has no ${HOST_COPY}; vendor scripts/ios-fleet/" >&2
  exit 1
elif [[ -f "$HOST_COPY" ]]; then
  echo "[ios-ship] WARNING: in-repo fleet script missing; using host copy" >&2
  SHIP_SCRIPT="$HOST_COPY"
else
  echo "error: no ship-testflight.sh (looked at ${IN_REPO})" >&2
  exit 1
fi
exec bash "$SHIP_SCRIPT" usage-local --repo-root "$ROOT" "$@"
