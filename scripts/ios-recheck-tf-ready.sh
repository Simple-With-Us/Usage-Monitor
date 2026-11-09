#!/usr/bin/env bash
# Post-sync ensure-tf-ready recheck for hosted ios-ship.yml (OPS-1052).
# Read-only ASC polling; uses the same readiness labels as ship-testflight.sh.
set -euo pipefail

APP_KEY="${1:?app key (usage | usage-local)}"
BUILD_NUM="${2:?12-digit CFBundleVersion}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLEET_DIR="${ROOT}/scripts/ios-fleet"
# shellcheck source=scripts/ios-fleet/tf-ready-rc.sh
source "${FLEET_DIR}/tf-ready-rc.sh"

read -r BUNDLE_ID MARKETING APPLE_ID <<EOF
$(python3 - <<'PY' "$APP_KEY" "$FLEET_DIR/apps.json"
import json, sys
app_key, path = sys.argv[1], sys.argv[2]
app = json.load(open(path))["apps"][app_key]
marketing = app.get("fixedMarketingVersion") or app.get("marketingVersionDefault") or "1.0.0"
print(app["bundleId"])
print(marketing)
print(app["appleId"])
PY
)
EOF

[[ "$BUILD_NUM" =~ ^[1-9][0-9]{11}$ ]] || {
  echo "::error::recheck-tf-ready for ${APP_KEY}: build '${BUILD_NUM}' is not a 12-digit merge-stamp build"
  exit 1
}

LOG_DIR="${TMPDIR:-/tmp}/ios-tf-recheck-${APP_KEY}-$$"
mkdir -p "$LOG_DIR"
set +e
node "${FLEET_DIR}/asc-api.mjs" ensure-tf-ready "$BUNDLE_ID" "$BUILD_NUM" "$MARKETING" "$APPLE_ID" \
  >"${LOG_DIR}/ensure-tf-ready.json" 2>"${LOG_DIR}/ensure-tf-ready.err"
rc=$?
set -e

if [[ -s "${LOG_DIR}/ensure-tf-ready.err" ]]; then
  while IFS= read -r line; do log "tf-ready (post-sync): $line"; done <"${LOG_DIR}/ensure-tf-ready.err"
fi

handle_ensure_tf_ready_rc "$rc"
summary="$(tf_ready_rc_summary_label "$rc")"
log "post-sync readiness for ${APP_KEY} (${BUNDLE_ID} build ${BUILD_NUM}): rc=${rc} — ${summary}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "tf_ready_rc=${rc}"
    echo "tf_ready_summary=${summary}"
    echo "tf_ready_bundle=${BUNDLE_ID}"
    echo "tf_ready_build=${BUILD_NUM}"
  } >>"$GITHUB_OUTPUT"
fi

exit 0
