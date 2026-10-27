#!/usr/bin/env bash
# Builds, signs, notarizes and packages the Usage Monitor Mac app for
# Sparkle 2 self-update.  See docs/AUTO-UPDATE.md (the fleet pattern piloted
# by CodeCaps, also used by HogHunter).
#
#   scripts/mac-release-build.sh --build-only   stage macos/dist/Usage Monitor.app
#                                               and stop
#   scripts/mac-release-build.sh --release      --build-only, then notarize and
#                                               staple the app, rebuild the zip
#                                               from the stapled bundle, build,
#                                               sign, notarize and staple
#                                               macos/dist/UsageMonitor.dmg.
#                                               Both artifacts get a .sha256.
#
# Signing: $USAGEMONITOR_CODESIGN_IDENTITY when set, otherwise the first
# "Developer ID Application:" identity in the codesigning keychain.  The
# workflow imports the team certificate into a throwaway keychain first.
# USAGEMONITOR_ALLOW_ADHOC_VALIDATION=1 is allowed only with --build-only; it
# verifies bundle structure but an ad-hoc signature proves nothing about the
# Developer ID team.
#
# Versions: CFBundleShortVersionString is 1.0.<commit_count> and
# CFBundleVersion is `git rev-list --count HEAD`, unifying the macOS and iOS
# build numbering standard across the fleet.
#
# Auto-update: a staged bundle always carries the Sparkle feed and public key
# in its Info.plist (SUFeedURL, SUPublicEDKey, automatic checks/install, hourly
# interval).  Local `swift build` builds carry none of that:
# AutoUpdateAvailability keeps Sparkle switched off there instead of raising a
# launch-time alert.  Override the feed for a local rehearsal with
# USAGEMONITOR_SPARKLE_FEED_URL, or turn updates off for a staged build with
# USAGEMONITOR_SPARKLE_FEED_URL= (empty).  The public key is not a secret; its
# private half lives in the Usage-Monitor GitHub repository secrets
# (SPARKLE_ED_PRIVATE_KEY, synced from Fleet Secrets) and signs each archive
# in CI.
set -euo pipefail

MODE="${1:---build-only}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/macos"
DIST_DIR="$PACKAGE_DIR/dist"
APP_NAME="Usage Monitor"
EXECUTABLE_NAME="UsageMonitorMenu"
BUNDLE_ID="com.simplewithus.usage.macos"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_FRAMEWORKS="$APP_CONTENTS/Frameworks"
INFO_PLIST="$APP_CONTENTS/Info.plist"
ZIP_FILE="$DIST_DIR/UsageMonitor.zip"
DMG_FILE="$DIST_DIR/UsageMonitor.dmg"
ICON_SOURCE="$ROOT_DIR/public/brand/icon-512.png"

# Cutting a Mac release version is automatic from commit count (1.0.<commit_count>).

# --- Auto-update (Sparkle 2) -------------------------------------------------
SPARKLE_FEED_URL_DEFAULT="https://github.com/Simple-With-Us/Usage-Monitor/releases/latest/download/appcast.xml"
SPARKLE_PUBLIC_ED_KEY="${USAGEMONITOR_SPARKLE_PUBLIC_KEY:-/pP+nmu7F38np96nhP8LEfRLiZNMok1A8ctUljU1DMI=}"
SPARKLE_CHECK_INTERVAL="${USAGEMONITOR_SPARKLE_CHECK_INTERVAL:-3600}"

# notarytool signs in with an App Store Connect API key when all three of
# NOTARY_KEY_PATH, NOTARY_KEY_ID and NOTARY_ISSUER_ID are set (that is how CI
# does it).
NOTARY_AUTH=()
if [[ -n "${NOTARY_KEY_PATH:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER_ID:-}" ]]; then
  NOTARY_AUTH=(--key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID")
fi

usage() {
  cat >&2 <<'USAGE'
usage: scripts/mac-release-build.sh [--build-only | --release]

  --build-only   swift build a universal Release binary, stage
                 macos/dist/Usage Monitor.app (Sparkle.framework embedded,
                 icon, Info.plist with Sparkle keys), sign it (Developer ID,
                 hardened runtime, secure timestamp), and verify the signature.
                 With USAGEMONITOR_ALLOW_ADHOC_VALIDATION=1 the bundle is
                 signed ad-hoc instead, which only proves its structure.
  --release      --build-only, then notarize the zip, staple the app, run
                 spctl --assess on it, rebuild the zip from the stapled
                 bundle, and build, sign, notarize and staple the dmg.
USAGE
}

# codesign blocks on a Keychain key-access panel when this shell has never been
# authorized to use the signing key, and a build must never hang behind a panel
# nobody is watching.  Thirty seconds, then it fails.  A killed process reports
# 128 plus its signal, and `alarm` raises SIGALRM (14).
WATCHDOG_STATUS=142
codesign_bounded() {
  /usr/bin/perl -e 'alarm 30; exec @ARGV' /usr/bin/codesign "$@"
}

resolve_codesign_identity() {
  if [[ -n "${USAGEMONITOR_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "$USAGEMONITOR_CODESIGN_IDENTITY"
    return 0
  fi
  /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/sed -n 's/^.*"\(Developer ID Application:[^"]*\)".*$/\1/p' \
    | /usr/bin/head -n 1
}

bundle_version() {
  local count
  count="$(/usr/bin/git -C "$ROOT_DIR" rev-list --count HEAD 2>/dev/null || true)"
  [[ "$count" =~ ^[0-9]+$ ]] || { echo "error: could not read commit count from $ROOT_DIR" >&2; exit 1; }
  # Fail closed: a shallow or gitless checkout must not stamp build 1 below the floor.
  printf '%s\n' "$count"
}

short_version() {
  # Mac Sparkle path (UM-1639): marketing 1.0.<commit_count> shares the
  # CFBundleVersion integer so a release is traceable to one git count.
  # iOS TestFlight ships still go through scripts/ios-fleet/version-plan.mjs,
  # which refuses the retired 1.0.N (N) form (AFC-517) and overwrites the
  # xcodeproj at ship time.
  printf '1.0.%s\n' "$(bundle_version)"
}

# Info.plist entries for Sparkle.  Updates are checked hourly, then downloaded
# and installed without asking (AppUpdater installs the moment Usage Monitor is
# not frontmost).  An archive must pass its EdDSA check before it is even
# unpacked.  USAGEMONITOR_SPARKLE_FEED_URL= (set but empty) turns updates off.
write_sparkle_plist_entries() {
  local feed
  if [[ -n "${USAGEMONITOR_SPARKLE_FEED_URL+set}" ]]; then
    feed="$USAGEMONITOR_SPARKLE_FEED_URL"
  else
    feed="$SPARKLE_FEED_URL_DEFAULT"
  fi
  [[ -n "$feed" ]] || { echo "Sparkle updates disabled for this build."; return 0; }
  /usr/libexec/PlistBuddy -c "Set :SUFeedURL $feed" "$INFO_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $feed" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Set :SUPublicEDKey $SPARKLE_PUBLIC_ED_KEY" "$INFO_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_ED_KEY" "$INFO_PLIST"
  for key in SUEnableAutomaticChecks SUAutomaticallyUpdate SUAllowsAutomaticUpdates SUVerifyUpdateBeforeExtraction; do
    /usr/libexec/PlistBuddy -c "Set :$key true" "$INFO_PLIST" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Add :$key bool true" "$INFO_PLIST"
  done
  /usr/libexec/PlistBuddy -c "Set :SUScheduledCheckInterval $SPARKLE_CHECK_INTERVAL" "$INFO_PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :SUScheduledCheckInterval integer $SPARKLE_CHECK_INTERVAL" "$INFO_PLIST"
  echo "Sparkle feed: $feed"
}

write_info_plist() {
  local build short icon_file="AppIcon.png"
  build="$(bundle_version)"
  short="1.0.${build}"
  [[ -f "$ICON_SOURCE" ]] && icon_file="AppIcon.icns"
  /usr/bin/tee "$INFO_PLIST" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Usage Monitor for Mac</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIconFile</key>
  <string>$icon_file</string>
  <key>CFBundleShortVersionString</key>
  <string>$short</string>
  <key>CFBundleVersion</key>
  <string>$build</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST
  echo "version $(short_version) (build $build)"
}

write_icon() {
  if [[ -f "$ICON_SOURCE" ]] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    local iconset
    iconset="$(mktemp -d "${TMPDIR:-/tmp}/usage-monitor-icon.XXXXXX").iconset"
    mkdir -p "$iconset"
    trap 'rm -rf "$iconset"' RETURN
    sips -z 16 16 "$ICON_SOURCE" --out "$iconset/icon_16x16.png" >/dev/null
    sips -z 32 32 "$ICON_SOURCE" --out "$iconset/icon_16x16@2x.png" >/dev/null
    sips -z 32 32 "$ICON_SOURCE" --out "$iconset/icon_32x32.png" >/dev/null
    sips -z 64 64 "$ICON_SOURCE" --out "$iconset/icon_32x32@2x.png" >/dev/null
    sips -z 128 128 "$ICON_SOURCE" --out "$iconset/icon_128x128.png" >/dev/null
    sips -z 256 256 "$ICON_SOURCE" --out "$iconset/icon_128x128@2x.png" >/dev/null
    sips -z 256 256 "$ICON_SOURCE" --out "$iconset/icon_256x256.png" >/dev/null
    sips -z 512 512 "$ICON_SOURCE" --out "$iconset/icon_512x512.png" >/dev/null
    sips -z 1024 1024 "$ICON_SOURCE" --out "$iconset/icon_512x512@2x.png" >/dev/null
    iconutil -c icns "$iconset" -o "$APP_RESOURCES/AppIcon.icns"
    rm -rf "$iconset"
    trap - RETURN
  elif [[ -f "$ICON_SOURCE" ]]; then
    cp "$ICON_SOURCE" "$APP_RESOURCES/AppIcon.png"
  fi
}

# SwiftPM puts a binary-target framework (Sparkle) beside the executable, where
# the executable's @loader_path rpath finds it.  In the bundle it lives in
# Contents/Frameworks, so that rpath is added as well.  ditto keeps the
# framework's Versions symlinks, which codesign requires.
embed_frameworks() {
  local bin_dir="$1" framework
  rm -rf "$APP_FRAMEWORKS"
  for framework in "$bin_dir"/*.framework; do
    [[ -d "$framework" ]] || continue
    mkdir -p "$APP_FRAMEWORKS"
    /usr/bin/ditto "$framework" "$APP_FRAMEWORKS/$(basename "$framework")"
    echo "embedded $(basename "$framework")"
  done
  if [[ ! -d "$APP_FRAMEWORKS/Sparkle.framework" ]]; then
    echo "error: Sparkle.framework was not found in $bin_dir." >&2
    echo "error: refusing to stage an app that would crash at launch looking for it." >&2
    exit 1
  fi
  if ! /usr/bin/otool -l "$APP_MACOS/$EXECUTABLE_NAME" | /usr/bin/grep -q '@executable_path/../Frameworks'; then
    /usr/bin/install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_MACOS/$EXECUTABLE_NAME"
  fi
  echo "Sparkle.framework embedded"
}

# Nested code is signed before the bundle that contains it.  That is what
# replaces --deep, which re-signs everything inside with the outer bundle's
# options and which Apple has deprecated for exactly that reason.
nested_code_paths() {
  /usr/bin/find "$APP_CONTENTS" \
    \( -name '*.framework' -o -name '*.bundle' -o -name '*.appex' -o -name '*.dylib' \) \
    -prune -print 2>/dev/null | /usr/bin/sort -r
}

# Helpers that live inside a framework (Sparkle's Installer.xpc and
# Downloader.xpc, and the bare Autoupdate executable) are signed before the
# framework that holds them, which is the order Sparkle's own code-signing
# guide gives.  Entitlements are preserved because Downloader.xpc carries its
# own.
framework_helper_paths() {
  local framework name
  for framework in "$APP_FRAMEWORKS"/*.framework; do
    [[ -d "$framework" ]] || continue
    name="$(basename "$framework" .framework)"
    /usr/bin/find "$framework/Versions" -mindepth 3 -maxdepth 3 -path '*/XPCServices/*.xpc' -type d 2>/dev/null
    /usr/bin/find "$framework/Versions" -mindepth 2 -maxdepth 2 -name '*.app' -type d 2>/dev/null
    /usr/bin/find "$framework/Versions" -mindepth 2 -maxdepth 2 -type f -perm -u+x ! -name "$name" 2>/dev/null
  done
}

sign_with_identity() {
  local identity="$1" target status
  local sign_opts=(--options runtime --timestamp)
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    codesign_bounded --force ${sign_opts[@]+"${sign_opts[@]}"} \
      --preserve-metadata=entitlements --sign "$identity" "$target" || return 1
  done < <(framework_helper_paths)
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    codesign_bounded --force ${sign_opts[@]+"${sign_opts[@]}"} --sign "$identity" "$target" && continue
    status=$?
    [[ "$status" != "$WATCHDOG_STATUS" ]] || return 1
    echo "note: not separately signable, sealed as a resource instead: $target"
  done < <(nested_code_paths)
  codesign_bounded --force ${sign_opts[@]+"${sign_opts[@]}"} \
    --sign "$identity" "$APP_BUNDLE" || return 1
}

verify_app_signature() {
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"; then
    echo "error: codesign --verify --deep --strict failed for $APP_BUNDLE" >&2
    exit 1
  fi
}

build_and_stage() {
  local arch_flags=() universal=1
  local arch
  for arch in arm64 x86_64; do arch_flags+=(--arch "$arch"); done
  if ! swift build --package-path "$PACKAGE_DIR" --configuration release \
      --jobs 2 "${arch_flags[@]}"; then
    echo "warning: the universal build failed; falling back to this machine's architecture only." >&2
    echo "warning: the resulting artifact will not run on every supported Mac." >&2
    universal=0
    arch_flags=()
    swift build --package-path "$PACKAGE_DIR" --configuration release --jobs 2
  fi
  local build_bin_dir build_binary build_resources
  build_bin_dir="$(swift build --package-path "$PACKAGE_DIR" --configuration release ${arch_flags[@]+"${arch_flags[@]}"} --show-bin-path)"
  build_binary="$build_bin_dir/$EXECUTABLE_NAME"
  [[ -x "$build_binary" ]] || { echo "built executable not found: $build_binary" >&2; exit 1; }

  [[ ! -L "$DIST_DIR" ]] || { echo "refusing symlink dist directory: $DIST_DIR" >&2; exit 1; }
  [[ ! -L "$APP_BUNDLE" ]] || { echo "refusing symlink app bundle: $APP_BUNDLE" >&2; exit 1; }
  rm -rf "$APP_BUNDLE"
  mkdir -p "$APP_MACOS" "$APP_RESOURCES"
  cp "$build_binary" "$APP_MACOS/$EXECUTABLE_NAME"
  chmod +x "$APP_MACOS/$EXECUTABLE_NAME"
  embed_frameworks "$build_bin_dir"
  build_resources="$(find "$build_bin_dir" -maxdepth 1 -type d \( -name "*_$EXECUTABLE_NAME.bundle" -o -name "*_$EXECUTABLE_NAME.resources" \) -print -quit)"
  [[ -n "$build_resources" ]] || { echo "error: SwiftPM resource bundle not found in: $build_bin_dir" >&2; exit 1; }
  cp -R "$build_resources" "$APP_RESOURCES/"
  write_icon
  write_info_plist
  write_sparkle_plist_entries
  if [[ "$universal" == "1" ]]; then
    local archs
    archs="$(/usr/bin/lipo -archs "$APP_MACOS/$EXECUTABLE_NAME" 2>/dev/null || true)"
    echo "architectures: $archs"
    for arch in arm64 x86_64; do
      [[ " $archs " == *" $arch "* ]] || { echo "error: universal build is missing $arch: $archs" >&2; exit 1; }
    done
  fi
  echo "staged $APP_BUNDLE"
}

sign_app_bundle() {
  local identity
  identity="$(resolve_codesign_identity)"
  if [[ -n "$identity" ]]; then
    if sign_with_identity "$identity"; then
      echo "signed with $identity"
      verify_app_signature
      return 0
    fi
    echo "error: signing with '$identity' failed or timed out." >&2
    exit 1
  fi
  if [[ "$MODE" == "--build-only" && "${USAGEMONITOR_ALLOW_ADHOC_VALIDATION:-}" == "1" ]]; then
    if sign_with_identity "-"; then
      echo "signed ad-hoc for build-only structural validation"
      verify_app_signature
      echo "Team identity: UNVERIFIED (ad-hoc signature has no Developer Team ID)."
      return 0
    fi
    echo "error: ad-hoc structural validation signing failed." >&2
    exit 1
  fi
  echo "error: no Developer ID Application identity is available." >&2
  exit 1
}

sha_of() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

write_sha_file() {
  local file="$1" sha
  sha="$(sha_of "$file")"
  echo "$sha  $(basename "$file")" > "$file.sha256"
  echo "$sha"
}

# ditto is what Apple's own notarization documentation uses.  It keeps the
# bundle's symlinks and extended attributes, which a plain zip does not, and a
# mangled bundle is rejected before it is even examined.
write_zip() {
  rm -f "$ZIP_FILE"
  /usr/bin/ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_FILE"
  write_sha_file "$ZIP_FILE" >/dev/null
}

# Submits one file and refuses to continue unless Apple accepted it.  A
# rejection is printed in full, because the log is the only thing that says
# which of the hundred notarization rules was broken.
notarize_file() {
  local file="$1" response submission status
  echo "Submitting $(basename "$file") to Apple for notarization.  This takes a few minutes."
  if [[ "${#NOTARY_AUTH[@]}" -eq 0 ]]; then
    echo "error: no notarization credentials (NOTARY_KEY_PATH, NOTARY_KEY_ID, NOTARY_ISSUER_ID)." >&2
    exit 1
  fi
  if ! response="$(xcrun notarytool submit "$file" ${NOTARY_AUTH[@]+"${NOTARY_AUTH[@]}"} --wait --output-format json 2>/dev/null)"; then
    echo "notarization could not be submitted for $(basename "$file")." >&2
    echo "check NOTARY_KEY_PATH, NOTARY_KEY_ID and NOTARY_ISSUER_ID (an App Store Connect API key)." >&2
    exit 1
  fi
  submission="$(printf '%s' "$response" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
  status="$(printf '%s' "$response" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
  echo "notarization id:     $submission"
  echo "notarization status: $status"
  if [[ "$status" != "Accepted" ]]; then
    echo "notarization was not accepted for $(basename "$file").  Apple's log follows." >&2
    xcrun notarytool log "$submission" ${NOTARY_AUTH[@]+"${NOTARY_AUTH[@]}"} >&2 || true
    exit 1
  fi
}

# A dmg is what a person who is handed a link expects to double-click, and the
# Applications symlink beside the app is the drag-to-install gesture everyone
# already knows.
build_dmg() {
  local staging="$DIST_DIR/dmg-staging" identity
  rm -rf "$staging"
  mkdir -p "$staging"
  cp -R "$APP_BUNDLE" "$staging/$APP_NAME.app"
  ln -s /Applications "$staging/Applications"
  rm -f "$DMG_FILE"
  /usr/bin/hdiutil create -volname "Usage Monitor" -srcfolder "$staging" -ov -format UDZO "$DMG_FILE"
  rm -rf "$staging"
  identity="$(resolve_codesign_identity)"
  [[ -n "$identity" ]] || { echo "error: no Developer ID Application identity to sign the disk image." >&2; exit 1; }
  codesign_bounded --force --timestamp --sign "$identity" "$DMG_FILE"
  echo "signed $DMG_FILE with $identity"
}

package_dist() {
  build_and_stage
  sign_app_bundle
  write_zip
  echo "Packaged: $ZIP_FILE"
  echo "SHA-256:  $(sha_of "$ZIP_FILE")"
}

release_dist() {
  package_dist
  notarize_file "$ZIP_FILE"
  # Stapling writes Apple's ticket into the bundle, which is what lets a Mac
  # that is offline, or behind a firewall, still open it without a warning.
  /usr/bin/xcrun stapler staple "$APP_BUNDLE"
  # What a downloaded copy will face: Gatekeeper must accept the stapled app.
  /usr/sbin/spctl --assess --type execute -vv "$APP_BUNDLE"
  # The zip that was submitted holds the unstapled bundle, so it is rebuilt
  # from the stapled one.  Whoever downloads the zip gets the ticket too.
  write_zip
  build_dmg
  notarize_file "$DMG_FILE"
  /usr/bin/xcrun stapler staple "$DMG_FILE"
  /usr/sbin/spctl --assess --type open --context context:primary-signature -vv "$DMG_FILE"
  local zip_sha dmg_sha
  zip_sha="$(write_sha_file "$ZIP_FILE")"
  dmg_sha="$(write_sha_file "$DMG_FILE")"
  echo
  echo "Release artifacts in $DIST_DIR"
  echo "  UsageMonitor.zip  $zip_sha"
  echo "  UsageMonitor.dmg  $dmg_sha"
  echo "  version $(short_version) (build $(bundle_version))"
}

case "$MODE" in
  --build-only|build-only)
    build_and_stage
    sign_app_bundle
    ;;
  --release|release)
    release_dist
    ;;
  --help|-h|help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
