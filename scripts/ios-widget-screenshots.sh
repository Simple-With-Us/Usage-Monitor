#!/usr/bin/env bash
# Capture PNGs for every Usage Monitor widget topic × size family on the iOS Simulator.
# CI uploads the output directory as an artifact (see .github/workflows/ios-widget-screenshots.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/ios/UsageMonitor/UsageMonitor.xcodeproj"
OUT="${WIDGET_SCREENSHOT_DIR:-$ROOT/artifacts/ios-widget-screenshots}"
DERIVED="${WIDGET_SCREENSHOT_DERIVED:-${RUNNER_TEMP:-/tmp}/um-widget-screenshots-derived}"

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

if command -v xcodegen >/dev/null 2>&1; then
  (cd "$ROOT/ios/UsageMonitor" && xcodegen generate)
fi

# xcodebuild only forwards TEST_RUNNER_-prefixed variables into the simulator
# test process (the prefix is stripped there), so both spellings are exported.
export WIDGET_SCREENSHOT_DIR="$OUT"
export TEST_RUNNER_WIDGET_SCREENSHOT_DIR="$OUT"

echo "Running widget visual capture tests (PNG output -> $OUT)..."
xcodebuild test \
  -project "$PROJ" \
  -scheme UsageMonitor \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$DERIVED" \
  -only-testing:UsageMonitorWidgetTests/WidgetVisualCaptureTests/testCaptureWidgetConfigurations \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  | tail -40

# The capture test skips itself when it cannot see the output directory, so an
# artifact with nothing but the simulator frame would otherwise pass silently.
widget_pngs="$(find "$OUT" -name '*.png' ! -name 'simulator-booted.png' | sort)"
if [[ -z "$widget_pngs" ]]; then
  echo "No widget screenshots were written to $OUT." >&2
  echo "The capture test most likely skipped: check that WIDGET_SCREENSHOT_DIR reaches the simulator test process." >&2
  exit 1
fi

# Mirror one full-screen simctl capture so the artifact also includes a booted-simulator frame.
xcrun simctl io "$UDID" screenshot "$OUT/simulator-booted.png" || true

echo "Widget screenshots:"
find "$OUT" -name '*.png' | sort
