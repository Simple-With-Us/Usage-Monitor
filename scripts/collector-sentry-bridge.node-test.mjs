import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectorSentryConfig, collectorSentryEvents, enqueueCollectorSentry, drainCollectorSentry, pruneCollectorSentryReceipts, retryCollectorSentryQuarantine } from "./lib/collector-sentry-bridge.mjs";
import { tokenEventsFromBreakdown, parseClaudeSessionJsonl, postUsageBatches } from "./lib/session-token-collectors.mjs";

const identity = { producerId: "claude-code", producerInstanceId: "test-host" };
function tokens(extra = {}) {
  return tokenEventsFromBreakdown({ producerId: "claude-code", provider: "anthropic", service: "claude-code", sessionKey: "private/session", occurredAtIso: "2026-10-30T12:00:00Z", model: "claude-test", breakdown: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 }, extraId: "message", ...extra });
}
async function fixture(fn) {
  const stateRoot = await mkdtemp(join(tmpdir(), "collector-sentry-"));
  const config = { stateRoot, endpoint: "https://example.sentry.io/api/1/integration/otlp", publicKey: "abc123" };
  try { await fn(config); } finally { await rm(stateRoot, { recursive: true, force: true }); }
}
const accepted = async () => new Response("{}", { status: 200 });

test("configuration is explicit, project scoped and refuses non-Sentry destinations", () => {
  assert.equal(collectorSentryConfig({}), null);
  assert.throws(() => collectorSentryConfig({ COLLECTOR_SENTRY_ENABLED: "1", SENTRY_OTLP_ENDPOINT: "https://sentry.io.evil.test", SENTRY_PUBLIC_KEY: "abc" }));
  assert.throws(() => collectorSentryConfig({ COLLECTOR_SENTRY_ENABLED: "1", SENTRY_OTLP_ENDPOINT: "https://example.sentry.io?token=secret", SENTRY_PUBLIC_KEY: "abc" }));
  const env = { COLLECTOR_SENTRY_ENABLED: "1", COLLECTOR_TELEMETRY_HUB_ENDPOINT: "http://127.0.0.1:4318", COLLECTOR_TELEMETRY_HUB_TOKENS_JSON: JSON.stringify({ "claude-code": "test-only-scoped-source-bearer-00000000000000" }) };
  assert.equal(collectorSentryConfig(env, "claude-code").destination, "hub");
  assert.equal(collectorSentryConfig(env, "openai-codex"), null);
  const ipv6 = collectorSentryConfig({ ...env, COLLECTOR_TELEMETRY_HUB_ENDPOINT: "http://[::1]:4318" }, "claude-code");
  assert.equal(new URL(ipv6.endpoint).hostname, "[::1]");
  assert.throws(() => collectorSentryConfig({ ...env, COLLECTOR_TELEMETRY_HUB_ENDPOINT: "http://localhost:4318" }, "claude-code"));
  assert.equal(collectorSentryConfig({ ...env, COLLECTOR_TELEMETRY_HUB_ENDPOINT: "https://localhost:4318" }, "claude-code").destination, "hub");
});

test("maintenance rejects missing outboxes without creating files", () => fixture(async (config) => {
  const missing = join(config.stateRoot, "mistyped-outbox");
  await assert.rejects(pruneCollectorSentryReceipts(missing, { successfulThrough: new Date(Date.now() - 1000).toISOString() }), { code: "ENOENT" });
  await assert.rejects(retryCollectorSentryQuarantine(missing, "a".repeat(64)), { code: "ENOENT" });
  await assert.rejects(stat(missing), { code: "ENOENT" });
}));

test("poison isolation bounds requests while healthy rows remain pending and eventually deliver", () => fixture(async (config) => {
  const events = Array.from({ length: 16 }, (_, i) => tokens({ collectorCallId: `call-${i}`, extraId: `call-${i}`, model: i === 15 ? "good-model" : "bad-model" })).flat();
  const root = await enqueueCollectorSentry(events, identity, config);
  let delivered = 0;
  let quarantined = 0;
  let pending = true;
  for (let invocation = 0; invocation < 40 && pending; invocation += 1) {
    let requests = 0;
    const result = await drainCollectorSentry(root, config, { requestLimit: 1, fetchImpl: async (_url, options) => {
      requests += 1;
      const payload = JSON.parse(options.body);
      const spans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
      const poisoned = spans.some((span) => span.attributes.some((a) => a.key === "gen_ai.request.model" && a.value.stringValue === "bad-model"));
      return poisoned ? new Response("", { status: 422 }) : accepted();
    } });
    assert.ok(requests <= 1);
    delivered += result.delivered;
    quarantined += result.quarantined;
    pending = result.pending && (quarantined < 15 || delivered < 1);
  }
  assert.equal(delivered, 1);
  assert.equal(quarantined, 15);
}));

test("claim honors narrowed rows beyond the pending head", () => fixture(async (config) => {
  const events = [0, 1, 2].flatMap((i) => tokens({ collectorCallId: `window-${i}`, extraId: `window-${i}` }));
  const root = await enqueueCollectorSentry(events, identity, config);
  const db = new DatabaseSync(join(root, "outbox.sqlite"));
  db.exec("UPDATE events SET retry_batch_size=1 WHERE rowid=(SELECT rowid FROM events ORDER BY rowid LIMIT 1 OFFSET 1)");
  db.close();
  let batchLength;
  const result = await drainCollectorSentry(root, config, { requestLimit: 1, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    batchLength = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)).length;
    return accepted();
  } });
  assert.equal(batchLength, 1);
  assert.equal(result.delivered, 1);
  assert.equal(result.pending, true);
}));

test("only authoritative source calls become spans; serialization and IDs remain unchanged", () => {
  const plain = tokens();
  const known = tokens({ collectorCallId: "message-id", extraMetadata: { prompt: "PRIVATE_CONTENT", response: "PRIVATE_CONTENT", sessionId: "PRIVATE_CONTENT" } });
  assert.equal(collectorSentryEvents(plain, identity).length, 4);
  assert.ok(collectorSentryEvents(plain, identity).every((row) => row.kind === "log"));
  const [span] = collectorSentryEvents([...known, ...known], identity);
  assert.equal(span.kind, "span");
  assert.equal(collectorSentryEvents(known, identity).length, 1);
  assert.equal(span.attributes.find((attr) => attr.key === "gen_ai.usage.input_tokens").value.intValue, "10");
  assert.ok(!JSON.stringify(span).includes("PRIVATE_CONTENT"));
  assert.deepEqual(tokens({ collectorCallId: "message-id" }), plain);
  assert.equal(JSON.stringify(tokens({ collectorCallId: "message-id" })), JSON.stringify(plain));
  const unknownVendor = collectorSentryEvents(tokens({ provider: "unknown", collectorCallId: "call" }), identity)[0];
  assert.equal(unknownVendor.attributes.find((attr) => attr.key === "agent.platform").value.stringValue, "claude-code");
  assert.ok(!unknownVendor.attributes.some((attr) => attr.key === "gen_ai.system"));
  const [timed] = collectorSentryEvents(tokens({ collectorCallId: "timed", extraMetadata: { durationMs: 250 } }), identity);
  assert.equal(timed.ts, "2026-10-30T11:59:59.750Z");
});

test("Claude content-block fragmentation produces one call with complete split input", () => {
  const row = { type: "assistant", sessionId: "private", timestamp: "2026-10-30T12:00:00Z", message: { id: "msg-source", model: "claude-test", usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 10 } } };
  const events = parseClaudeSessionJsonl([row, row, row].map(JSON.stringify).join("\n"), { sessionKey: "private" });
  const output = collectorSentryEvents(events, identity);
  assert.equal(output.length, 1);
  assert.equal(output[0].kind, "span");
  assert.equal(output[0].attributes.find((a) => a.key === "gen_ai.usage.input_tokens").value.intValue, "20");
});

test("distinct output fragments accumulate reasoning once per deduped event", () => {
  const first = tokens({ collectorCallId: "fragmented-call", extraId: "fragment-one", extraMetadata: { reasoningTokens: 2 } });
  const second = tokens({ collectorCallId: "fragmented-call", extraId: "fragment-two", extraMetadata: { reasoningTokens: 3 } });
  const [span] = collectorSentryEvents([...first, ...second, ...first, ...second], identity);
  assert.equal(span.attributes.find((attr) => attr.key === "gen_ai.usage.output_tokens").value.intValue, "40");
  assert.equal(span.attributes.find((attr) => attr.key === "gen_ai.usage.reasoning_count").value.stringValue, "5");
});

test("outbox retries after restart and sent receipts suppress collector replay", () => fixture(async (config) => {
  const events = tokens({ collectorCallId: "call" });
  const root = await enqueueCollectorSentry(events, identity, config);
  assert.equal((await stat(join(root, "outbox.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => new Response("", { status: 503 }) })).pending, true);
  let requests = 0;
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => { requests += 1; return accepted(); } })).delivered, 1);
  await enqueueCollectorSentry(events, identity, config);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => { requests += 1; return accepted(); } })).delivered, 0);
  assert.equal(requests, 1);
}));

test("partial rejection isolates a durable quarantine and malformed responses retain pending rows", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens({ collectorCallId: "call" }), identity, config);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => new Response('{"partialSuccess":{"rejectedSpans":"1"}}') })).quarantined, 1);
  await enqueueCollectorSentry(tokens({ collectorCallId: "second", extraId: "second" }), identity, config);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => new Response("invalid-json") })).pending, true);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: accepted })).delivered, 1);
}));

test("malformed OTLP ACK fields remain pending without quarantining or acknowledging", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens({ collectorCallId: "call" }), identity, config);
  for (const body of [null, [], { partialSuccess: { rejectedSpans: -1 } }, { partialSuccess: { rejectedSpans: 2 } }, { partialSuccess: { rejectedSpans: true } }, { partialSuccess: { rejectedSpans: "not-a-count" } }, { partialSuccess: { rejectedSpans: "9007199254740992" } }, { partialSuccess: { rejectedLogRecords: 1 } }]) {
    const result = await drainCollectorSentry(root, config, { fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.equal(result.delivered, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(result.pending, true);
  }
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: accepted })).delivered, 1);
}));

test("hub ACK schema rejects invalid counters and incomplete counts without quarantine", () => fixture(async (base) => {
  const config = { ...base, destination: "hub", token: "test-only-bearer-00000000000000000000" };
  const root = await enqueueCollectorSentry(tokens({ collectorCallId: "call" }), identity, config);
  const good = { ok: true, received: 1, written: 1, ignored: 0 };
  for (const body of [{ ...good, ok: false }, { ...good, received: "1" }, { ...good, written: -1 }, { ...good, written: 0 }, { ...good, ignored: 0.5 }, { ...good, received: 2 }, { ...good, ignored: 1 }, { ...good, unexpected: true }]) {
    const result = await drainCollectorSentry(root, config, { fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.equal(result.delivered, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(result.pending, true);
  }
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => new Response(JSON.stringify(good)) })).delivered, 1);
}));

test("coherent partial hub ACKs durably narrow and isolate only the ignored row", () => fixture(async (base) => {
  const config = { ...base, destination: "hub", token: "test-only-bearer-00000000000000000000" };
  const root = await enqueueCollectorSentry([0, 1, 2].flatMap((i) => tokens({ collectorCallId: `partial-hub-${i}`, extraId: `partial-hub-${i}`, model: i === 1 ? "bad-model" : "good-model" })), identity, config);
  let delivered = 0;
  let quarantined = 0;
  for (let invocation = 0; invocation < 20 && (delivered < 2 || quarantined < 1); invocation += 1) {
    let requests = 0;
    const result = await drainCollectorSentry(root, config, { requestLimit: 1, fetchImpl: async (_url, options) => {
      requests += 1;
      const payload = JSON.parse(options.body);
      const spans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
      const ignored = spans.filter((span) => span.attributes.some((a) => a.key === "gen_ai.request.model" && a.value.stringValue === "bad-model")).length;
      return Response.json({ ok: true, received: spans.length - ignored, written: spans.length - ignored, ignored });
    } });
    assert.ok(requests <= 1);
    delivered += result.delivered;
    quarantined += result.quarantined;
  }
  assert.equal(delivered, 2);
  assert.equal(quarantined, 1);
}));

test("one rejected observation is isolated without blocking the remaining records", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens(), identity, config);
  const result = await drainCollectorSentry(root, config, { fetchImpl: async (_url, init) => {
    const logs = JSON.parse(init.body).resourceLogs[0].scopeLogs[0].logRecords;
    const rejected = logs.some((record) => record.attributes.some((attr) => attr.key === "gen_ai.usage.input_tokens"));
    return new Response(rejected ? "" : "{}", { status: rejected ? 400 : 200 });
  } });
  assert.equal(result.delivered, 3);
  assert.equal(result.quarantined, 1);
  assert.equal(result.pending, true);
  const db = new DatabaseSync(join(root, "outbox.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE state='quarantined'").get().n, 1);
  const id = db.prepare("SELECT id FROM events WHERE state='quarantined'").get().id;
  db.close();
  assert.equal((await retryCollectorSentryQuarantine(root, id)).requeued, 1);
  assert.equal((await drainCollectorSentry(root, config, { fetchImpl: accepted })).delivered, 1);
}));

test("concurrent drains claim once; dead workers are recovered without stealing live claims", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens({ collectorCallId: "call" }), identity, config);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let sends = 0;
  const first = drainCollectorSentry(root, config, { fetchImpl: async () => { sends += 1; started(); await held; return accepted(); } });
  await ready;
  const second = await drainCollectorSentry(root, config, { fetchImpl: async () => { sends += 1; return accepted(); } });
  assert.equal(second.delivered, 0);
  release();
  await first;
  assert.equal(sends, 1);
  const db = new DatabaseSync(join(root, "outbox.sqlite"));
  db.exec("UPDATE events SET state='sending', owner='dead-worker', pid=2147483647");
  db.close();
  assert.equal((await drainCollectorSentry(root, config, { isAlive: () => false, fetchImpl: accepted })).delivered, 1);
}));

test("PID reuse recovers ownership only after process birth changes", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens({ collectorCallId: "call" }), identity, config);
  const db = new DatabaseSync(join(root, "outbox.sqlite"));
  db.exec("UPDATE events SET state='sending', owner='old-process', pid=123, birth='old-birth'");
  db.close();
  assert.equal((await drainCollectorSentry(root, config, { isAlive: () => true, birthOf: () => "old-birth", fetchImpl: accepted })).delivered, 0);
  assert.equal((await drainCollectorSentry(root, config, { isAlive: () => true, birthOf: () => "new-birth", fetchImpl: accepted })).delivered, 1);
}));

test("birth probes run off the writer lease once per PID and recovery does not steal replaced ownership", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens(), identity, config);
  const path = join(root, "outbox.sqlite");
  const seeded = new DatabaseSync(path);
  seeded.exec("UPDATE events SET state='sending', owner='old-owner', pid=123, birth='old-birth'");
  seeded.close();
  let otherProbes = 0;
  const result = await drainCollectorSentry(root, config, { isAlive: () => true, fetchImpl: accepted, birthOf: async (pid) => {
    const probe = new DatabaseSync(path);
    probe.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    if (pid === 123) {
      otherProbes += 1;
      probe.exec("UPDATE events SET owner='replacement-owner', birth='replacement-birth' WHERE pid=123");
    }
    probe.exec("COMMIT");
    probe.close();
    return pid === 123 ? "observed-new-birth" : "current-birth";
  } });
  assert.equal(otherProbes, 1);
  assert.equal(result.delivered, 0);
  const checked = new DatabaseSync(path);
  assert.equal(checked.prepare("SELECT COUNT(*) AS n FROM events WHERE owner='replacement-owner' AND state='sending'").get().n, 4);
  checked.close();
}));

test("explicit pruning is bounded beyond checkpoint replay horizon and keeps pending/new receipts", () => fixture(async (config) => {
  const root = await enqueueCollectorSentry(tokens(), identity, config);
  const db = new DatabaseSync(join(root, "outbox.sqlite"));
  const now = Date.parse("2028-10-30T12:00:00Z");
  db.exec("UPDATE events SET state='sent', sent_at=1");
  db.prepare("UPDATE events SET state='pending' WHERE id=(SELECT id FROM events ORDER BY rowid LIMIT 1)").run();
  db.prepare("UPDATE events SET sent_at=? WHERE id=(SELECT id FROM events ORDER BY rowid LIMIT 1 OFFSET 1)").run(now);
  db.close();
  assert.equal((await pruneCollectorSentryReceipts(root, { successfulThrough: new Date(now).toISOString(), now, limit: 1 })).removed, 1);
  assert.equal((await pruneCollectorSentryReceipts(root, { successfulThrough: new Date(now).toISOString(), now })).removed, 1);
  const checked = new DatabaseSync(join(root, "outbox.sqlite"));
  assert.equal(checked.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  checked.close();
  await assert.rejects(pruneCollectorSentryReceipts(root, { successfulThrough: new Date(now).toISOString(), now, retentionDays: 179 }));
}));

test("UM posting remains independent from Sentry rejection and disabled bridge writes nothing", async () => {
  const originalFetch = globalThis.fetch;
  const old = Object.fromEntries(["COLLECTOR_SENTRY_ENABLED", "COLLECTOR_SENTRY_STATE_DIR", "SENTRY_OTLP_ENDPOINT", "SENTRY_PUBLIC_KEY"].map((key) => [key, process.env[key]]));
  try {
    await fixture(async (config) => {
      Object.assign(process.env, { COLLECTOR_SENTRY_ENABLED: "1", COLLECTOR_SENTRY_STATE_DIR: config.stateRoot, SENTRY_OTLP_ENDPOINT: config.endpoint, SENTRY_PUBLIC_KEY: config.publicKey });
      let umBody;
      globalThis.fetch = async (url, init) => {
        if (new URL(url).hostname === new URL(config.endpoint).hostname) return new Response("", { status: 503 });
        umBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ received: 4, persisted: 4, duplicates: 0, pruned: 0, rejected: 0 }));
      };
      const events = tokens({ collectorCallId: "call" });
      const result = await postUsageBatches({ events, ingestUrl: "https://usage.example/api/ingest/usage?note=sentry.io", ingestToken: "test-only", ...identity, log() {} });
      assert.equal(result.persisted, 4);
      assert.equal(JSON.stringify(umBody.events), JSON.stringify(events));
      const root = await enqueueCollectorSentry([], identity, config);
      assert.equal((await drainCollectorSentry(root, config, { fetchImpl: accepted })).delivered, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
