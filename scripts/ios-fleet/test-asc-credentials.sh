#!/usr/bin/env bash
# Exercise the production shell credential functions with generated keys and
# disposable process environments.  No reader, provider or native tool runs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/ship-testflight.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$tmp/home" "$tmp/tmp" "$tmp/bin"

# Only extract the existing production functions, never execute ship startup.
awk '
  /^(asc_cleanup|asc_credential_available|load_secrets|asc_latest_marketing_patch|asc_build_floor|sentry_project_for_app|upload_sentry_artifacts)\(\) \{/ { grab = 1 }
  grab { print }
  grab && /^\}/ { grab = 0 }
' "$script" > "$tmp/functions.sh"

cat > "$tmp/cases.cjs" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [root, fleet] = process.argv.slice(2);
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
const plainPem = key(), hostedPem = key();
const plain = { ASC_KEY_ID: "PLAIN001", ASC_ISSUER_ID: "plain-issuer", ASC_KEY_P8: plainPem };
const hosted = { APPLE_API_KEY_ID: "HOSTED001", APPLE_API_ISSUER_ID: "hosted-issuer", APPLE_API_KEY_P8_BASE64: Buffer.from(hostedPem).toString("base64") };
const marker = path.join(root, "tool-ran");
const home = path.join(root, "home");
const bin = path.join(root, "bin");
fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
for (const name of ["fleet-secrets", "infisical", "security", "curl", "sentry-cli"]) {
  const trap = '#!/bin/sh\nprintf ran > "$TRAP_MARKER"\nexit 91\n';
  fs.writeFileSync(path.join(bin, name), trap, { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".local", "bin", name), trap, { mode: 0o700 });
}
const named = path.join(root, "named.p8");
fs.writeFileSync(named, hostedPem, { mode: 0o600 });
fs.writeFileSync(path.join(root, "plain.p8"), plainPem, { mode: 0o600 });
fs.writeFileSync(path.join(root, "hosted.p8"), hostedPem, { mode: 0o600 });
fs.writeFileSync(path.join(root, "verify.cjs"), `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const hash = (s) => crypto.createHash("sha256").update(s.trim()).digest("hex");
assert.equal(hash(process.env.ASC_KEY_P8), hash(fs.readFileSync(process.argv[2], "utf8")));
assert.equal(hash(fs.readFileSync(process.env.ASC_KEY_PATH, "utf8")), hash(process.env.ASC_KEY_P8));
assert.equal(fs.statSync(process.env.ASC_KEY_PATH).mode & 511, 384);
assert.equal(fs.statSync(process.env.API_PRIVATE_KEYS_DIR).mode & 511, 448);
assert.ok(!process.argv.some((arg) => arg.includes(process.env.ASC_KEY_P8)));
`);
const base = {
  PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  HOME: home, TMPDIR: path.join(root, "tmp"), FLEET_DIR: fleet,
  ASC_NODE: process.execPath, NODE_EXE: process.execPath, FIXTURE_ROOT: root,
  TRAP_MARKER: marker, FLEET_SECRETS_BIN: path.join(bin, "fleet-secrets"),
  ASC_KEY_PATH: named
};
const setup = `set -euo pipefail
source "$FIXTURE_ROOT/functions.sh"
ASC_TMP_DIR=""; ASC_LINKED_KEY=""
log() { :; }; logerr() { :; }
asc_client() { printf ran > "$TRAP_MARKER"; return 91; }
trap asc_cleanup EXIT
`;
function run(tuple, body) {
  let output;
  try {
    output = execFileSync("/bin/bash", ["-c", setup + body], {
      env: { ...base, ...tuple }, encoding: "utf8", timeout: 15000,
      killSignal: "SIGKILL", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"]
    });
  } catch { throw new Error("isolated shell credential case failed"); }
  assert.equal(output, "");
  assert.ok(!fs.existsSync(marker), "a reader, provider or optional uploader ran");
  assert.deepEqual(fs.readdirSync(base.TMPDIR), [], "shell staging survived cleanup");
}
const reject = `load_secrets
[[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" && -z "\${ASC_KEY_P8:-}" ]]
`;
for (const tuple of [
  {}, { ASC_KEY_ID: "PARTIAL", APPLE_API_ISSUER_ID: "foreign", APPLE_API_KEY_P8_BASE64: hosted.APPLE_API_KEY_P8_BASE64 },
  { ...plain, ...hosted, APPLE_API_KEY_P8_BASE64: "invalid" },
  { ...plain, ...hosted, APPLE_API_KEY_ID: "invalid/id" },
  { ...plain, ASC_KEY_ID: "invalid/id" }, { ...plain, ASC_KEY_P8: "invalid" }
]) run(tuple, reject);
for (const [tuple, file, id] of [
  [plain, "plain.p8", "PLAIN001"], [{ ...plain, ...hosted }, "hosted.p8", "HOSTED001"],
  [{ ...plain, APPLE_API_KEY_ID: "PARTIAL" }, "plain.p8", "PLAIN001"],
  [{ ...hosted, APPLE_API_KEY_P8_BASE64: hostedPem }, "hosted.p8", "HOSTED001"]
]) run(tuple, `asc_credential_available
load_secrets
[[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ${id} ]]
"$NODE_EXE" "$FIXTURE_ROOT/verify.cjs" "$FIXTURE_ROOT/${file}"
asc_cleanup
[[ ! -e "$ASC_KEY_PATH" ]]
`);
run({}, `! asc_credential_available
! asc_latest_marketing_patch 0.1 IOS
! asc_build_floor 0.1.0 IOS
APP_KEY=usage; ARCHIVE_PATH="$HOME"
upload_sentry_artifacts
`);
console.log("ok: 11 isolated shell credential cases");
JS
node "$tmp/cases.cjs" "$tmp" "$here"

# The scanner that finds a command substitution which runs the key reader.
#
# It walks the file and matches the closing parenthesis of every
# substitution, so a capture is found whatever shape it has:  with or without
# a `||` after it, written on one line or across several, and with a nested
# substitution inside it.  The scan is exact, so the script as it stands is
# not flagged by a shape it does not have.
cat > "${tmp}/find-key-capture.cjs" <<'SCAN'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const offenders = [];
const lineOf = (index) => text.slice(0, index).split("\n").length;
let depth = 0;
let start = 0;
let quote = null;
for (let i = 0; i < text.length; i += 1) {
  const c = text[i];
  if (quote === "'") {
    //  Single quotes are literal in bash, so nothing inside them is a
    //  substitution.
    if (c === quote) quote = null;
    continue;
  }
  if (c === "\\") { i += 1; continue; }
  if (c === "`") {
    const end = text.indexOf("`", i + 1);
    if (end === -1) break;
    if (text.slice(i, end + 1).includes("asc-key.mjs")) offenders.push(lineOf(i));
    i = end;
    continue;
  }
  if (quote === "\"") {
    if (c === quote) { quote = null; continue; }
    if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
    if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
    if (c === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
    }
    continue;
  }
  if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
  if (c === "#") {
    //  A comment runs to the end of the line, and an apostrophe in it is an
    //  apostrophe, not the start of a quoted string.
    const end = text.indexOf("\n", i);
    i = end === -1 ? text.length : end;
    continue;
  }
  if (c === "\"" || c === "'") { quote = c; continue; }
  if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
  if (c === ")" && depth > 0) {
    depth -= 1;
    if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
  }
}
if (offenders.length) {
  console.error("the key reader is captured into a variable at line(s) " + offenders.join(", "));
  process.exit(1);
}
SCAN

# 2b. A staged key file is never read into a variable:  the shell that owns it
# only ever holds its path.
if ! node "${tmp}/find-key-capture.cjs" "$script"; then
  fail "ship-testflight.sh reads the key material into a variable"
fi

# 2b. The guard has teeth:  a capture in every shape is caught, and the ship
# script as it stands is not flagged.
for shape in plain plain-with-or split-across-lines nested; do
  cp "$script" "${tmp}/mutated.sh"
  case "$shape" in
    plain)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
    plain-with-or)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")" || rc=$?' >> "${tmp}/mutated.sh" ;;
    split-across-lines)
      printf '%s\n%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" \' '  read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
    nested)
      printf '%s\n' 'key="$(cd "$(dirname "$0")"; node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
  esac
  if node "${tmp}/find-key-capture.cjs" "${tmp}/mutated.sh" >/dev/null 2>&1; then
    fail "the capture guard did not catch a ${shape} capture"
  fi
done

# 4. Neither this test nor the ship script passes a credential to `env`, which
# would put it in the process arguments of every child.
for f in "$0" "$script"; do
  if grep -nE '(^|[[:space:]])env [^|]*ASC_KEY_P8=' "$f" >/dev/null; then
    fail "$(basename "$f") passes a credential through env arguments"
  fi
done

# 5. Nothing is created under the old secrets folder or ~/.appstoreconnect.
[[ ! -e "${tmp}/home/.secrets" ]] || fail "created the old secrets folder"
[[ ! -e "${tmp}/home/.appstoreconnect" ]] || fail "created ~/.appstoreconnect"

# 6. The script text itself no longer names the old folder as a source.
if grep -nE '(~|\$\{?HOME\}?)/\.secrets' "$script" >/dev/null; then
  fail "ship-testflight.sh still names the old secrets folder"
fi

# 7. The node client never reads a key path.  The file branch is gone from
# the client, so a named ASC_KEY_PATH is not a credential source there either.
if grep -nE 'process\.env\.ASC_KEY_PATH' "${here}/asc-api.mjs" >/dev/null; then
  fail "asc-api.mjs still reads ASC_KEY_PATH"
fi
if grep -nE 'fromFile\(|readFileSync\([^)]*[Kk]ey' "${here}/asc-api.mjs" >/dev/null; then
  fail "asc-api.mjs still reads a key file"
fi

# The version helpers run inside command substitutions, where load_secrets
# would write a temp key whose cleanup trap dies with the subshell.  They must
# check for a credential instead.
for fn in asc_next_shared_build asc_released_store_version; do
  body="$(awk -v f="$fn" '$0 ~ "^"f"\\(\\) \\{" {g=1} g {print} g && /^}/ {exit}' "$script")"
  [[ -n "$body" ]] || fail "could not read ${fn}"
  if grep -v '^[[:space:]]*#' <<<"$body" | grep -q 'load_secrets'; then
    fail "${fn} calls load_secrets inside a command substitution (leaks the temp key dir)"
  fi
  grep -q 'asc_credential_available' <<<"$body" || fail "${fn} does not check for a credential"
done

# The released-version helper keeps the client's reason and its auth status:
# a discarded stderr or a flattened status 4 hides a credential fault behind
# a generic "cannot read the released version".
body="$(awk '/^asc_released_store_version\(\) \{/ {g=1} g {print} g && /^}/ {exit}' "$script")"
if grep -v '^[[:space:]]*#' <<<"$body" | grep -q '2>/dev/null'; then
  fail "asc_released_store_version discards the client's stderr"
fi
grep -q 'return 4' <<<"$body" || fail "asc_released_store_version does not preserve the auth status 4"
grep -q 'released-store-version:\*' <<<"$body" || fail "asc_released_store_version does not log the client's reason"
if grep -q 'asc_released_store_version "\$ASC_PLATFORM" 2>/dev/null' "$script"; then
  fail "the fixed-version caller discards the released-version reason"
fi
unset body

echo "ok: ASC credential resolution (complete synced tuples only, a named path ignored, temp key removed)"
