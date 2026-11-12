import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { collectorSentryConfig, enqueueCollectorSentry } from "./lib/collector-sentry-bridge.mjs";
import { DSH_LEGACY_PRODUCER_INSTANCE_ID, tokenEventsFromBreakdown } from "./lib/session-token-collectors.mjs";

const run = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const cases = [
  ["grok-usage-collector.mjs", "grok-build"],
  ["fx-usage-collector.mjs", "fx"],
  ["antigravity-session-collector.mjs", "antigravity-statusline"],
  ["deepseek-usage-collector.mjs", "deepseek-dsh"],
];

function rows(root) {
  const db = new DatabaseSync(join(root, "outbox.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT id,payload,state,sent_at FROM events ORDER BY id").all(); }
  finally { db.close(); }
}

async function fixture(script, producerId, check) {
  const home = await mkdtemp(join(tmpdir(), "idle-collector-sentry-"));
  const requests = join(home, "requests.jsonl");
  const hook = join(home, "fetch-fixture.mjs");
  const checkpoint = join(home, ".cache", "usage-monitor", "collector-state", `${producerId}.json`);
  const originalCheckpoint = JSON.stringify({ version: 1, producerId, successfulThrough: "2026-10-30T12:00:00.000Z" });
  await mkdir(dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, originalCheckpoint);
  await writeFile(hook, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
  const destination = new URL(url);
  if (destination.origin !== "http://127.0.0.1:4318" || !["/v1/logs", "/v1/traces"].includes(destination.pathname)) throw new Error("Unexpected fixture destination");
  const body = JSON.parse(options.body);
  const count = body.resourceLogs?.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords)).length ?? body.resourceSpans?.flatMap(r => r.scopeSpans.flatMap(s => s.spans)).length;
  appendFileSync(process.env.IDLE_FIXTURE_REQUESTS, JSON.stringify({ count }) + "\\n");
  if (process.env.IDLE_FIXTURE_FAIL === "1") return new Response("", { status: 503 });
  return new Response(JSON.stringify({ ok: true, received: count, written: count, ignored: 0 }), { status: 200 });
};\n`);
  const env = {
    PATH: "/usr/bin:/bin", HOME: home, USAGE_MACHINE_ID: "idle-test-host",
    GROK_HOME: join(home, "grok"), FX_HOME: join(home, "fx"),
    DSH_HOME: join(home, "dsh"), CLUTCH_DSH_HOME: join(home, "clutch-dsh"),
    ANTIGRAVITY_TELEMETRY_SNAPSHOT: join(home, "antigravity", "usage.jsonl"),
    COLLECTOR_SENTRY_ENABLED: "1", COLLECTOR_TELEMETRY_HUB_ENDPOINT: "http://127.0.0.1:4318",
    COLLECTOR_TELEMETRY_HUB_TOKEN: "synthetic-idle-source-bearer-0000000000000000",
    COLLECTOR_SENTRY_STATE_DIR: join(home, "outbox"), IDLE_FIXTURE_REQUESTS: requests,
  };
  // Missing sources produce no fresh events; only the existing durable spool can send.
  const instances = producerId === "deepseek-dsh" ? [env.USAGE_MACHINE_ID, DSH_LEGACY_PRODUCER_INSTANCE_ID] : [env.USAGE_MACHINE_ID];
  const roots = [];
  for (const producerInstanceId of instances) {
    const events = tokenEventsFromBreakdown({ producerId, provider: "openai", service: producerId,
      sessionKey: "fixture-session", occurredAtIso: "2026-10-30T11:00:00Z", model: "fixture-model",
      breakdown: { input: 42 }, extraId: "previously-queued" });
    const root = await enqueueCollectorSentry(events, { producerId, producerInstanceId }, collectorSentryConfig(env, producerId));
    roots.push({ root, before: rows(root) });
  }
  const invoke = (extraArgs = [], extraEnv = {}) => run(process.execPath,
    ["--import", hook, join(scripts, script), "--since", "2026-10-31T00:00:00Z", ...extraArgs],
    { env: { ...env, ...extraEnv }, timeout: 15000 });
  try {
    await check({ roots, invoke, requests });
    assert.equal(await readFile(checkpoint, "utf8"), originalCheckpoint, "explicit scan keeps its existing checkpoint bytes");
  } finally { await rm(home, { recursive: true, force: true }); }
}

for (const [script, producerId] of cases) {
  test(`${producerId}: idle invocation delivers pending rows with stable payloads and receipts`, () => fixture(script, producerId, async ({ roots, invoke, requests }) => {
    const { stdout } = await invoke();
    assert.match(stdout, /nothing to send/);
    assert.doesNotMatch(stdout, /ingest ack:/, "idle pass never posts fresh Usage Monitor telemetry");
    const sent = (await readFile(requests, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(sent.length, roots.length, "DeepSeek flushes current and historical instance spools independently");
    for (const { root, before } of roots) {
      const after = rows(root);
      assert.deepEqual(after.map(({ id, payload }) => ({ id, payload })), before.map(({ id, payload }) => ({ id, payload })));
      assert.ok(after.every(row => row.state === "sent" && row.sent_at > 0));
    }
  }));

  test(`${producerId}: idle dry run retains pending rows without delivery`, () => fixture(script, producerId, async ({ roots, invoke, requests }) => {
    await invoke(["--dry-run"]);
    await assert.rejects(readFile(requests), { code: "ENOENT" });
    for (const { root, before } of roots) assert.deepEqual(rows(root), before);
  }));
}

test("retryable idle delivery failure preserves pending identity for the next invocation", () => fixture(...cases[0], async ({ roots, invoke }) => {
  const { stdout } = await invoke([], { IDLE_FIXTURE_FAIL: "1" });
  assert.match(stdout, /delivery pending/);
  for (const { root, before } of roots) {
    const after = rows(root);
    assert.deepEqual(after.map(({ id, payload, state }) => ({ id, payload, state })), before.map(({ id, payload, state }) => ({ id, payload, state })));
    assert.ok(after.every(row => row.sent_at === null));
  }
  await invoke();
  for (const { root } of roots) assert.ok(rows(root).every(row => row.state === "sent"));
}));
