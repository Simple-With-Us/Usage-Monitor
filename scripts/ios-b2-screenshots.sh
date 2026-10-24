#!/usr/bin/env bash
# Capture light + dark PNGs of the Server Status "B2 Usage by Application" daily
# chart on the iOS Simulator.  CI uploads the output directory as an artifact
# (see .github/workflows/ios-widget-screenshots.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIT="$ROOT/ios/UsageMonitor/UsageMonitorKit"
OUT="${B2_SCREENSHOT_DIR:-$ROOT/artifacts/ios-b2-screenshots}"
DERIVED="${B2_SCREENSHOT_DERIVED:-$(mktemp -d "${RUNNER_TEMP:-/tmp}/um-b2-screenshots-derived.XXXXXX")}"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is required (macOS with Xcode)." >&2
  exit 1
fi

mkdir -p "$OUT"

pick_simulator() {
  xcrun simctl list devices available -j | python3 -c 'import json,sys; data=json.load(sys.stdin); devices=[d for group in data.get("devices",{}).values() for d in group if d.get("isAvailable") is not False and d.get("name","").startswith("iPhone")]; print(devices[0]["udid"] if devices else "")'
}

UDID="${IOS_SIMULATOR_UDID:-$(pick_simulator)}"
echo "Simulator UDID=$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b

# xcodebuild only forwards TEST_RUNNER_-prefixed variables into the simulator
# test process (the prefix is stripped there), so both spellings are exported.
export B2_SCREENSHOT_DIR="$OUT"
export TEST_RUNNER_B2_SCREENSHOT_DIR="$OUT"

echo "Running B2 chart visual capture tests (PNG output -> $OUT)..."
(
  cd "$KIT"
  xcodebuild test \
    -scheme UsageMonitorKit-Package \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" \
    -only-testing:UsageMonitorKitTests/B2ChartVisualCaptureTests \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    | tail -40
)

# A skipped capture test must never pass silently, so require both PNGs.
missing=0
for png in b2-daily-chart-light.png b2-daily-chart-dark.png; do
  if [[ ! -f "$OUT/$png" ]]; then
    echo "Missing expected screenshot: $OUT/$png" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  echo "The B2 capture test produced no usable PNGs (it most likely skipped)." >&2
  echo "Check that B2_SCREENSHOT_DIR reaches the simulator test process." >&2
  exit 1
fi

echo "B2 chart screenshots:"
find "$OUT" -name '*.png' | sort
