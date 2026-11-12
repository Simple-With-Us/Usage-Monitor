// Fixture for the narrow resolveCollectorToken retirement change in
// scripts/lib/run-session-token-collector.mjs.  Runs the REAL module code
// against a stub Infisical CLI; no network, no real credentials, no
// fleet-secrets binary.  Synthetic marker strings prove error diagnostics
// never carry stderr/content through.
//
//   node scripts/__tests__/run-session-token-collector.fixture.mjs
//
// Exits 0 with "N/N checks passed"; any failure prints and exits 1.

import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureCollectorSentryToken, resolveCollectorToken } from "../lib/run-session-token-collector.mjs";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

const MARKER = "synthetic-secret-marker-9f27aa";
const work = mkdtempSync(join(tmpdir(), "rstc-fixture-"));
const stub = join(work, "infisical-stub.sh");
const recordFile = join(work, "invocations.log");

// Stub CLI: behavior keyed off STUB_MODE; records argv + selected env to a
// file so the fixture can assert spawn hygiene. Never prints MARKER to
// stdout; failure modes echo MARKER on stderr (must never surface).
writeFileSync(stub, `#!/bin/sh
echo "ARGS:$*" >> "${recordFile}"
echo "ENV:DOMAIN=[$INFISICAL_DOMAIN] API_URL=[$INFISICAL_API_URL] UA_CID=[$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID] UA_CS=[$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET] CID=[$INFISICAL_CLIENT_ID] CS=[$INFISICAL_CLIENT_SECRET] UA_AT=[$INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN] TOKEN=[$INFISICAL_TOKEN] LEGACY_TOKEN_SET=[\${TOKEN+x}]" >> "${recordFile}"
case "$STUB_MODE" in
  empty)   exit 0 ;;
  gakonly) case "$*" in *"--path=/global-api-keys"*) printf 'tok-from-gak' ;; *) exit 0 ;; esac ;;
  fail3)   echo "${MARKER}" >&2; exit 3 ;;
  fail1)   echo "${MARKER}" >&2; exit 1 ;;
  notfound) echo "Secret with name not found in path" >&2; exit 1 ;;
  missgak) case "$*" in *"--path=/global-api-keys"*) printf 'tok-from-gak' ;; *) echo "Secret with name not found in path" >&2; exit 1 ;; esac ;;
  secretenv) printf '%s\\n' "Message: Secret with name 'USAGE_INGEST_TOKEN' not found in environment 'prod'" "Response Code: 404 Not Found" >&2; exit 1 ;;
  secretdne) echo "error: Secret with name MISSING does not exist" >&2; exit 1 ;;
  friendly) echo "Secret \\"USAGE_INGEST_TOKEN\\" doesn't exist." >&2; exit 1 ;;
  theone) echo "The secret doesn't exist." >&2; exit 1 ;;
  folder) printf '%s\\n' "Folder with path '/' in environment 'prod' was not found" "Response Code: 404 Not Found" >&2; exit 1 ;;
  foldergak) case "$*" in *"--path=/global-api-keys"*) printf 'tok-from-gak' ;; *) printf '%s\\n' "Folder with path '/' not found" "Response Code: 404 Not Found" >&2; exit 1 ;; esac ;;
  project) printf '%s\\n' "${MARKER}" "Project with ID 'proj-stub' not found" "Response Code: 404 Not Found" >&2; exit 1 ;;
  envslug) printf '%s\\n' "Environment with slug 'prod' in project with ID 'proj-stub' not found" "Response Code: 404 Not Found" >&2; exit 1 ;;
  envfriendly) echo "Environment \\"prod\\" doesn't exist in project \\"fleet-ops\\"." >&2; exit 1 ;;
  projfriendly) echo "Project \\"fleet-ops\\" doesn't exist, or you don't have access to it." >&2; exit 1 ;;
  route) printf '%s\\n' "Message: Route GET:/api/v4/secrets?environment=prod&secretPath=%2F not found" "Response Code: 404 Not Found" >&2; exit 1 ;;
  statusonly) echo "Response Code: 404 Not Found" >&2; exit 1 ;;
  nosecret) echo "Argument 1 has no secret name" >&2; exit 1 ;;
  *)       exit 0 ;;
esac
`);
chmodSync(stub, 0o755);

function stubEnv(mode, extra = {}) {
  return {
    INFISICAL_BIN: stub,
    STUB_MODE: mode,
    ["INFISICAL" + "_TOKEN"]: "stub-scoped-credential",
    INFISICAL_FLEET_OPS_PROJECT_ID: "proj-stub",
    // adversarial inherited auth/domain inputs that must be scrubbed:
    INFISICAL_API_URL: "https://evil.example.invalid",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "ua-id",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "ua-secret",
    INFISICAL_CLIENT_ID: "cid",
    INFISICAL_CLIENT_SECRET: "cs",
    INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: "ua-at",
    TOKEN: "legacy-token",
    ...extra,
  };
}
function resetRecord() { writeFileSync(recordFile, ""); }
function record() { return existsSync(recordFile) ? readFileSync(recordFile, "utf8") : ""; }

// 1. env value wins; lookup must not run
{
  let called = 0;
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], {
    env: { USAGE_INGEST_TOKEN: "  env-token  " },
    fleetSecretsGet: () => { called++; return "lookup-token"; },
  });
  check("env value wins and is trimmed", v === "env-token");
  check("lookup not called when env has the value", called === 0);
}

// 2. per-name order: name1 env-then-lookup before name2
{
  const v = resolveCollectorToken(["PRODUCER_TOKEN", "USAGE_INGEST_TOKEN"], {
    env: { USAGE_INGEST_TOKEN: "usage-env" },
    fleetSecretsGet: (n) => (n === "PRODUCER_TOKEN" ? "producer-lookup" : null),
  });
  check("producer-scoped lookup beats unscoped env", v === "producer-lookup");
}

// 3. injected lookup compat (historical fleetSecretsGet option key)
{
  const v = resolveCollectorToken(["MISSING_ENV"], {
    env: {},
    fleetSecretsGet: (n) => (n === "MISSING_ENV" ? "injected-value" : null),
  });
  check("injected fleetSecretsGet still serves lookup", v === "injected-value");
}

// 4. env-only mode via fleetSecretsGet: () => null
{
  const v = resolveCollectorToken(["NOPE"], { env: {}, fleetSecretsGet: () => null });
  check("fleetSecretsGet: () => null gives env-only null", v === null);
}

// 5. default lookup with NO binding refuses before spawn
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], {
    env: { INFISICAL_BIN: stub, STUB_MODE: "gakonly" }, // no token/project
  });
  check("no binding -> null", v === null);
  check("no binding -> CLI never spawned", !record().includes("ARGS:"));
}

// 6. default lookup: confirmed miss (rc0+empty everywhere) -> null, both folders tried
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("empty") });
  check("rc0+empty in all folders -> null", v === null);
  const r = record();
  check("tried root then /global-api-keys in order",
    r.indexOf("--path=/ ") !== -1 && r.indexOf("--path=/global-api-keys") !== -1 &&
    r.indexOf("--path=/ ") < r.indexOf("--path=/global-api-keys"));
  check("argv carries --expand=false", r.includes("--expand=false"));
  check("argv carries --env=prod and --projectId", r.includes("--env=prod") && r.includes("--projectId=proj-stub"));
}

// 7. default lookup: value only in second folder
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("gakonly") });
  check("falls through to /global-api-keys value", v === "tok-from-gak");
}

// 8. default lookup: non-zero exit throws; stderr marker never in message
{
  let err = null;
  try { resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("fail3") }); }
  catch (e) { err = e; }
  check("exit 3 throws (fail-closed, not a miss)", err !== null);
  check("error carries whitelisted status(3)", !!err && err.message.includes("status(3)"));
  check("error carries binding hint for numeric status", !!err && err.message.includes("scoped token binding"));
  check("stderr marker never in error message", !!err && !err.message.includes(MARKER));
}
{
  let err = null;
  try { resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("fail1") }); }
  catch (e) { err = e; }
  check("exit 1 throws with status(1)", !!err && err.message.includes("status(1)"));
  check("exit 1 stderr marker never in message", !!err && !err.message.includes(MARKER));
}

// 8c. missing-secret non-zero exit is a confirmed miss, not a failure
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("notfound") });
  check("missing-secret exit 1 in all folders -> null (no throw)", v === null);
  const r = record();
  check("miss in root still falls through to /global-api-keys",
    r.indexOf("--path=/ ") !== -1 && r.indexOf("--path=/global-api-keys") !== -1);
}
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("missgak") });
  check("miss in root, value in /global-api-keys -> value returned", v === "tok-from-gak");
}
function expectMiss(mode, label) {
  resetRecord();
  let err = null;
  let value = "unset";
  try { value = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv(mode) }); }
  catch (e) { err = e; }
  check(`${label} is a miss, not a throw`, err === null && value === null);
  const calls = record().split("\n").filter((line) => line.startsWith("ARGS:")).length;
  check(`${label} still tries both folders`, calls === 2);
}
function expectScopeFailure(mode, label, forbidden) {
  resetRecord();
  let err = null;
  try { resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv(mode) }); }
  catch (e) { err = e; }
  check(`${label} throws`, err !== null && err.message.includes("status(1)"));
  check(`${label} keeps stderr out of the error`, !!err && forbidden.every((bit) => !err.message.includes(bit)));
  const calls = record().split("\n").filter((line) => line.startsWith("ARGS:")).length;
  check(`${label} stops on the first folder`, calls === 1);
}
for (const [mode, label] of [
  ["secretenv", "secret not found beside a 404 status line"],
  ["secretdne", "secret does not exist"],
  ["friendly", "quoted secret doesn't exist"],
  ["theone", "the secret doesn't exist"],
  ["folder", "folder not found beside a 404 status line"],
]) expectMiss(mode, label);
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("foldergak") });
  check("folder miss in root, value in /global-api-keys -> value returned", v === "tok-from-gak");
}
expectScopeFailure("project", "project not found", [MARKER, "proj-stub", "Not Found", "Project"]);
expectScopeFailure("envslug", "environment slug not found", ["prod", "proj-stub", "Not Found", "Environment"]);
expectScopeFailure("envfriendly", "environment doesn't exist", ["fleet-ops", "doesn't exist"]);
expectScopeFailure("projfriendly", "project doesn't exist", ["fleet-ops", "doesn't exist"]);
expectScopeFailure("route", "route not found", ["api/v4", "Not Found", "Route"]);
expectScopeFailure("statusonly", "bare 404 Not Found", ["Not Found", "404"]);
expectScopeFailure("nosecret", "no secret name is not a miss", ["secret name"]);
// 8d. strict injected-secrets gate skips the lookup entirely
{
  resetRecord();
  const v = resolveCollectorToken(["USAGE_INGEST_TOKEN"], {
    env: stubEnv("gakonly", { COLLECTOR_STRICT_INJECTED_SECRETS: "1" }),
  });
  check("COLLECTOR_STRICT_INJECTED_SECRETS=1 -> null, CLI never spawned",
    v === null && !record().includes("ARGS:"));
}

// 9. child env hygiene: domain pinned, alternate auth scrubbed, token passed
{
  resetRecord();
  try { resolveCollectorToken(["USAGE_INGEST_TOKEN"], { env: stubEnv("empty") }); } catch {}
  const r = record();
  check("INFISICAL_DOMAIN pinned", r.includes("DOMAIN=[https://app.infisical.com]"));
  check("INFISICAL_API_URL scrubbed", r.includes("API_URL=[]"));
  check("UA client id scrubbed", r.includes("UA_CID=[]"));
  check("UA client secret scrubbed", r.includes("UA_CS=[]"));
  check("CLIENT_ID scrubbed", r.includes("CID=[]"));
  check("CLIENT_SECRET scrubbed", r.includes("CS=[]"));
  check("UA access token scrubbed", r.includes("UA_AT=[]"));
  check("legacy TOKEN scrubbed", !r.includes("LEGACY_TOKEN_SET=[x]"));
  check("scoped INFISICAL_TOKEN passed through", r.includes("TOKEN=[stub-scoped-credential]"));
}

// 10a. caller contract: remote failure under name1 never masks name2 env
{
  resetRecord();
  const v = resolveCollectorToken(["PRODUCER_TOKEN", "USAGE_INGEST_TOKEN"], {
    env: stubEnv("fail1", { USAGE_INGEST_TOKEN: "usage-env-wins" }),
  });
  check("remote failure under name1 does not mask name2 env", v === "usage-env-wins");
}

// 10b. caller contract: injected throwing lookup + no env -> throws first failure
{
  let err = null;
  try {
    resolveCollectorToken(["A_TOKEN", "B_TOKEN"], {
      env: {},
      fleetSecretsGet: () => { throw new Error("inj-" + MARKER); },
    });
  } catch (e) { err = e; }
  check("all-fail lookup rethrows first failure", !!err && err.message === "inj-" + MARKER);
}
{
  // name1 lookup throws, name2 lookup has value -> name2 value returned
  const v = resolveCollectorToken(["A_TOKEN", "B_TOKEN"], {
    env: {},
    fleetSecretsGet: (n) => { if (n === "A_TOKEN") throw new Error("remote down"); return n === "B_TOKEN" ? "b-value" : null; },
  });
  check("name1 failure discarded when name2 yields value", v === "b-value");
}
{
  // producer precedence intact: name1 remote value still beats name2 env
  const v = resolveCollectorToken(["A_TOKEN", "USAGE_INGEST_TOKEN"], {
    env: { USAGE_INGEST_TOKEN: "unscoped-env" },
    fleetSecretsGet: (n) => (n === "A_TOKEN" ? "producer-remote" : null),
  });
  check("producer remote value still beats unscoped env", v === "producer-remote");
}
{
  // default scoped read: name1 fails remotely, name2 present in env -> env returned
  resetRecord();
  const v = resolveCollectorToken(["PRODUCER_TOKEN", "USAGE_INGEST_TOKEN"], {
    env: stubEnv("fail3", { USAGE_INGEST_TOKEN: "env-fallback" }),
  });
  check("status(3) under name1 does not mask name2 env", v === "env-fallback");
}

// 10. invalid secret name never reaches the CLI
{
  resetRecord();
  const v = resolveCollectorToken(["BAD-NAME!"], { env: stubEnv("empty") });
  check("invalid name -> null, no spawn", v === null && !record().includes("ARGS:"));
}

// 12. configureCollectorSentryToken: a failing lookup degrades to false
// instead of throwing (telemetry is optional; collection must continue)
{
  resetRecord();
  const env = stubEnv("fail3", {
    COLLECTOR_SENTRY_ENABLED: "1",
    COLLECTOR_TELEMETRY_HUB_ENDPOINT: "https://hub.invalid",
  });
  let outcome = null;
  let threw = false;
  try {
    outcome = configureCollectorSentryToken(["USAGE_INGEST_TOKEN"], { env });
  } catch { threw = true; }
  check("sentry token lookup failure does not throw", !threw);
  check("sentry token lookup failure returns false", outcome === false);
  check("sentry token env left unset on failure", !env.COLLECTOR_TELEMETRY_HUB_TOKEN);
}

// 13. configureCollectorSentryToken: a resolvable token is loaded
{
  const env = stubEnv("gakonly", {
    COLLECTOR_SENTRY_ENABLED: "1",
    COLLECTOR_TELEMETRY_HUB_ENDPOINT: "https://hub.invalid",
  });
  const ok = configureCollectorSentryToken(["USAGE_INGEST_TOKEN"], { env });
  check("sentry token loaded from second folder", ok === true && env.COLLECTOR_TELEMETRY_HUB_TOKEN === "tok-from-gak");
}

rmSync(work, { recursive: true, force: true });
console.log(`${passed + failed} checks, ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
