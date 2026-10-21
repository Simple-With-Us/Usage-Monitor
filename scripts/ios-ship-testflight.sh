#!/usr/bin/env bash
# Thin wrapper: ship Usage Monitor Client to TestFlight (no Xcode UI).
# Canonical implementation: scripts/ios-fleet/ship-testflight.sh (in this repo).
# Hosted macos-latest has no /Users/jay/apps/ios-fleet; that path is a local
# fallback only. Do not restart a Mac runner or run xcodebuild locally to ship.
#
# WHY A MERGE OFTEN DOES NOT PRODUCE A TESTFLIGHT BUILD
# .github/workflows/ios-ship.yml calls this on every push to main touching
# ios/**, but the fleet script enforces a minimum interval between
# successful ships per app: DEFAULT_MIN_INTERVAL_SEC=3600 (3600s = 1 hour),
# defined near the top of scripts/ios-fleet/ship-testflight.sh. Runs inside that
# window log "ship-gate: skip" and exit 0. It also skips when git HEAD already
# shipped. Neither kind of skip consumes a build number (fixed 2026-08-12).
# Override one run with IOS_TF_MIN_INTERVAL_SEC=<seconds> or --force-ship;
# changing the standing limit means editing DEFAULT_MIN_INTERVAL_SEC.
#
# STABLE XCODE IS MANDATORY (owner, reaffirmed 2026-08-11).
# Xcode-beta's SDK breaks TestFlight / App Store Connect compatibility: a binary
# built against a beta SDK is accepted into TestFlight but rejected at
# submission as INVALID_BINARY.
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
exec bash "$SHIP_SCRIPT" usage --repo-root "$ROOT" "$@"
