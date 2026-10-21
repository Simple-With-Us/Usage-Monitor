// The scrubber test suite.
//
// The scrubber is the security control, so these tests are about what does
// NOT leave the Mac.  A canary string stands in for any producer content:
// if the canary shows up anywhere in the output, a prompt, a response, a
// tool argument or a tool result would have leaked to Sentry.
//
// This suite runs under Vitest, not node:test.  The repository's Vitest
// include is the default (`**/*.test.mjs`), so it collects every file in
// this directory.  A node:test suite collected this way is imported by
// Vitest, registers zero tests there, and fails the run with "No test suite
// found in file".  Vitest is a dev dependency only -- the hub itself runs on
// Node builtins alone, with no third-party package.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  PRODUCER_CONTENT_FIELDS,
  SENTRY_ATTRIBUTE_ALLOWLIST,
  rebuildLogBody,
  scrubAttributeMap,
  scrubInternalEvent,
  scrubLogRecord,
  scrubOtlpAttributes,
  scrubResourceLogs,
  scrubResourceSpans,
  scrubSpan,
  stripProducerContent,
} from "../allowlist.mjs";
import { normalizeLogRecord, normalizeSpan } from "../internal-event.mjs";

const CANARY = "CANARY_SECRET_123";

function stringAttr(key, value) {
  return { key, value: { stringValue: value } };
}

function intAttr(key, value) {
  return { key, value: { intValue: String(value) } };
}

function makeSpan(attributes, extra = {}) {
  return {
    name: "chat",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes,
    ...extra,
  };
}

/** Every key anywhere in a structure. */
function deepKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      deepKeys(item, found);
    }
  }
  return found;
}

function serialized(value) {
  return JSON.stringify(value ?? null);
}

describe("the sentry allowlist", () => {
  it("carries no content key", () => {
    for (const key of SENTRY_ATTRIBUTE_ALLOWLIST) {
      assert.doesNotMatch(key, /prompt|message|argument|result|path|project|session|conversation|user/i);
    }
  });

  it("keeps a prompt out of a span (case 1)", () => {
    const span = makeSpan([stringAttr("gen_ai.input.messages", `please do the thing ${CANARY}`)]);
    const scrubbed = scrubSpan(span);
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    assert.equal(serialized(scrubbed).includes("gen_ai.input.messages"), false);
  });

  it("keeps a response, a tool argument and a tool result out of a span (case 2)", () => {
    const span = makeSpan([
      stringAttr("gen_ai.output.messages", `here you go ${CANARY}`),
      stringAttr("gen_ai.tool.call.arguments", `{ "path": "${CANARY}" }`),
      stringAttr("gen_ai.tool.call.result", `file contents ${CANARY}`),
    ]);
    const scrubbed = scrubSpan(span);
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    for (const key of ["gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) {
      assert.equal(serialized(scrubbed).includes(key), false);
    }
  });

  it("rebuilds a log body instead of forwarding it (case 3)", () => {
    const record = {
      timeUnixNano: "1700000000000000000",
      severityNumber: 9,
      body: { stringValue: `the raw producer body ${CANARY}` },
      attributes: [stringAttr("gen_ai.system", "opencode"), stringAttr("gen_ai.request.model", "a-model")],
    };
    const scrubbed = scrubLogRecord(record);
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    assert.notEqual(scrubbed.body.stringValue, record.body.stringValue);
    assert.match(scrubbed.body.stringValue, /gen_ai\.system=opencode/);
    assert.match(scrubbed.body.stringValue, /gen_ai\.request\.model=a-model/);
  });

  it("drops a dropped attribute whole, not partially redacted (case 4)", () => {
    const span = makeSpan([
      stringAttr("gen_ai.request.model", `model-${CANARY}`),
      stringAttr("gen_ai.system", "opencode"),
    ]);
    const scrubbed = scrubSpan(span, { dropAttributeKeys: ["gen_ai.request.model"] });
    assert.ok(scrubbed);
    const keys = scrubbed.attributes.map((attribute) => attribute.key);
    assert.equal(keys.includes("gen_ai.request.model"), false);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    //  Not even a fragment of the value survives.
    assert.equal(serialized(scrubbed).includes("CANARY"), false);
    assert.equal(keys.includes("gen_ai.system"), true);
  });

  it("keeps every allowlisted attribute (case 5)", () => {
    const numeric = new Set([
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.cache_read_input_tokens",
      "gen_ai.usage.cache_creation_input_tokens",
      "gen_ai.usage.reasoning_tokens",
      "duration_ms",
      "ttft_ms",
      "http.response.status_code",
      "context.tokens",
      "context.limit",
      "context.utilization_pct",
    ]);
    const attributes = SENTRY_ATTRIBUTE_ALLOWLIST.map((key) =>
      numeric.has(key) ? intAttr(key, 7) : stringAttr(key, `value-of-${key}`),
    );
    const scrubbed = scrubSpan(makeSpan(attributes));
    assert.ok(scrubbed);
    const keys = new Set(scrubbed.attributes.map((attribute) => attribute.key));
    for (const key of SENTRY_ATTRIBUTE_ALLOWLIST) {
      assert.equal(keys.has(key), true, `${key} should have survived`);
    }
    assert.equal(scrubbed.attributes.length, SENTRY_ATTRIBUTE_ALLOWLIST.length);
  });

  it("drops a key that is not on the allowlist (case 6)", () => {
    const scrubbed = scrubSpan(makeSpan([stringAttr("some.unknown.key", "value")]));
    assert.ok(scrubbed);
    assert.equal(scrubbed.attributes.length, 0);
    assert.equal(deepKeys(scrubbed).has("some.unknown.key"), false);
  });

  it("drops the events and links arrays of a span (case 7)", () => {
    const span = makeSpan([stringAttr("gen_ai.system", "opencode")], {
      events: [{ name: "an event", attributes: [stringAttr("gen_ai.input.messages", CANARY)] }],
      links: [{ traceId: "c".repeat(32), attributes: [stringAttr("gen_ai.tool.call.result", CANARY)] }],
    });
    const scrubbed = scrubSpan(span);
    assert.ok(scrubbed);
    assert.equal("events" in scrubbed, false);
    assert.equal("links" in scrubbed, false);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
  });

  it("never throws on malformed input (case 8)", () => {
    const megabyte = "x".repeat(1024 * 1024);
    const inputs = [
      null,
      undefined,
      42,
      "a string",
      [],
      [[]],
      [{ key: "gen_ai.system", value: { arrayValue: { values: [{ stringValue: CANARY }] } } }],
      [{ key: "gen_ai.system", value: { kvlistValue: { values: [{ key: "a", value: { stringValue: CANARY } }] } } }],
      [{ key: "gen_ai.system", value: { stringValue: megabyte } }],
      [{ key: null, value: { stringValue: CANARY } }],
      [{ value: { stringValue: CANARY } }],
    ];
    for (const input of inputs) {
      assert.doesNotThrow(() => scrubSpan(input));
      assert.doesNotThrow(() => scrubLogRecord(input));
      assert.doesNotThrow(() => scrubOtlpAttributes(input));
      assert.doesNotThrow(() => scrubAttributeMap(input));
      assert.doesNotThrow(() => scrubInternalEvent(input));
    }
    assert.doesNotThrow(() => scrubResourceSpans(null));
    assert.doesNotThrow(() => scrubResourceLogs(null));
    assert.doesNotThrow(() => rebuildLogBody(null));
    const big = scrubOtlpAttributes([{ key: "gen_ai.system", value: { stringValue: megabyte } }]);
    assert.equal(big.length, 1);
    assert.equal(big[0].value.stringValue.length <= 1024, true);
  });

  it("never emits a promptText or a responseText key (case 9)", () => {
    const event = {
      eventId: "a".repeat(64),
      ts: "2026-10-20T21:00:00.000Z",
      platform: "opencode",
      model: "a-model",
      operation: "chat",
      promptText: `prompt ${CANARY}`,
      responseText: `response ${CANARY}`,
      kind: "span",
    };
    const outputs = [
      scrubInternalEvent(event),
      scrubInternalEvent(stripProducerContent(event)),
      scrubSpan(makeSpan([stringAttr("gen_ai.input.messages", CANARY)])),
      scrubResourceSpans({ resourceSpans: [{ scopeSpans: [{ spans: [makeSpan([])] }] }] }),
    ];
    for (const output of outputs) {
      const keys = deepKeys(output);
      for (const field of PRODUCER_CONTENT_FIELDS) {
        assert.equal(keys.has(field), false, `${field} must never appear in the scrubbed output`);
      }
    }
  });

  it("strips the producer free text before the scrubber runs (case 10)", () => {
    const event = {
      eventId: "b".repeat(64),
      ts: "2026-10-20T21:00:00.000Z",
      platform: "opencode",
      model: "a-model",
      operation: "chat",
      promptText: `prompt ${CANARY}`,
      responseText: `response ${CANARY}`,
      //  Even if the allowlist were bypassed at the edge, a content key
      //  inside the attribute map still has to die here.
      attrs: { "gen_ai.input.messages": `prompt ${CANARY}`, "gen_ai.system": "opencode" },
      kind: "span",
    };
    const stripped = stripProducerContent(event);
    assert.equal("promptText" in stripped, false);
    assert.equal("responseText" in stripped, false);
    assert.equal(event.promptText, `prompt ${CANARY}`);

    const scrubbed = scrubInternalEvent(stripped);
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    assert.equal(serialized(scrubbed).includes("CANARY"), false);
    const keys = deepKeys(scrubbed);
    for (const field of PRODUCER_CONTENT_FIELDS) {
      assert.equal(keys.has(field), false);
    }
    const attributeKeys = scrubbed.attributes.map((attribute) => attribute.key);
    assert.equal(attributeKeys.includes("gen_ai.system"), true);
  });

  it("keeps a span status code but drops the status message", () => {
    const scrubbed = scrubSpan(makeSpan([stringAttr("gen_ai.system", "opencode")], {
      status: { code: 2, message: `failed because ${CANARY}` },
    }));
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
    assert.deepEqual(scrubbed.status, { code: 2 });
  });

  it("never lets a producer span name become the operation", () => {
    //  `operation` reaches Sentry as the span name AND as the allowlisted
    //  gen_ai.operation.name attribute, so it must be sourced only from that
    //  semconv attribute.  The span NAME is producer free text.
    const normalized = normalizeSpan({
      name: `chat ${CANARY}`,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000100000000",
      attributes: [stringAttr("gen_ai.system", "opencode")],
    });

    assert.ok(normalized);
    assert.equal(normalized.operation, "chat");
    assert.equal(JSON.stringify(normalized).includes(CANARY), false);

    const scrubbed = scrubInternalEvent(normalized);
    assert.ok(scrubbed);
    assert.equal(serialized(scrubbed).includes(CANARY), false);
  });

  it("gives two distinct log records distinct event ids", () => {
    //  Same timestamp, same platform, no trace context: only the attributes
    //  tell them apart, so they must not collide or one is dropped as sent.
    const base = { timeUnixNano: "1700000000000000000", severityNumber: 9 };
    const first = normalizeLogRecord({
      ...base,
      attributes: [stringAttr("gen_ai.system", "opencode"), stringAttr("gen_ai.request.model", "model-a")],
    });
    const second = normalizeLogRecord({
      ...base,
      attributes: [stringAttr("gen_ai.system", "opencode"), stringAttr("gen_ai.request.model", "model-b")],
    });
    assert.ok(first && second);
    assert.notEqual(first.eventId, second.eventId);

    //  A retry of the SAME record is still idempotent.
    const retry = normalizeLogRecord({
      ...base,
      attributes: [stringAttr("gen_ai.system", "opencode"), stringAttr("gen_ai.request.model", "model-a")],
    });
    assert.equal(retry.eventId, first.eventId);
  });
});
