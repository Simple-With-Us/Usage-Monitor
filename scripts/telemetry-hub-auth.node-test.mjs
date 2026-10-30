import test from "node:test";
import assert from "node:assert/strict";
import { createReceiver, parseReceiverSources } from "./telemetry-hub/otlp-receiver.mjs";
import { receiverJournal } from "./telemetry-hub/hub.mjs";
import { collectorSentryConfig, collectorSentryEvents, enqueueCollectorSentry, enqueueCollectorSentryTelemetry, drainCollectorSentry } from "./lib/collector-sentry-bridge.mjs";
import { tokenEventsFromBreakdown } from "./lib/session-token-collectors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHubTelemetry } from "./telemetry-hub/metadata-projection.mjs";
import { scrubInternalEvent } from "./telemetry-hub/allowlist.mjs";
import { normalizeLogRecord } from "./telemetry-hub/internal-event.mjs";
import { buildLogsEnvelope, buildTracesEnvelope } from "./telemetry-hub/sentry-sender.mjs";
import { DatabaseSync } from "node:sqlite";

const token = "test-only-bearer-000000000000000000000000000000";
const source = { id: "codex-server", platform: "codex-cli", token };
function payload() {
  return { resourceSpans: [{
    resource: { attributes: [{ key: "agent.platform", value: { stringValue: "impersonated-seat" } }] },
    scopeSpans: [{ spans: [{
      traceId: "a".repeat(32), spanId: "b".repeat(16), name: "PRIVATE_CONTENT",
      startTimeUnixNano: "1793361600000000000", endTimeUnixNano: "1793361600001000000",
      attributes: [
        { key: "prompt", value: { stringValue: "PRIVATE_CONTENT" } },
        { key: "agent.platform", value: { stringValue: "impersonated-seat" } },
        { key: "gen_ai.request.model", value: { stringValue: "test-model" } },
        { key: "gen_ai.system", value: { stringValue: "anthropic" } },
      ],
    }] }],
  }] };
}

test("remote receiver fails closed without scoped source configuration", () => {
  assert.throws(() => createReceiver({ journal: {}, host: "0.0.0.0" }), /authenticated sources/);
  assert.throws(() => parseReceiverSources('[{"id":"x","platform":"x","token":"short"}]'), /configuration is invalid/);
  assert.throws(() => parseReceiverSources(JSON.stringify([source, { ...source, id: "second" }])), /configuration is invalid/);
});

test("metadata projection rejects free-text identifiers and nonfinite nested values", () => {
  const projected = projectHubTelemetry({ eventId: "a".repeat(64), ts: "2026-10-30T12:00:00Z", platform: "a prompt with spaces", model: "sk-SECRET_VALUE", operation: "PRIVATE PROMPT", tokens: { input: 5, output: Infinity, prompt: "PRIVATE_CONTENT" }, attrs: { prompt: "PRIVATE_CONTENT" }, context: { tokens: NaN, limit: 100 }, toolNames: ["read_file", "PRIVATE PROMPT"], promptText: "PRIVATE_CONTENT" });
  assert.equal(projected.platform, "unknown");
  assert.equal(projected.operation, "telemetry");
  assert.ok(!projected.model);
  assert.deepEqual(projected.tokens, { input: 5 });
  assert.deepEqual(projected.context, { limit: 100 });
  assert.deepEqual(projected.toolNames, ["read_file"]);
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_CONTENT"));
});

test("auth precedes decoding and server identity overrides claims before allowlisted journal", async () => {
  const events = [];
  const journal = receiverJournal({ appendBatch: async (rows) => { events.push(...rows); return 1; } }, { metadataOnly: true });
  const receiver = createReceiver({ journal, sources: parseReceiverSources(JSON.stringify([source])), port: 0 });
  const address = await receiver.listen();
  const url = `http://127.0.0.1:${address.port}/v1/traces`;
  try {
    assert.equal((await fetch(url, { method: "POST", body: "invalid-json" })).status, 401);
    assert.equal(events.length, 0);
    const result = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload()) });
    assert.equal(result.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].platform, "codex-cli");
    assert.equal(events[0].authenticatedSource, "codex-server");
    const attributes = scrubInternalEvent(events[0]).attributes;
    assert.equal(attributes.find((attr) => attr.key === "agent.platform").value.stringValue, "codex-cli");
    assert.equal(attributes.find((attr) => attr.key === "gen_ai.system").value.stringValue, "anthropic");
    assert.ok(!JSON.stringify(events).includes("PRIVATE_CONTENT"));
    assert.ok(!JSON.stringify(events).includes("impersonated-seat"));
    assert.ok(!Object.hasOwn(events[0], "attrs"));
    const firstId = events[0].eventId;
    await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload()) });
    assert.equal(events[1].eventId, firstId);
    const forged = payload();
    forged.resourceSpans[0].resource.attributes[0].value.stringValue = "another-claimed-platform";
    forged.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((attr) => attr.key === "agent.platform").value.stringValue = "another-claimed-platform";
    await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(forged) });
    assert.equal(events[2].eventId, firstId);
  } finally { await receiver.close(); }
});

test("authenticated log identity ignores caller platform aliases and remains source namespaced", () => {
  const log = { timeUnixNano: "1793361600000000000", traceId: "a".repeat(32), spanId: "b".repeat(16), body: { stringValue: "private body" }, attributes: [{ key: "agent.platform", value: { stringValue: "claim-one" } }] };
  const identity = { sourceId: "server-codex", platform: "openai-codex" };
  const first = normalizeLogRecord(log, {}, identity);
  const otherClaim = { ...log, attributes: [{ key: "agent.platform", value: { stringValue: "claim-two" } }] };
  assert.equal(normalizeLogRecord(otherClaim, {}, identity).eventId, first.eventId);
  assert.notEqual(normalizeLogRecord(log, {}, { ...identity, sourceId: "mac-codex" }).eventId, first.eventId);
});

test("collector-to-hub uses scoped bearer, stable OTLP identity and requires durable ACK", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hub-bridge-"));
  const receiverEvents = [];
  const receiver = createReceiver({ journal: receiverJournal({ appendBatch: async (rows) => { receiverEvents.push(...rows); return 1; } }, { metadataOnly: true }), sources: [source], port: 0 });
  const address = await receiver.listen();
  try {
    const config = collectorSentryConfig({ COLLECTOR_SENTRY_ENABLED: "1", COLLECTOR_SENTRY_STATE_DIR: stateRoot, COLLECTOR_TELEMETRY_HUB_ENDPOINT: `http://127.0.0.1:${address.port}`, COLLECTOR_TELEMETRY_HUB_TOKEN: token });
    const events = tokenEventsFromBreakdown({ producerId: "openai-codex", provider: "openai", service: "codex", sessionKey: "private", occurredAtIso: "2026-10-30T12:00:00Z", model: "test", extraId: "source", breakdown: { input: 4, output: 2 } });
    assert.equal(collectorSentryEvents(events, { producerId: "openai-codex" }).length, 2);
    const root = await enqueueCollectorSentry(events, { producerId: "openai-codex" }, config);
    assert.equal((await drainCollectorSentry(root, config, { fetchImpl: async () => new Response('{}') })).pending, true);
    const delivered = await drainCollectorSentry(root, config);
    assert.equal(delivered.delivered, 2);
    assert.equal(receiverEvents.length, 2);
    assert.ok(receiverEvents.every((event) => event.platform === "codex-cli" && event.kind === "log"));
    assert.ok(receiverEvents.every((event) => event.vendor === "openai"));
  } finally { await receiver.close(); await rm(stateRoot, { recursive: true, force: true }); }
});

test("native and CLI drains preserve numeric wire aliases through authenticated hub and Sentry projection", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "hub-wire-alias-"));
  const receiverEvents = [];
  const receiver = createReceiver({ journal: receiverJournal({ appendBatch: async (rows) => { receiverEvents.push(...rows); return 1; } }, { metadataOnly: true }), sources: [source], port: 0 });
  const address = await receiver.listen();
  try {
    const config = { destination: "hub", endpoint: `http://127.0.0.1:${address.port}`, token, stateRoot };
    const identity = { producerId: "openai-codex", producerInstanceId: "test-host" };
    const cli = tokenEventsFromBreakdown({ producerId: "openai-codex", provider: "openai", service: "codex", sessionKey: "private", occurredAtIso: "2026-10-30T12:00:00Z", model: "test", extraId: "source", breakdown: { input: 4, output: 2 }, extraMetadata: { reasoningTokens: 1 }, collectorCallId: "source-call" });
    const root = await enqueueCollectorSentry(cli, identity, config);
    await enqueueCollectorSentryTelemetry([{ eventId: "e".repeat(64), ts: "2026-10-30T12:00:01Z", kind: "span", platform: "botfleet", operation: "botfleet.turn", tokens: { input: 5, reasoning: 3 }, context: { tokens: 123 }, promptText: "PRIVATE_CONTENT" }], identity, config);
    const cliLog = tokenEventsFromBreakdown({ producerId: "openai-codex", provider: "openai", service: "codex", sessionKey: "private", occurredAtIso: "2026-10-30T12:00:02Z", model: "test", extraId: "source-log", breakdown: { output: 9 }, extraMetadata: { reasoningTokens: 7 } });
    await enqueueCollectorSentry(cliLog, identity, config);
    await enqueueCollectorSentryTelemetry([{ eventId: "f".repeat(64), ts: "2026-10-30T12:00:03Z", kind: "log", platform: "botfleet", operation: "botfleet.turn", tokens: { reasoning: 5 }, context: { tokens: 11 } }], identity, config);
    const db = new DatabaseSync(join(root, "outbox.sqlite"));
    for (const row of db.prepare("SELECT id,payload FROM events").all()) {
      const payload = JSON.parse(row.payload);
      payload.attributes.push({ key: "gen_ai.input.messages", value: { stringValue: "PRIVATE_CONTENT" } }, { key: "gen_ai.usage.reasoning_count", value: { stringValue: "PRIVATE_CONTENT" } }, { key: "context.used", value: { stringValue: "PRIVATE_CONTENT" } });
      db.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify(payload), row.id);
    }
    db.close();
    const wire = [];
    const result = await drainCollectorSentry(root, config, { fetchImpl: async (url, options) => {
      wire.push(JSON.parse(options.body));
      return fetch(url, options);
    } });
    assert.equal(result.delivered, 4);
    assert.ok(!JSON.stringify(wire).includes("PRIVATE_CONTENT"));
    const output = buildTracesEnvelope(receiverEvents.filter((event) => event.kind === "span").map((event) => scrubInternalEvent(projectHubTelemetry(event))));
    const spans = output.resourceSpans[0].scopeSpans[0].spans;
    const counts = spans.map((span) => span.attributes.find((a) => a.key === "gen_ai.usage.reasoning_count")?.value.stringValue).sort();
    assert.deepEqual(counts, ["1", "3"]);
    assert.ok(spans.some((span) => span.attributes.some((a) => a.key === "context.used" && a.value.stringValue === "123")));
    assert.ok(!JSON.stringify(output).includes("PRIVATE_CONTENT"));
    const logOutput = buildLogsEnvelope(receiverEvents.filter((event) => event.kind === "log").map((event) => scrubInternalEvent(projectHubTelemetry(event))));
    const logs = logOutput.resourceLogs[0].scopeLogs[0].logRecords;
    assert.deepEqual(logs.map((record) => record.attributes.find((a) => a.key === "gen_ai.usage.reasoning_count")?.value.stringValue).sort(), ["5", "7"]);
    assert.ok(logs.some((record) => record.attributes.some((a) => a.key === "context.used" && a.value.stringValue === "11")));
    assert.ok(!JSON.stringify(logOutput).includes("PRIVATE_CONTENT"));
  } finally { await receiver.close(); await rm(stateRoot, { recursive: true, force: true }); }
});
