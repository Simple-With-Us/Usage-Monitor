#!/usr/bin/env bash
# Capture App Store screenshots for Usage Client Monitor + Usage Local Monitor
# using simulator demo launch args (-ScreenshotDemo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/ios/UsageMonitor/UsageMonitor.xcodeproj"
OUT_ROOT="${ASC_SCREENSHOT_DIR:-$ROOT/docs/asc/screenshots}"
DERIVED="${ASC_DERIVED_DATA:-/tmp/um-asc-screenshots-derived}"

# Prefer a 6.7"-class iPhone for APP_IPHONE_67; fall back to any available iPhone.
IPHONE_UDID="${ASC_IPHONE_UDID:-}"
IPAD_UDID="${ASC_IPAD_UDID:-}"

pick_device() {
  local want="$1"
  xcrun simctl list devices available -j | python3 - "$want" <<'PY'
import json,sys
want=sys.argv[1]
data=json.load(sys.stdin)
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime and "iphoneos" not in runtime.lower():
        continue
    for d in devices:
        name=d.get("name","")
        if d.get("isAvailable") is False:
            continue
        if want=="iphone" and "iPhone" in name and "iPad" not in name:
            # Prefer Pro Max / ASC-named
            if "Pro Max" in name or "ASC" in name or "UM" in name:
                print(d["udid"]); sys.exit(0)
        if want=="ipad" and "iPad Pro" in name:
            print(d["udid"]); sys.exit(0)
# second pass looser
for runtime, devices in data.get("devices", {}).items():
    for d in devices:
        name=d.get("name","")
        if want=="iphone" and name.startswith("iPhone"):
            print(d["udid"]); sys.exit(0)
        if want=="ipad" and name.startswith("iPad"):
            print(d["udid"]); sys.exit(0)
sys.exit(1)
PY
}

if [[ -z "$IPHONE_UDID" ]]; then
  IPHONE_UDID="$(pick_device iphone)"
fi
if [[ -z "$IPAD_UDID" ]]; then
  IPAD_UDID="$(pick_device ipad || true)"
fi

echo "iPhone UDID=$IPHONE_UDID"
echo "iPad UDID=${IPAD_UDID:-none}"

boot() {
  local udid="$1"
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || xcrun simctl boot "$udid" || true
  xcrun simctl bootstatus "$udid" -b
}

build_app() {
  local scheme="$1"
  echo "Building $scheme..."
  xcodebuild \
    -project "$PROJ" \
    -scheme "$scheme" \
    -configuration Debug \
    -destination "id=$IPHONE_UDID" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO \
    build | tail -20
}

app_path() {
  local product="$1"
  find "$DERIVED/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name "${product}.app" | head -1
}

capture_app() {
  local scheme="$1" product="$2" bundle="$3" app_key="$4" tabs_csv="$5"
  local app
  app="$(app_path "$product")"
  [[ -n "$app" && -d "$app" ]] || { echo "missing app for $product"; return 1; }

  IFS=',' read -r -a tabs <<< "$tabs_csv"
  for udid_label in "iphone:$IPHONE_UDID" ${IPAD_UDID:+"ipad:$IPAD_UDID"}; do
    local kind="${udid_label%%:*}"
    local udid="${udid_label#*:}"
    boot "$udid"
    xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1 || true
    xcrun simctl install "$udid" "$app"
    local out_dir="$OUT_ROOT/$app_key/$kind"
    mkdir -p "$out_dir"
    for tab in "${tabs[@]}"; do
      echo "  $app_key $kind tab=$tab"
      xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1 || true
      xcrun simctl launch "$udid" "$bundle" -ScreenshotDemo -ScreenshotTab "$tab" >/dev/null
      # Allow bootstrap + demo seed
      sleep 4
      local file="$out_dir/$(printf '%02d' $(( ${#tabs[@]} - ${#tabs[@]} + $(printf '%s\n' "${tabs[@]}" | grep -n "^${tab}$" | cut -d: -f1) )) )-${tab}.png"
      # simpler name
      file="$out_dir/${tab}.png"
      xcrun simctl io "$udid" screenshot "$file"
      # Report pixels
      sips -g pixelWidth -g pixelHeight "$file" 2>/dev/null | paste - - || true
    done
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1 || true
  done
}

mkdir -p "$OUT_ROOT"
boot "$IPHONE_UDID"
build_app UsageMonitor
build_app LocalUsageMonitor

capture_app UsageMonitor UsageMonitor com.simplewithus.usage.client.ios client "dashboard,providers,projects,alerts,settings"
capture_app LocalUsageMonitor LocalUsageMonitor com.simplewithus.usage.local.ios local "overview,providers,projects,alerts,settings"

echo "Screenshots under $OUT_ROOT"
find "$OUT_ROOT" -name '*.png' | sort
