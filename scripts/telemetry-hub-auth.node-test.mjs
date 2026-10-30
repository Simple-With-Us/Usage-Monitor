import test from "node:test";
import assert from "node:assert/strict";
import { createReceiver, parseReceiverSources } from "./telemetry-hub/otlp-receiver.mjs";
import { receiverJournal } from "./telemetry-hub/hub.mjs";
import { collectorSentryConfig, collectorSentryEvents, enqueueCollectorSentry, drainCollectorSentry } from "./lib/collector-sentry-bridge.mjs";
import { tokenEventsFromBreakdown } from "./lib/session-token-collectors.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHubTelemetry } from "./telemetry-hub/metadata-projection.mjs";
import { scrubInternalEvent } from "./telemetry-hub/allowlist.mjs";
import { normalizeLogRecord } from "./telemetry-hub/internal-event.mjs";

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
