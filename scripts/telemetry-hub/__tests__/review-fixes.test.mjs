// The review fix test suite.
//
// Every test here covers one finding of the review of PR 1740.  The tests
// are about the BEHAVIOUR of the fix, not about the shape of the code.
//
// This suite runs under Vitest, like the other two suites of this folder.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { projectScope, scrubInternalEvent, scrubResourceLogs, scrubResourceSpans } from "../allowlist.mjs";
import { normalizeLogRecord, normalizeSpan } from "../internal-event.mjs";
import { Journal } from "../journal.mjs";
import { createReceiver, MAX_REJECTED_ROWS, RECEIVER_RESPONSE_SCHEMA } from "../otlp-receiver.mjs";
import { createUmSender, createTokenResolver, readOverlapPolicy, shouldPushLedgerEvent } from "../um-sender.mjs";
import { fleetSecretsGet, fleetSecretsGetAsync } from "../../lib/fleet-secrets.mjs";

const CANARY = "CANARY_SECRET_123";
const created = [];
const opened = [];

async function openJournal(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-hub-fix-"));
  created.push(dir);
  const journal = new Journal({ dir, ...options });
  await journal.open();
  await journal.loadDestinations(["um-turns", "um-ingest", "sentry"]);
  opened.push(journal);
  return { dir, journal };
}

function event(index, overrides = {}) {
  return {
    eventId: `event-${index}`,
    ts: new Date(1700000000000 + index * 1000).toISOString(),
    platform: "a-agent",
    model: "a-model",
    operation: "chat",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    costUsd: 0.01,
    durationMs: 100,
    toolNames: ["read"],
    status: "ok",
    project: "a-project",
    sessionId: `session-${index}`,
    promptText: `prompt ${index}`,
    responseText: `response ${index}`,
    kind: "span",
    ...overrides,
  };
}

function fakeResponse(status, body = "") {
  return { status, text: async () => body };
}

/** The rows the receiver wrote down, oldest first. */
async function readRejectedRows(dir) {
  try {
    const text = await readFile(join(dir, "rejected-rows.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** One span that the receiver accepts. */
function goodSpan(name = "a-good-span") {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [{ key: "gen_ai.request.model", value: { stringValue: "a-model" } }],
  };
}

afterEach(async () => {
  while (opened.length > 0) {
    const journal = opened.pop();
    await journal.close();
  }
  while (created.length > 0) {
    const dir = created.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the sentry scrubber", () => {
  it("projects the scope instead of forwarding it raw", () => {
    const scope = {
      name: "a-scope",
      version: "1",
      attributes: [{ key: "gen_ai.input.messages", value: { stringValue: CANARY } }],
      droppedAttributesCount: 2,
      somethingElse: CANARY,
    };
    const projected = projectScope(scope);
    assert.equal(projected.name, "a-scope");
    assert.equal(projected.version, "1");
    assert.equal(projected.droppedAttributesCount, 2);
    assert.equal(projected.attributes.length, 0);
    assert.equal(JSON.stringify(projected).includes(CANARY), false);
    assert.equal("somethingElse" in projected, false);
  });

  it("keeps the scope content out of a scrubbed resource payload", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { attributes: [{ key: "gen_ai.input.messages", value: { stringValue: CANARY } }] },
              spans: [{ name: "a-span", attributes: [] }],
            },
          ],
        },
      ],
    };
    const scrubbed = scrubResourceSpans(payload);
    assert.equal(JSON.stringify(scrubbed).includes(CANARY), false);

    const logs = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              scope: { attributes: [{ key: "gen_ai.input.messages", value: { stringValue: CANARY } }] },
              logRecords: [{ body: { stringValue: CANARY }, attributes: [] }],
            },
          ],
        },
      ],
    };
    assert.equal(JSON.stringify(scrubResourceLogs(logs)).includes(CANARY), false);
  });

  it("never turns a raw span name into the operation", () => {
    const span = {
      name: `chat ${CANARY}`,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000001000000000",
      attributes: [],
    };
    const normalized = normalizeSpan(span);
    assert.ok(normalized);
    assert.equal(normalized.operation, "chat");
    assert.equal(JSON.stringify(normalized).includes(CANARY), false);

    //  The span name of the Sentry envelope is the operation, and the
    //  operation is bounded before it is used.
    const scrubbed = scrubInternalEvent({
      eventId: "c".repeat(64),
      ts: "2026-10-20T21:00:00.000Z",
      platform: "a-agent",
      operation: "x".repeat(4000),
      kind: "span",
    });
    assert.equal(scrubbed.name.length <= 1024, true);

    const fromOperation = scrubInternalEvent({
      eventId: "c".repeat(64),
      ts: "2026-10-20T21:00:00.000Z",
      platform: "a-agent",
      operation: normalized.operation,
      kind: "span",
    });
    assert.equal(fromOperation.name, "chat");
  });
});

describe("the internal event identity", () => {
  it("gives two different log records two different ids", () => {
    const base = {
      timeUnixNano: "1700000000000000000",
      severityNumber: 9,
      spanId: "b".repeat(16),
      traceId: "a".repeat(32),
    };
    const first = normalizeLogRecord({ ...base, body: { stringValue: "one" } });
    const second = normalizeLogRecord({ ...base, body: { stringValue: "two" } });
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.eventId, second.eventId);
  });

  it("gives a retried log record the same id", () => {
    const record = {
      timeUnixNano: "1700000000000000000",
      severityNumber: 9,
      body: { stringValue: "one" },
      attributes: [{ key: "gen_ai.system", value: { stringValue: "a-agent" } }],
    };
    const first = normalizeLogRecord(record);
    const second = normalizeLogRecord(record);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.eventId, second.eventId);
    //  The body itself is never captured.
    assert.equal("body" in first, false);
    assert.equal(JSON.stringify(first).includes("one"), false);
  });
});

describe("the journal", () => {
  it("drops a row that does not match the journal schema", async () => {
    const { dir, journal } = await openJournal();
    await journal.append(event(1));
    await journal.appendBatch([
      { ts: "2026-10-20T21:00:00.000Z", kind: "span" },
      { eventId: "", ts: "2026-10-20T21:00:00.000Z" },
    ]);
    const batch = await journal.readBatch("um-turns", 10);
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].eventId, "event-1");
    await journal.close();
    const raw = await readFile(join(dir, "journal.jsonl"), "utf8");
    assert.equal(raw.split("\n").filter((line) => line.trim()).length, 3);
  });

  it("delivers a repeated event id inside one batch only once", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(1));
    await journal.append(event(2));
    const batch = await journal.readBatch("um-turns", 10);
    assert.deepEqual(
      batch.events.map((item) => item.eventId),
      ["event-1", "event-2"],
    );
  });

  it("rejects a malformed offset state instead of believing it", async () => {
    const { dir, journal } = await openJournal();
    await journal.close();
    await writeFile(join(dir, "state", "um-turns.offset.json"), '{"offset":"nope"}\n', "utf8");
    await journal.loadDestinations(["um-turns"]);
    assert.equal(journal.getOffset("um-turns"), 0);
  });

  it("rejects a malformed sent state instead of believing it", async () => {
    const { dir, journal } = await openJournal();
    await journal.close();
    await writeFile(join(dir, "state", "sentry.sent.json"), '{"eventIds":[1,2]}\n', "utf8");
    await journal.loadDestinations(["sentry"]);
    assert.equal(journal.isSent("sentry", "1"), false);
  });

  it("drops the consumed prefix once the journal passes its size", async () => {
    const { dir, journal } = await openJournal({ maxJournalBytes: 512 });
    for (let index = 1; index <= 8; index += 1) {
      await journal.append(event(index));
    }
    const sizeBefore = (await stat(join(dir, "journal.jsonl"))).size;
    assert.ok(sizeBefore > 512);

    //  Every destination reads the same way, so the prefix they have all
    //  read is consumed and can be dropped.  The compaction only runs when
    //  it brings the file back under the cap, so it takes a few reads.
    const delivered = [];
    let sizeAfter = sizeBefore;
    for (let index = 0; index < 8; index += 1) {
      const batch = await journal.readBatch("um-turns", 1);
      if (batch.events.length === 0) break;
      delivered.push(batch.events[0].eventId);
      await journal.setOffset("um-turns", batch.endOffset);
      await journal.setOffset("um-ingest", batch.endOffset);
      await journal.setOffset("sentry", batch.endOffset);
      sizeAfter = (await stat(join(dir, "journal.jsonl"))).size;
      if (sizeAfter < sizeBefore) break;
    }

    assert.ok(sizeAfter < sizeBefore);
    //  The remaining events are still there, and the offset still points
    //  at the right place, because the offsets are absolute.  No event is
    //  lost and none is delivered twice.
    const rest = await journal.readBatch("um-turns", 10);
    assert.deepEqual(
      [...delivered, ...rest.events.map((item) => item.eventId)],
      ["event-1", "event-2", "event-3", "event-4", "event-5", "event-6", "event-7", "event-8"],
    );
  });
});

describe("the um sender", () => {
  it("fails fast when the ingest token is missing", async () => {
    const { journal } = await openJournal();
    const sender = createUmSender({ journal, resolveToken: async () => undefined });
    await assert.rejects(() => sender.runOnce(), /USAGE_INGEST_TOKEN/);
  });

  it("does not advance an offset in a dry run with an empty payload", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1, { kind: "log", tokens: {}, costUsd: undefined }));
    const sender = createUmSender({ journal, dryRun: true, resolveToken: async () => "a-test-token" });
    const outcome = await sender.runOnce();
    assert.equal(outcome.ok, true);
    assert.equal(journal.getOffset("um-ingest"), 0);
    assert.equal(journal.getOffset("um-turns"), 0);
  });

  it("does not post a log record as a turn", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1, { kind: "log" }));
    await journal.append(event(2, { kind: "span" }));
    const seen = [];
    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith("/api/otlp/v1/traces")) seen.push(body.turns.map((turn) => turn.conversationId));
        return fakeResponse(200, "{}");
      },
    });
    await sender.runOnce();
    assert.deepEqual(seen, [["session-2"]]);
  });

  it("skips a platform that another collector already reports", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1, { platform: "opencode" }));
    const posted = [];
    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      fetchImpl: async (url, init) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return fakeResponse(200, "{}");
      },
    });
    const outcome = await sender.runOnce();
    assert.equal(outcome.overlapSkipped, 1);
    //  There is no ledger row for the platform, so there is nothing to
    //  post to the ledger at all.
    assert.equal(posted.some((item) => item.url.endsWith("/api/ingest/usage")), false);
  });

  it("skips a provider that another feed bills", () => {
    const policy = readOverlapPolicy({});
    assert.equal(shouldPushLedgerEvent({ platform: "a-agent", provider: "cursor" }, policy), false);
    assert.equal(shouldPushLedgerEvent({ platform: "a-agent", provider: "anthropic" }, policy), true);
  });

  it("lets an operator take one platform out of the overlap list", () => {
    const policy = readOverlapPolicy({ TELEMETRY_HUB_OVERLAP_PLATFORMS: "opencode" });
    assert.equal(shouldPushLedgerEvent({ platform: "opencode" }, policy), false);
    assert.equal(shouldPushLedgerEvent({ platform: "claude-code" }, policy), true);
  });

  it("does not bill a log record as a usage row", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1, { kind: "log" }));
    const posted = [];
    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      fetchImpl: async (url, init) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return fakeResponse(200, "{}");
      },
    });
    const outcome = await sender.runOnce();
    assert.equal(outcome.overlapSkipped, 1);
    assert.equal(posted.some((item) => item.url.endsWith("/api/ingest/usage")), false);
  });
});

describe("the otlp receiver", () => {
  it("keeps the good rows of a batch that has one bad row", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  scope: { name: "a-scope" },
                  spans: [
                    {
                      traceId: "a".repeat(32),
                      spanId: "b".repeat(16),
                      name: "a-span",
                      startTimeUnixNano: "1700000000000000000",
                      endTimeUnixNano: "1700000001000000000",
                      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "a-model" } }],
                    },
                    { name: "a-broken-span", attributes: "not an array" },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = RECEIVER_RESPONSE_SCHEMA.parse(await response.json());
      assert.equal(body.written, 1);
      assert.equal(body.ignored, 1);
      const batch = await journal.readBatch("um-turns", 10);
      assert.equal(batch.events.length, 1);
      assert.equal(batch.events[0].model, "a-model");
    } finally {
      await receiver.close();
    }
  });

  it("keeps a good scope when a sibling scope is malformed", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                { scope: { name: "a-broken-scope" }, spans: "not an array" },
                {
                  scope: { name: "a-good-scope" },
                  spans: [
                    {
                      traceId: "c".repeat(32),
                      spanId: "d".repeat(16),
                      name: "a-span",
                      startTimeUnixNano: "1700000000000000000",
                      endTimeUnixNano: "1700000001000000000",
                      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "a-model" } }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = RECEIVER_RESPONSE_SCHEMA.parse(await response.json());
      assert.equal(body.written, 1);
      assert.equal(body.ignored, 1);
      const batch = await journal.readBatch("um-turns", 10);
      assert.equal(batch.events.length, 1);
      assert.equal(batch.events[0].model, "a-model");
    } finally {
      await receiver.close();
    }
  });

  it("refuses a payload that has no usable row", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: "not an array" }] }] }),
      });
      assert.equal(response.status, 400);
    } finally {
      await receiver.close();
    }
  });

  it("answers a malformed request target instead of crashing", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}//`, { method: "POST" });
      assert.equal(response.status, 400);
    } finally {
      await receiver.close();
    }
  });

  it("refuses a payload that does not match the otlp shape", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceSpans: "not an array" }),
      });
      assert.equal(response.status, 400);
      const batch = await journal.readBatch("um-turns", 10);
      assert.equal(batch.events.length, 0);
    } finally {
      await receiver.close();
    }
  });

  it("accepts a well formed payload and journals it", async () => {
    const { journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: [{ key: "gen_ai.system", value: { stringValue: "a-agent" } }] },
              scopeSpans: [
                {
                  scope: { name: "a-scope" },
                  spans: [
                    {
                      traceId: "a".repeat(32),
                      spanId: "b".repeat(16),
                      name: "a-span",
                      startTimeUnixNano: "1700000000000000000",
                      endTimeUnixNano: "1700000001000000000",
                      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "a-model" } }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = RECEIVER_RESPONSE_SCHEMA.parse(await response.json());
      assert.equal(body.written, 1);
      const batch = await journal.readBatch("um-turns", 10);
      assert.equal(batch.events.length, 1);
      assert.equal(batch.events[0].model, "a-model");
    } finally {
      await receiver.close();
    }
  });
});

describe("the rejected rows sink", () => {
  it("writes a malformed span down instead of dropping it silently", async () => {
    const { dir, journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  scope: { name: "a-scope" },
                  spans: [goodSpan(), { name: "a-broken-span", attributes: "not an array" }],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = RECEIVER_RESPONSE_SCHEMA.parse(await response.json());
      assert.equal(body.written, 1);
      assert.equal(body.ignored, 1);
      const records = await readRejectedRows(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].level, "span");
      assert.equal(records[0].path, "/v1/traces");
      assert.equal(records[0].row.includes("a-broken-span"), true);
    } finally {
      await receiver.close();
    }
  });

  it("writes a malformed log record down", async () => {
    const { dir, journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              scopeLogs: [
                {
                  scope: { name: "a-scope" },
                  logRecords: [
                    {
                      timeUnixNano: "1700000000000000000",
                      severityText: "INFO",
                      body: { stringValue: "a-good-record" },
                      attributes: [],
                    },
                    { timeUnixNano: "1700000000000000000", attributes: "not an array" },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = RECEIVER_RESPONSE_SCHEMA.parse(await response.json());
      assert.equal(body.ignored, 1);
      const records = await readRejectedRows(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].level, "log-record");
      assert.equal(records[0].path, "/v1/logs");
    } finally {
      await receiver.close();
    }
  });

  it("writes nothing down when every row matched", async () => {
    const { dir, journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [{ scopeSpans: [{ scope: { name: "a-scope" }, spans: [goodSpan()] }] }],
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await readRejectedRows(dir), []);
    } finally {
      await receiver.close();
    }
  });

  it("writes down at most the bounded number of rows", async () => {
    const { dir, journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const spans = Array.from({ length: 40 }, () => ({ name: "a-broken-span", attributes: "not an array" }));
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: "a-scope" }, spans }] }] }),
      });
      assert.equal(response.status, 400);
      const records = await readRejectedRows(dir);
      assert.equal(records.length, MAX_REJECTED_ROWS);
    } finally {
      await receiver.close();
    }
  });

  it("cuts one rejected row down to its bound", async () => {
    const { dir, journal } = await openJournal();
    const receiver = createReceiver({ journal, port: 0 });
    const address = await receiver.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  scope: { name: "a-scope" },
                  spans: [goodSpan(), { name: "x".repeat(40 * 1024), attributes: "not an array" }],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const records = await readRejectedRows(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].row.length <= 16 * 1024, true);
      assert.equal(records[0].bytes > 16 * 1024, true);
    } finally {
      await receiver.close();
    }
  });

  it("rotates the rejected rows file when it grows past its bound", async () => {
    const { dir, journal } = await openJournal({ maxSinkBytes: 512 });
    const row = "x".repeat(200);
    for (let i = 0; i < 10; i += 1) {
      await journal.quarantineRejectedRows([
        { path: "/v1/traces", level: "span", reason: "a-reason", bytes: row.length, row },
      ]);
    }
    const rotated = await readFile(join(dir, "rejected-rows.jsonl.1"), "utf8");
    assert.ok(rotated.length > 0);
    const current = await readFile(join(dir, "rejected-rows.jsonl"), "utf8");
    assert.ok(current.length > 0);
  });
});

describe("the fleet secret lookup", () => {
  it("keeps the null contract for a caller that did not ask for a signal", () => {
    const value = fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("nope"), { status: 4 });
      },
      useCache: false,
    });
    assert.equal(value, null);
  });

  it("tells an absent secret apart from a helper that could not be reached", () => {
    const failures = [];
    fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("nope"), { status: 3 });
      },
      useCache: false,
      onError: (failure) => failures.push(failure),
    });
    assert.equal(failures.length, 2);
    assert.equal(failures.every((failure) => failure.kind === "absent"), true);
    assert.equal(failures[0].name, "A_SECRET");
  });

  it("reports a helper that could not be reached as unavailable", () => {
    const failures = [];
    fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("nope"), { status: 4 });
      },
      useCache: false,
      onError: (failure) => failures.push(failure),
    });
    assert.equal(failures[0].kind, "unavailable");
    assert.equal(failures[0].exitCode, 4);
  });

  it("reports a helper that is not installed", () => {
    const failures = [];
    fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("spawn"), { code: "ENOENT" });
      },
      useCache: false,
      onError: (failure) => failures.push(failure),
    });
    assert.equal(failures[0].kind, "missing-binary");
  });

  it("reports the kind of a failed async lookup", async () => {
    const failures = [];
    const value = await fleetSecretsGetAsync("A_SECRET", {
      exec: async () => {
        throw Object.assign(new Error("nope"), { status: 5 });
      },
      onError: (failure) => failures.push(failure),
    });
    assert.equal(value, null);
    assert.equal(failures[0].kind, "unresolved");
  });

  it("puts nothing but the name, the path, the kind and the exit code into the report", () => {
    const failures = [];
    fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("a-secret-value"), { status: 4 });
      },
      useCache: false,
      onError: (failure) => failures.push(failure),
    });
    assert.deepEqual(Object.keys(failures[0]).sort(), ["exitCode", "kind", "name", "path"]);
    assert.equal(JSON.stringify(failures[0]).includes("a-secret-value"), false);
  });

  it("does not let a broken report callback break the lookup", () => {
    const value = fleetSecretsGet("A_SECRET", {
      exec: () => {
        throw Object.assign(new Error("nope"), { status: 3 });
      },
      useCache: false,
      onError: () => {
        throw new Error("boom");
      },
    });
    assert.equal(value, null);
  });
});

describe("the um ingest token", () => {
  it("keeps the last good token when the helper cannot be reached", async () => {
    let clock = 1_700_000_000_000;
    let call = 0;
    const resolveToken = createTokenResolver({
      env: {},
      now: () => clock,
      getSecret: async (name, options) => {
        call += 1;
        if (call === 1) return "a-token";
        options.onError({ name, path: "/", kind: "unavailable", exitCode: 4 });
        return null;
      },
    });
    assert.equal(await resolveToken(), "a-token");
    clock += 10 * 60 * 1000;
    assert.equal(await resolveToken(), "a-token");
  });

  it("clears the token when the secret is genuinely not set", async () => {
    let clock = 1_700_000_000_000;
    const resolveToken = createTokenResolver({
      env: {},
      now: () => clock,
      getSecret: async (name, options) => {
        options.onError({ name, path: "/", kind: "absent", exitCode: 3 });
        return null;
      },
    });
    assert.equal(await resolveToken(), undefined);
    clock += 10 * 60 * 1000;
    assert.equal(await resolveToken(), undefined);
  });

  it("logs that the helper could not be reached without the token", async () => {
    const warnings = [];
    const resolveToken = createTokenResolver({
      env: {},
      now: () => 1_700_000_000_000,
      logger: {
        info() {},
        warn(message, fields) {
          warnings.push({ message, fields });
        },
        error() {},
      },
      getSecret: async (name, options) => {
        options.onError({ name, path: "/", kind: "missing-binary" });
        return null;
      },
    });
    await resolveToken();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].fields.kind, "missing-binary");
    assert.equal(JSON.stringify(warnings[0]).includes("a-token"), false);
  });
});
