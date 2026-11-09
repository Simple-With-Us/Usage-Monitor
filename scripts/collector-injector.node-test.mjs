import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCollector, launchChild } from "./collector-injector.mjs";
import { resolveCollectorToken, configureCollectorSentryToken } from "./lib/run-session-token-collector.mjs";

const project = "86e35e51-91bc-4dfd-a045-4484726b9c40";
const metadata = { workspace: project, permissions: ["read"], scopes: [{ environment: "prod", secretPath: "/telemetry" }], expiresAt: "2999-01-01T00:00:00Z" };
const pairs = { kimi: ["KIMI_CODE_INGEST_TOKEN", "KIMI_CODE_TELEMETRY_HUB_TOKEN"], zcode: ["ZCODE_INGEST_TOKEN", "ZCODE_TELEMETRY_HUB_TOKEN"], "muse-code": ["MUSE_CODE_ACCESS_TOKEN", "MUSE_CODE_INGEST_TOKEN"] };
function fixture(t, auth = { token: "st.sentinel" }) {
  const dir = mkdtempSync(join(tmpdir(), "collector-injector-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth), { mode: 0o600 });
  return { dir, path };
}
const response = (body) => new Response(JSON.stringify(body));
function fakeFetch(profile, meta = metadata, rows = pairs[profile].map((secretKey) => ({ secretKey, secretValue: `value-${secretKey}` }))) {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); return response(calls.length === 1 ? meta : { secrets: rows }); };
  return { calls, fetchImpl };
}
test("all profiles use exact scope and isolated child environments", async (t) => {
  const { path } = fixture(t);
  for (const profile of Object.keys(pairs)) {
    const fake = fakeFetch(profile);
    const result = await prepareCollector({ profile, mode: "service-token", path, env: { HOME: "/home/test", NODE_OPTIONS: "sentinel", USAGE_INGEST_TOKEN: "sentinel", COLLECTOR_TELEMETRY_HUB_TOKEN: "sentinel" }, fetchImpl: fake.fetchImpl });
    assert.deepEqual(Object.keys(result.env).sort(), ["COLLECTOR_STRICT_INJECTED_SECRETS", "HOME", ...pairs[profile]].sort());
    assert.match(result.script, new RegExp(`${profile === "kimi" ? "kimi" : profile}-usage-collector\\.mjs$`));
    const query = new URL(fake.calls[1].url).searchParams;
    for (const [key, value] of Object.entries({ workspaceId: project, environment: "prod", secretPath: "/telemetry", include_imports: "false", recursive: "false", expandSecretReferences: "false" })) assert.equal(query.get(key), value);
    assert.equal(fake.calls[0].options.redirect, "error");
    assert.equal(fake.calls[1].options.redirect, "error");
  }
});
test("scope violations fail before fetching secrets", async (t) => {
  const { path } = fixture(t);
  for (const meta of [{ ...metadata, workspace: "wrong" }, { ...metadata, permissions: ["read", "write"] }, { ...metadata, permissions: ["*"] }, { ...metadata, scopes: [...metadata.scopes, ...metadata.scopes] }, { ...metadata, scopes: [{ environment: "prod", secretPath: "/*" }] }, { ...metadata, scopes: [{ environment: "dev", secretPath: "/telemetry" }] }, { ...metadata, expiresAt: "2000-01-01T00:00:00Z" }]) {
    const fake = fakeFetch("kimi", meta);
    await assert.rejects(prepareCollector({ profile: "kimi", mode: "service-token", path, env: {}, fetchImpl: fake.fetchImpl }));
    assert.equal(fake.calls.length, 1);
  }
});
test("raw ASCII service-token custody supports every profile without changing the file", async (t) => {
  const { path } = fixture(t);
  for (const ending of ["", "\n", "\r\n"]) {
    const raw = `st.raw-sentinel${ending}`;
    writeFileSync(path, raw);
    for (const profile of Object.keys(pairs)) {
      const fake = fakeFetch(profile);
      const result = await prepareCollector({ profile, mode: "service-token", path, env: {}, fetchImpl: fake.fetchImpl });
      assert.equal(fake.calls.length, 2);
      for (const call of fake.calls) assert.equal(call.options.headers.authorization, "Bearer st.raw-sentinel");
      assert.deepEqual(Object.keys(result.env).sort(), ["COLLECTOR_STRICT_INJECTED_SECRETS", ...pairs[profile]].sort());
      assert.equal(JSON.stringify(result).includes("st.raw-sentinel"), false);
      assert.equal(readFileSync(path, "utf8"), raw);
    }
  }
});
test("raw custody preserves metadata verification before secret lookup", async (t) => {
  const { path } = fixture(t);
  writeFileSync(path, "st.raw-sentinel");
  const fake = fakeFetch("kimi", { ...metadata, permissions: ["read", "write"] });
  await assert.rejects(prepareCollector({ profile: "kimi", mode: "service-token", path, env: {}, fetchImpl: fake.fetchImpl }), /service_token_verification_failed/);
  assert.equal(fake.calls.length, 1);
});
test("malformed raw custody and raw machine-identity custody fail before network", async (t) => {
  const { path, dir } = fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("network must not run"); };
  const run = (mode = "service-token", custodyPath = path) => prepareCollector({ profile: "kimi", mode, path: custodyPath, env: {}, fetchImpl });
  for (const raw of ["st.", " st.raw-sentinel", "st.raw sentinel", "st.raw\tsentinel", "st.raw\nsentinel", "st.raw-sentinel\n\n", "st.raw-sentinel\r\n\n", "st.raw-sentinel\r", "st.raw\0sentinel", "st.raw-\u00e9", "st.raw-\uFFFD", '"st.raw-sentinel"', "st." + "x".repeat(16384)]) {
    writeFileSync(path, raw);
    await assert.rejects(run());
  }
  writeFileSync(path, "st.raw-sentinel");
  await assert.rejects(run("machine-identity"));
  chmodSync(path, 0o644); await assert.rejects(run()); chmodSync(path, 0o600);
  const link = join(dir, "raw-link"); symlinkSync(path, link); await assert.rejects(run("service-token", link));
  writeFileSync(path, '{"token":"st.raw-sentinel","extra":"value"}'); await assert.rejects(run());
  assert.equal(calls, 0);
});
test("raw custody failures disclose neither custody bytes nor path", (t) => {
  const { path } = fixture(t);
  writeFileSync(path, "st.raw-sentinel\ninvalid");
  const result = spawnSync(process.execPath, [new URL("./collector-injector.mjs", import.meta.url).pathname, "kimi", "service-token", path], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Collector credential injection failed.");
  assert.equal(result.stderr.includes("raw-sentinel"), false);
  assert.equal(result.stderr.includes(path), false);
});
test("custody and ambiguous authentication fail before network", async (t) => {
  const { dir, path } = fixture(t);
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error(); };
  const run = (p, env = {}) => prepareCollector({ profile: "kimi", mode: "service-token", path: p, env, fetchImpl });
  await assert.rejects(run(path, { INFISICAL_TOKEN: "inherited" }));
  chmodSync(path, 0o644); await assert.rejects(run(path)); chmodSync(path, 0o600);
  const link = join(dir, "link"); symlinkSync(path, link); await assert.rejects(run(link));
  writeFileSync(path, '{"token":1}'); await assert.rejects(run(path));
  writeFileSync(path, '{"token":"st.a","token":"st.b"}'); await assert.rejects(run(path));
  assert.equal(calls, 0);
});
test("ingest endpoint must be the exact production URL before credentials are read", async (t) => {
  const { path } = fixture(t);
  for (const url of ["", "http://usage.jays.services/api/ingest/usage", "https://user@usage.jays.services/api/ingest/usage", "https://usage.jays.services:443/api/ingest/usage", "https://usage.jays.services/api/ingest/usage?x=1", "https://usage.jays.services/api/ingest/usage#x", "https://usage.jays.services/api/ingest/usage/", "https://elsewhere.invalid/api/ingest/usage"]) {
    let calls = 0;
    await assert.rejects(prepareCollector({ profile: "kimi", mode: "service-token", path, env: { USAGE_MONITOR_INGEST_URL: url }, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
  const fake = fakeFetch("kimi");
  const result = await prepareCollector({ profile: "kimi", mode: "service-token", path, env: { USAGE_MONITOR_INGEST_URL: "https://usage.jays.services/api/ingest/usage" }, fetchImpl: fake.fetchImpl });
  assert.equal(result.env.USAGE_MONITOR_INGEST_URL, "https://usage.jays.services/api/ingest/usage");
});
test("child launch forwards signals and exit without placing secrets in argv", async () => {
  const parent = new EventEmitter(); parent.execPath = "/installed/node"; parent.pid = 42;
  const selfSignals = []; parent.kill = (...args) => selfSignals.push(args);
  const child = new EventEmitter(); const forwarded = []; child.kill = (signal) => forwarded.push(signal);
  let invocation;
  const pending = launchChild({ script: "/runtime/scripts/kimi-usage-collector.mjs", args: ["--dry-run", "--debug"], env: { KIMI_CODE_INGEST_TOKEN: "sentinel" } }, { processImpl: parent, spawnImpl: (...args) => { invocation = args; return child; } });
  parent.emit("SIGINT"); parent.emit("SIGTERM");
  assert.deepEqual(forwarded, ["SIGINT", "SIGTERM"]);
  assert.deepEqual(invocation[1], ["/runtime/scripts/kimi-usage-collector.mjs", "--dry-run", "--debug"]);
  assert.equal(JSON.stringify(invocation.slice(0, 2)).includes("sentinel"), false);
  child.emit("exit", 7, null); assert.equal(await pending, 7);
  assert.equal(parent.listenerCount("SIGTERM"), 0);
  const second = new EventEmitter(); second.kill = () => {};
  const signalled = launchChild({ script: "x", env: {} }, { processImpl: parent, spawnImpl: () => second });
  second.emit("exit", null, "SIGTERM"); await signalled;
  assert.deepEqual(selfSignals, [[42, "SIGTERM"]]);
  for (const args of [["sentinel"], ["--dry-run", "--dry-run"], ["--since", "sentinel"]]) await assert.rejects(launchChild({ script: "x", args, env: {} }, { processImpl: parent, spawnImpl: () => { throw new Error("spawned"); } }), /invalid_arguments/);
});
test("templates select the injector and failures never print custody values", (t) => {
  const { path } = fixture(t);
  // muse-code is the exception: its template must NOT route through the
  // injector.  The Muse CLI rotates its Meta access token inside the
  // macOS keychain, so a provisioned copy goes stale and the collector reads
  // the keychain itself; its LaunchAgent invokes the collector directly.
  for (const profile of ["kimi", "zcode"]) {
    const template = readFileSync(new URL(`./com.jays.${profile}-usage-collector.plist.example`, import.meta.url), "utf8");
    assert.match(template, /collector-injector\.mjs/); assert.ok(template.includes(`<string>${profile}</string>`));
    assert.match(template, /<string>AUTH_MODE<\/string>/);
    assert.equal(template.includes("sentinel"), false);
  }
  const museCodeTemplate = readFileSync(new URL("./com.jays.muse-code-usage-collector.plist.example", import.meta.url), "utf8");
  assert.ok(museCodeTemplate.includes("muse-code-usage-collector.mjs"));
  assert.equal(museCodeTemplate.includes("collector-injector"), false);
  assert.equal(museCodeTemplate.includes("AUTH_MODE"), false);
  assert.equal(museCodeTemplate.includes("sentinel"), false);
  const result = spawnSync(process.execPath, [new URL("./collector-injector.mjs", import.meta.url).pathname, "kimi", "invalid", path], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.equal((result.stdout + result.stderr).includes("sentinel"), false);
});
test("malformed, duplicate, missing and unexpanded values fail closed", async (t) => {
  const { path } = fixture(t);
  const [a, b] = pairs.kimi;
  for (const rows of [[], [{ secretKey: a, secretValue: "ok" }], [{ secretKey: a, secretValue: "ok" }, { secretKey: a, secretValue: "again" }, { secretKey: b, secretValue: "ok" }], [{ secretKey: a, secretValue: "${prod.TOKEN}" }, { secretKey: b, secretValue: "ok" }], [{ secretKey: a, secretValue: 3 }]]) {
    const fake = fakeFetch("kimi", metadata, rows);
    await assert.rejects(prepareCollector({ profile: "kimi", mode: "service-token", path, env: {}, fetchImpl: fake.fetchImpl }));
  }
});
test("network, redirect and oversized responses fail closed", async (t) => {
  const { path } = fixture(t);
  for (const fetchImpl of [async () => { throw new Error("network"); }, async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }), async () => new Response("x".repeat(140000))]) await assert.rejects(prepareCollector({ profile: "kimi", mode: "service-token", path, env: {}, fetchImpl }));
});
test("machine identity logs in with explicit custody and strict lookup never calls fleet secrets", async (t) => {
  const { path } = fixture(t, { clientId: "app-id", clientSecret: "sentinel" });
  let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(options.redirect, "error"); return response(calls === 1 ? { accessToken: "machine-bearer" } : { secrets: pairs.kimi.map((secretKey) => ({ secretKey, secretValue: "value" })) }); };
  const result = await prepareCollector({ profile: "kimi", mode: "machine-identity", path, env: {}, fetchImpl });
  assert.equal(result.env.COLLECTOR_STRICT_INJECTED_SECRETS, "1");
  const lookup = () => { throw new Error("fleet-secrets called"); };
  assert.equal(resolveCollectorToken(["MISSING"], { env: result.env, fleetSecretsGet: lookup }), null);
  assert.equal(configureCollectorSentryToken(["MISSING"], { env: { COLLECTOR_STRICT_INJECTED_SECRETS: "1", COLLECTOR_SENTRY_ENABLED: "1", COLLECTOR_TELEMETRY_HUB_ENDPOINT: "https://example.invalid" }, fleetSecretsGet: lookup }), false);
});
