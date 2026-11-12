# Shared ensure-tf-ready exit-code handling for ship-testflight.sh and the
# post-sync workflow recheck (OPS-1052).  Source this file; do not execute it.
#
# Expects callers to set BUNDLE_ID and BUILD_NUM.  When sourced from
# ship-testflight.sh, log() is already defined.

if ! declare -f log >/dev/null 2>&1; then
  log() { echo "[ios-ship] $*"; }
fi

# Short label for workflow ship summaries (second readiness check).
tf_ready_rc_summary_label() {
  local rc="${1:?}"
  case "$rc" in
    0) echo "internal testers can install this build" ;;
    5) echo "processed but no internal tester can install yet" ;;
    6) echo "processed but internal installability is unverified" ;;
    3) echo "upload ok; ASC not IN_BETA_TESTING yet" ;;
    4) echo "build not surfaced; export compliance not declared" ;;
    2) echo "ensure-tf-ready API/usage error; export compliance not declared" ;;
    *) echo "ensure-tf-ready unexpected rc=${rc}" ;;
  esac
}

# Map asc-api.mjs ensure-tf-ready exit codes to log lines and GitHub annotations.
# Always returns shell 0 so a successful upload stays a green ship job.
handle_ensure_tf_ready_rc() {
  local rc="${1:?}"
  case "$rc" in
    0)
      log "TestFlight internal testers can install this build"
      return 0
      ;;
    5)
      log "warning: build ${BUILD_NUM} is processed but ${BUNDLE_ID} has no internal TestFlight testers with access to all builds; nobody can install it yet"
      log "warning: the Sync standing TestFlight testers step creates the internal group and adds testers; otherwise add internal testers in App Store Connect"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning title=TestFlight has no reachable internal tester::${BUNDLE_ID} build ${BUILD_NUM} is processed but no internal tester can install it.  Check the Sync standing TestFlight testers step."
      fi
      return 0
      ;;
    6)
      log "warning: build ${BUILD_NUM} is processed but internal TestFlight installability could not be read for ${BUNDLE_ID}; installability is unverified"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning title=TestFlight installability unverified::${BUNDLE_ID} build ${BUILD_NUM} is processed but internal installability could not be read.  Check TestFlight."
      fi
      return 0
      ;;
    3)
      log "warning: upload succeeded but ASC has not reached IN_BETA_TESTING yet; watch TestFlight"
      return 0
      ;;
    4)
      log "warning: ASC never surfaced build ${BUILD_NUM}; export compliance NOT declared on it"
      log "warning: if the phone never gets this build, declare compliance by hand in App Store Connect"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready could not find uploaded build ${BUILD_NUM} for ${BUNDLE_ID}; export compliance not declared"
      fi
      return 0
      ;;
    2)
      log "warning: ensure-tf-ready failed (rc=$rc); build may be stuck on export compliance"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready failed (rc=${rc}) for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance not declared"
      fi
      return 0
      ;;
    *)
      log "warning: ensure-tf-ready returned unexpected rc=${rc} for ${BUNDLE_ID} build ${BUILD_NUM}"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready returned unexpected rc=${rc} for ${BUNDLE_ID} build ${BUILD_NUM}"
      fi
      return 0
      ;;
  esac
}
