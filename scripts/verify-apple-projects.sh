#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const appSource = readFileSync("ios/UsageMonitor/App/UsageMonitorApp.swift", "utf8");
const spec = readFileSync("ios/UsageMonitor/project.yml", "utf8");
const appProject = readFileSync("ios/UsageMonitor/UsageMonitor.xcodeproj/project.pbxproj", "utf8");
const manifest = JSON.parse(readFileSync("chrome-extension/manifest.json", "utf8"));
const safariProjectPath = "safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj/project.pbxproj";
const safariHandlerPath = "safari-extension/Usage Monitor Safari/Shared (Extension)/SafariWebExtensionHandler.swift";

check(/^import Networking$/m.test(appSource), "UsageMonitorApp must import Networking");
check(!/CODE_SIGNING_ALLOWED:\s*NO/.test(spec), "project.yml must not permanently disable signing");
check(!/CODE_SIGNING_ALLOWED = NO;/.test(appProject), "generated app project must allow Archive signing");
check((spec.match(/DEVELOPMENT_TEAM:\s*CC8UTF7ATG/g) ?? []).length >= 2,
  "app and widget targets must retain the release signing team");

check(existsSync(safariProjectPath), "universal Safari extension project is missing");
const safariProject = readFileSync(safariProjectPath, "utf8");
check(safariProject.includes("Usage Monitor Safari Extension (iOS)"), "Safari iOS extension target missing");
check(safariProject.includes("Usage Monitor Safari Extension (macOS)"), "Safari macOS extension target missing");
check(safariProject.includes("../../../chrome-extension/popup"), "Safari must share the reviewed launcher popup");
check(safariProject.includes("../../../chrome-extension/manifest.json"), "Safari must share the reviewed manifest");
check(!safariProject.includes("../../../chrome-extension/README.md"), "Safari must not bundle repository prose");
check(!safariProject.includes("../../../chrome-extension/scripts"), "Safari project must not retain deleted script references");
check(!safariProject.includes("../../../chrome-extension/icons"), "Safari project must not retain missing icon references");
check((safariProject.match(/DEVELOPMENT_TEAM = CC8UTF7ATG;/g) ?? []).length >= 2,
  "Safari Debug and Release must retain the release signing team");

check(JSON.stringify(manifest.permissions ?? []) === JSON.stringify(["storage"]),
  "launcher may request only storage permission");
check((manifest.host_permissions ?? []).length === 0, "launcher must request no host permissions");
check((manifest.content_scripts ?? []).length === 0, "launcher must inject no content scripts");
check(manifest.background === undefined, "launcher must have no background worker");

const safariHandler = readFileSync(safariHandlerPath, "utf8");
check(!safariHandler.includes("inputItems"), "Safari native handler must not inspect browser messages");
check(!safariHandler.includes("os_log"), "Safari native handler must not log browser messages");
NODE

if [[ "${APPLE_STRUCTURE_ONLY:-0}" == "1" ]] || ! command -v xcodebuild >/dev/null 2>&1; then
  echo "Apple project structure verified; native builds skipped on this runner."
  exit 0
fi

derived="${RUNNER_TEMP:-/tmp}/usage-monitor-apple-derived"
build_arch="$(uname -m)"
rm -rf "$derived"

xcodebuild \
  -project ios/UsageMonitor/UsageMonitor.xcodeproj \
  -scheme UsageMonitor \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived/ios-app" \
  ARCHS="$build_arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build-for-testing

xcodebuild \
  -project ios/UsageMonitor/UsageMonitor.xcodeproj \
  -scheme UsageMonitor \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived/ios-release" \
  ARCHS="$build_arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build

(
  cd ios/UsageMonitor/UsageMonitorKit
  xcodebuild \
    -scheme UsageMonitorKit-Package \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived/kit-tests" \
    ARCHS="$build_arch" ONLY_ACTIVE_ARCH=YES \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    build-for-testing
)

safari_project="safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj"
xcodebuild \
  -project "$safari_project" \
  -scheme 'Usage Monitor Safari (iOS)' \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived/safari-ios" \
  ARCHS="$build_arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build

xcodebuild \
  -project "$safari_project" \
  -scheme 'Usage Monitor Safari (macOS)' \
  -configuration Debug \
  -destination 'generic/platform=macOS' \
  -derivedDataPath "$derived/safari-macos" \
  ARCHS="$build_arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build
