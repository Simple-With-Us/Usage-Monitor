#!/usr/bin/env bash
# test-ios-manual-signing.sh - Offline tests for the Usage Monitor manual
# Release signing path (docs/rollouts/2026-10-17-ios-autoship.md).
#
# The hosted ship cannot use Xcode automatic signing (the fleet API key gets
# HTTP 401 from developerservices2.apple.com), so Release signs with App Store
# profiles that scripts/ios-install-appstore-profiles.sh downloads.  The ship
# archives the CHECKED-IN project.pbxproj, so these tests pin project.yml, the
# generated pbxproj, the profile map and the workflow to each other, and drive
# the real installer against stubbed `node` and `security` to prove it fails
# closed when a profile is missing the App Group.  No network, no credentials,
# no xcodebuild, no App Store Connect.
#
# Usage: bash scripts/test-ios-manual-signing.sh
#
# ASCII-only (Apple bash 3.2 safe).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAP="${ROOT}/ios/UsageMonitor/appstore-profiles.json"
YML="${ROOT}/ios/UsageMonitor/project.yml"
PBX="${ROOT}/ios/UsageMonitor/UsageMonitor.xcodeproj/project.pbxproj"
WF="${ROOT}/.github/workflows/ios-ship.yml"
INSTALLER="${ROOT}/scripts/ios-install-appstore-profiles.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/manual-sign-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
check() { # check <name> <command...>
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}

for f in "$MAP" "$YML" "$PBX" "$WF" "$INSTALLER"; do
  [[ -f "$f" ]] || { echo "missing $f"; exit 1; }
done

# ---------------------------------------------------------------------------
# 1. Config agreement: map <-> project.yml <-> pbxproj <-> workflow
# ---------------------------------------------------------------------------
agreement() {
  python3 - "$MAP" "$YML" "$PBX" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
yml = open(sys.argv[2], encoding="utf-8").read()
pbx = open(sys.argv[3], encoding="utf-8").read()
want = {
    "com.simplewithus.usage.client.ios": "Usage Monitor Client App Store (API)",
    "com.simplewithus.usage.client.ios.widget": "Usage Monitor Client Widget App Store (API)",
    "com.simplewithus.usage.local.ios": "Usage Monitor Local App Store (API)",
}
errs = []
if m != want:
    errs.append("profile map differs from the expected three bundles: %r" % m)
for name in want.values():
    if yml.count('PROVISIONING_PROFILE_SPECIFIER: "%s"' % name) != 1:
        errs.append("project.yml must name %r exactly once" % name)
# every XCBuildConfiguration block in the pbxproj
blocks = re.findall(r"isa = XCBuildConfiguration;\s*buildSettings = \{(.*?)\n\t\t\t\};\s*name = (\w+);", pbx, re.S)
seen = {}
for body, cfg in blocks:
    bid = re.search(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", body)
    spec = re.search(r'PROVISIONING_PROFILE_SPECIFIER = "([^"]+)";', body)
    if cfg == "Debug" and spec:
        errs.append("Debug config must stay Automatic (found a profile specifier)")
    if cfg == "Release" and spec:
        b = bid.group(1).strip() if bid else None
        seen[b] = spec.group(1)
        if "CODE_SIGN_STYLE = Manual;" not in body:
            errs.append("Release %s has a specifier but is not Manual" % b)
        if 'CODE_SIGN_IDENTITY = "Apple Distribution";' not in body:
            errs.append("Release %s is not signed with Apple Distribution" % b)
if seen != want:
    errs.append("pbxproj Release specifiers %r != expected %r" % (seen, want))
print("\n".join(errs))
sys.exit(1 if errs else 0)
PY
}
check "map, project.yml and pbxproj agree on three manual Release profiles" agreement

check "every shipped Debug config still has no profile specifier (automatic for Xcode)" \
  bash -c "! python3 - '$PBX' <<'PY'
import re, sys
pbx = open(sys.argv[1], encoding='utf-8').read()
for body, cfg in re.findall(r'isa = XCBuildConfiguration;\s*buildSettings = \{(.*?)\n\t\t\t\};\s*name = (\w+);', pbx, re.S):
    if cfg == 'Debug' and 'PROVISIONING_PROFILE_SPECIFIER' in body:
        sys.exit(0)
sys.exit(1)
PY"

check "workflow turns manual signing on for both ships" \
  bash -c "[[ \$(grep -c 'IOS_MANUAL_SIGN: \"1\"' '$WF') -eq 2 ]]"
check "workflow requires the App Group on both ships" \
  bash -c "[[ \$(grep -c 'IOS_PROFILE_REQUIRE_APP_GROUPS: group.com.simplewithus.usage' '$WF') -eq 2 ]]"
check "workflow has no standing rate-gate override" \
  bash -c "! grep -E '^[[:space:]]+IOS_TF_MIN_INTERVAL_SEC:' '$WF'"
push_paths() {
  grep -qF -- "- 'ios/**'" "$WF" \
    && grep -qF -- "- 'scripts/ios-*.sh'" "$WF" \
    && grep -qF -- "- 'scripts/ios-fleet/**'" "$WF"
}
check "workflow keeps push paths on ios/** and the ship scripts" push_paths
check "workflow keeps fetch-depth 0, the scheduled gate and the dispatch trigger" \
  bash -c "grep -q 'fetch-depth: 0' '$WF' && grep -q 'ios-scheduled-ship-gate.sh' '$WF' && grep -q '^  workflow_dispatch:' '$WF'"
check "workflow publishes What to Test on both ships" \
  bash -c "[[ \$(grep -c 'IOS_TF_RELEASE_NOTES: \"1\"' '$WF') -eq 2 ]]"

# ---------------------------------------------------------------------------
# 2. Installer behaviour with stubbed node (asc-api) and security (cms -D)
# ---------------------------------------------------------------------------
STUB_ROOT="${TMP}/repo"
mkdir -p "${STUB_ROOT}/scripts/ios-fleet" "${STUB_ROOT}/ios/UsageMonitor" "${TMP}/bin"
cp "$INSTALLER" "${STUB_ROOT}/scripts/ios-install-appstore-profiles.sh"
cp "$MAP" "${STUB_ROOT}/ios/UsageMonitor/appstore-profiles.json"
: >"${STUB_ROOT}/scripts/ios-fleet/asc-api.mjs"

python3 - "${TMP}" "$MAP" <<'PY'
import base64, json, plistlib, sys
tmp, mp = sys.argv[1], sys.argv[2]
m = json.load(open(mp, encoding="utf-8"))
rows, included = [], []
for i, (bid, name) in enumerate(sorted(m.items())):
    rows.append({
        "id": "P%d" % i,
        "attributes": {
            "name": name,
            "profileState": "ACTIVE",
            "expirationDate": "2027-06-30T00:00:00.000+00:00",
            "profileContent": base64.b64encode(b"stub profile " + bid.encode()).decode(),
        },
        "relationships": {"bundleId": {"data": {"id": "B%d" % i}}},
    })
    included.append({"type": "bundleIds", "id": "B%d" % i, "attributes": {"identifier": bid}})
json.dump({"data": rows, "included": included}, open(tmp + "/profiles.json", "w"))
PY

# `node <client> GET ...` prints the canned JSON.
cat >"${TMP}/bin/node" <<EOF
#!/usr/bin/env bash
cat "${TMP}/profiles.json"
EOF
# `security cms -D -i <file>` prints a plist for the bundle named in the file.
cat >"${TMP}/bin/security" <<'EOF'
#!/usr/bin/env bash
file="${!#}"
bid="$(sed 's/^stub profile //' "$file")"
python3 - "$bid" "${STUB_GROUPS:-}" <<'PY'
import plistlib, sys, zlib
bid, groups = sys.argv[1], [g for g in sys.argv[2].split(",") if g]
plist = {
    "UUID": "00000000-0000-0000-0000-" + format(zlib.crc32(bid.encode()), "012d"),
    "Entitlements": {
        "application-identifier": "CC8UTF7ATG." + bid,
        "get-task-allow": False,
        "com.apple.security.application-groups": groups,
    },
    "DeveloperCertificates": [],
}
sys.stdout.buffer.write(plistlib.dumps(plist))
PY
EOF
chmod +x "${TMP}/bin/node" "${TMP}/bin/security"

run_installer() { # run_installer <groups-the-stub-profile-carries> <required-groups>
  STUB_GROUPS="$1" IOS_PROFILE_REQUIRE_APP_GROUPS="$2" IOS_PROFILE_SKIP_IDENTITY_CHECK=1 \
    IOS_PROFILES_DIR="${TMP}/installed" PATH="${TMP}/bin:${PATH}" \
    bash "${STUB_ROOT}/scripts/ios-install-appstore-profiles.sh" >"${TMP}/out.txt" 2>"${TMP}/err.txt"
}

rm -rf "${TMP}/installed"
run_installer "" "group.com.simplewithus.usage"
rc=$?
if [[ $rc -ne 0 ]] && grep -q "lacks App Group" "${TMP}/err.txt" && grep -q "Developer Portal" "${TMP}/err.txt"; then
  ok "installer fails closed with the owner step when a profile has no App Group"
else
  bad "installer fails closed with the owner step when a profile has no App Group (rc=$rc)"
fi

rm -rf "${TMP}/installed"
run_installer "group.com.simplewithus.usage" "group.com.simplewithus.usage"
rc=$?
installed="$(ls "${TMP}/installed" 2>/dev/null | wc -l | tr -d ' ')"
if [[ $rc -eq 0 && "$installed" == "3" ]]; then
  ok "installer installs all three profiles when each carries the App Group"
else
  bad "installer installs all three profiles when each carries the App Group (rc=$rc installed=$installed)"
fi

rm -rf "${TMP}/installed"
run_installer "" ""
rc=$?
if [[ $rc -eq 0 ]]; then
  ok "installer does not enforce groups when none are required"
else
  bad "installer does not enforce groups when none are required (rc=$rc)"
fi

echo
echo "passed ${pass}, failed ${fail}"
[[ $fail -eq 0 ]]
