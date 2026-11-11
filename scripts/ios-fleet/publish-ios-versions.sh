#!/usr/bin/env bash
# publish-ios-versions.sh — open a pull request that updates the public fleet
# iOS version manifest.
#
# Called by ship-testflight.sh after a successful upload.  Also safe to run by
# hand.  Never prints secret values.  A miss stays non-fatal for the ship.
#
# Usage:
#   bash scripts/ios-fleet/publish-ios-versions.sh \
#     --bundle-id com.example.app \
#     --version 0.1.0 \
#     [--build 202608211800] \
#     [--apple-id 1111111111] \
#     [--display-name "Example"] \
#     [--base-json path] [--out-json path] [--skip-push] [--skip-local-write]
#
# Writes a pull request against Simple-With-Us/AI-Fleet-Coordinator
# site/ios-versions.json.  The default branch's ruleset refuses a direct
# write, so this script never puts the file on that branch.
#
# THE TOKEN: the publish needs a credential that can open a pull request on
# AI-Fleet-Coordinator.  The ship workflow passes the fleet GH_PAT secret as
# GH_TOKEN.  The workflow GITHUB_TOKEN is contents:read on this repo and
# cannot write to another repository, so it is refused here.
#
# SAFETY: seed from the live manifest (or an explicit --base-json).  A local
# snapshot is not a seed.  Refuse to publish a document that drops apps.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${FLEET_DIR}/ios-app-versions.json"
REPO="${AFC_MANIFEST_REPO:-Simple-With-Us/AI-Fleet-Coordinator}"
REMOTE_PATH="site/ios-versions.json"
BASE_BRANCH="${AFC_MANIFEST_BRANCH:-main}"
PR_BRANCH_PREFIX="${AFC_MANIFEST_BRANCH_PREFIX:-ios-versions-publish}"

BUNDLE_ID=""
VERSION=""
BUILD=""
APPLE_ID=""
DISPLAY_NAME=""
BASE_JSON=""
OUT_JSON=""
SKIP_PUSH=0
SKIP_LOCAL_WRITE=0

need_arg() {
  if [[ "$2" -lt 2 || -z "${3:-}" || "$3" == --* ]]; then
    echo "error: $1 needs a value" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) need_arg "$1" "$#" "${2:-}"; BUNDLE_ID="$2"; shift 2 ;;
    --version) need_arg "$1" "$#" "${2:-}"; VERSION="$2"; shift 2 ;;
    --build) need_arg "$1" "$#" "${2:-}"; BUILD="$2"; shift 2 ;;
    --apple-id) need_arg "$1" "$#" "${2:-}"; APPLE_ID="$2"; shift 2 ;;
    --display-name) need_arg "$1" "$#" "${2:-}"; DISPLAY_NAME="$2"; shift 2 ;;
    --base-json) need_arg "$1" "$#" "${2:-}"; BASE_JSON="$2"; shift 2 ;;
    --out-json) need_arg "$1" "$#" "${2:-}"; OUT_JSON="$2"; shift 2 ;;
    --skip-push) SKIP_PUSH=1; shift ;;
    --skip-local-write) SKIP_LOCAL_WRITE=1; shift ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BUNDLE_ID" && -n "$VERSION" ]] || { echo "error: need --bundle-id and --version" >&2; exit 2; }
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+$ ]] || { echo "error: --bundle-id is not a bundle id" >&2; exit 2; }
if [[ -n "$APPLE_ID" && ! "$APPLE_ID" =~ ^[0-9]+$ ]]; then
  echo "error: --apple-id must be numeric" >&2
  exit 2
fi
if [[ "$VERSION" == *"(from IPA)"* || "$BUILD" == *"(from IPA)"* ]]; then
  echo "error: refusing to publish a placeholder version or build" >&2
  exit 1
fi
if [[ "$VERSION" == *" "* || "$VERSION" == *$'\n'* || "$VERSION" == *$'\t'* || "$BUILD" == *" "* || "$BUILD" == *$'\n'* || "$BUILD" == *$'\t'* || "$DISPLAY_NAME" == *$'\n'* ]]; then
  echo "error: refusing to publish a version, build, or display name that contains whitespace" >&2
  exit 1
fi

# GH_TOKEN is the fleet PAT.  GITHUB_TOKEN is the workflow's own read-only
# token and cannot open a pull request on another repository.
resolve_token() {
  if [[ -n "${GH_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "error: GITHUB_TOKEN cannot write to ${REPO}" >&2
    echo "error: pass the fleet GH_PAT secret as GH_TOKEN (the ship workflow does)" >&2
    return 1
  fi
  echo "error: GH_TOKEN is required to publish the manifest" >&2
  return 1
}

FETCHED_SHA=""
fetch_json_at() {
  local ref="$1" dest="$2" raw
  command -v gh >/dev/null 2>&1 || return 1
  raw="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=${ref}" 2>/dev/null || true)"
  [[ -n "$raw" ]] || return 1
  FETCHED_SHA="$(printf '%s' "$raw" | python3 -c '
import base64, json, sys
doc = json.load(sys.stdin)
sha, content = doc.get("sha"), doc.get("content")
if not isinstance(sha, str) or not sha or not isinstance(content, str) or not content:
    sys.exit(1)
text = base64.b64decode("".join(content.split()), validate=True).decode()
open(sys.argv[1], "w", encoding="utf-8").write(text)
print(sha)
' "$dest" 2>/dev/null)" || return 1
  [[ -n "$FETCHED_SHA" ]] || return 1
}

merge_doc() {
  python3 - "$1" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    print("error: base json is not an object", file=sys.stderr)
    sys.exit(1)
apps = data.get("apps")
if not isinstance(apps, dict) or not apps:
    print("error: base json has no apps; refusing to publish a one-app replacement", file=sys.stderr)
    sys.exit(1)
before = set(apps)
entry = dict(apps.get(bundle) or {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
lost = sorted(before - set(apps))
if lost:
    print("error: merge dropped apps: " + ", ".join(lost), file=sys.stderr)
    sys.exit(1)
data["apps"] = apps
data["schemaVersion"] = 1
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
}

docs_same() {
  python3 - "$1" "$2" <<'PY'
import json, sys
def strip(path):
    data = json.load(open(path, encoding="utf-8"))
    data.pop("updatedAt", None)
    return data
sys.exit(0 if strip(sys.argv[1]) == strip(sys.argv[2]) else 1)
PY
}

TMP_REMOTE=""
BASE_SNAPSHOT=""
TIP_JSON=""
MERGED_FILE=""
cleanup() {
  rm -f "${TMP_REMOTE:-}" "${BASE_SNAPSHOT:-}" "${TIP_JSON:-}" "${MERGED_FILE:-}"
}
trap cleanup EXIT

if [[ -z "$BASE_JSON" ]]; then
  TMP_REMOTE="$(mktemp)"
  if fetch_json_at "$BASE_BRANCH" "$TMP_REMOTE"; then
    BASE_JSON="$TMP_REMOTE"
  else
    echo "error: could not read the live manifest ${REPO}/${REMOTE_PATH}" >&2
    echo "error: refusing to seed from a local snapshot" >&2
    exit 1
  fi
fi

if [[ ! -f "$BASE_JSON" ]]; then
  echo "error: base json not found: ${BASE_JSON}" >&2
  exit 1
fi

BASE_SNAPSHOT="$(mktemp)"
cp "$BASE_JSON" "$BASE_SNAPSHOT"
BASE_JSON="$BASE_SNAPSHOT"

MERGED="$(merge_doc "$BASE_JSON")"

MERGED_FILE="$(mktemp)"
printf '%s\n' "$MERGED" >"$MERGED_FILE"
if docs_same "$BASE_JSON" "$MERGED_FILE"; then
  echo "version-manifest: ${BUNDLE_ID} ${VERSION}${BUILD:+ build ${BUILD}} is already recorded"
  if [[ -n "$OUT_JSON" && "$OUT_JSON" != "$BASE_JSON" ]]; then
    cp "$BASE_JSON" "$OUT_JSON"
  fi
  exit 0
fi

write_outputs() {
  local doc="$1"
  if [[ "$SKIP_LOCAL_WRITE" -eq 0 ]]; then
    printf '%s\n' "$doc" >"$LOCAL_JSON"
    echo "local-manifest-updated ${BUNDLE_ID} ${VERSION}"
  fi
  if [[ -n "$OUT_JSON" ]]; then
    printf '%s\n' "$doc" >"$OUT_JSON"
  fi
}

if [[ "$SKIP_PUSH" -eq 1 ]]; then
  write_outputs "$MERGED"
  echo "skip-push ${BUNDLE_ID} ${VERSION} apps=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("apps") or {}))' <<<"$MERGED")"
  exit 0
fi

resolve_token || exit 1
export GH_TOKEN
unset GITHUB_TOKEN || true

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh is not installed; the manifest was not published" >&2
  exit 1
fi

SAFE_BUNDLE="$(printf '%s' "$BUNDLE_ID" | tr -c 'A-Za-z0-9._-' '-')"
PR_BRANCH="${PR_BRANCH_PREFIX}/${SAFE_BUNDLE}"
PR_TITLE="chore: record ${BUNDLE_ID} ${VERSION} in the fleet iOS manifest"
# GitHub renders a no-break space plus a normal space between sentences.
SENTENCE_GAP="$(printf '\302\240 ')"
PR_BODY="Automated fleet iOS version manifest update for ${BUNDLE_ID} ${VERSION}.${SENTENCE_GAP}Published by scripts/ios-fleet/publish-ios-versions.sh as a pull request, because the manifest repository refuses a direct write to its default branch."

BASE_SHA="$(gh api "repos/${REPO}/git/ref/heads/${BASE_BRANCH}" --jq .object.sha)" || {
  echo "error: could not read ${REPO} ${BASE_BRANCH}" >&2
  exit 1
}

TIP_JSON="$(mktemp)"
if ! fetch_json_at "$BASE_SHA" "$TIP_JSON"; then
  echo "error: could not re-read ${REMOTE_PATH} at ${BASE_SHA}; refusing to publish a stale snapshot" >&2
  exit 1
fi
MERGED="$(merge_doc "$TIP_JSON")"
printf '%s\n' "$MERGED" >"$MERGED_FILE"

# The branch carries only this bundle's bump on top of the default branch.
# Resetting it does not drop another app's pending pull request.
if gh api "repos/${REPO}/git/ref/heads/${PR_BRANCH}" >/dev/null 2>&1; then
  gh api --method PATCH "repos/${REPO}/git/refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" -F force=true >/dev/null || {
    echo "error: could not move ${PR_BRANCH} onto ${BASE_BRANCH}" >&2
    exit 1
  }
else
  gh api --method POST "repos/${REPO}/git/refs" -f ref="refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" >/dev/null || {
    echo "error: could not create ${PR_BRANCH}" >&2
    exit 1
  }
fi

FILE_SHA="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=${PR_BRANCH}" --jq .sha 2>/dev/null || true)"
CONTENT_B64="$(printf '%s\n' "$MERGED" | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())')"
PUT_ARGS=(
  --method PUT
  "repos/${REPO}/contents/${REMOTE_PATH}"
  -f "message=chore: ${BUNDLE_ID} ${VERSION}"
  -f "content=${CONTENT_B64}"
  -f "branch=${PR_BRANCH}"
)
if [[ -n "$FILE_SHA" ]]; then
  PUT_ARGS+=(-f "sha=${FILE_SHA}")
fi
if [[ "$PR_BRANCH" == "$BASE_BRANCH" || "$PR_BRANCH" == "refs/heads/${BASE_BRANCH}" ]]; then
  echo "error: refusing to write the manifest onto ${BASE_BRANCH}" >&2
  exit 1
fi
gh api "${PUT_ARGS[@]}" >/dev/null || {
  echo "error: version-manifest publish failed (branch ${PR_BRANCH})" >&2
  exit 1
}

OWNER="${REPO%%/*}"
PR_NUMBER="$(gh api "repos/${REPO}/pulls?head=${OWNER}:${PR_BRANCH}&state=open" --jq '.[0].number' 2>/dev/null || true)"
if [[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]]; then
  gh api --method PATCH "repos/${REPO}/pulls/${PR_NUMBER}" -f title="$PR_TITLE" -f body="$PR_BODY" >/dev/null || {
    echo "error: version-manifest publish failed (could not update pull request ${PR_NUMBER})" >&2
    exit 1
  }
  PR_URL="https://github.com/${REPO}/pull/${PR_NUMBER}"
else
  PR_URL="$(gh api --method POST "repos/${REPO}/pulls" -f title="$PR_TITLE" -f head="$PR_BRANCH" -f base="$BASE_BRANCH" -f body="$PR_BODY" --jq .html_url)" || {
    echo "error: version-manifest publish failed (could not open the pull request)" >&2
    exit 1
  }
fi

write_outputs "$MERGED"
echo "version-manifest-pr ${PR_URL}"
