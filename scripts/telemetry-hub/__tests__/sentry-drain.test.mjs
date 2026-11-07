// The sentry sender's bounded catch-up drain.
//
// One readLimit batch per pass could not keep pace when a collector drains
// a durable outbox into the receiver (the UM-1649 shape).  A pass now keeps
// reading until a short read, the wall-clock budget or the request-count
// budget stops it.  These tests pin the drain, the budgets and the resume
// behavior.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { Journal } from "../journal.mjs";
import { createSentrySender, DEFAULT_DRAIN_BUDGET_MS, DEFAULT_DRAIN_MAX_BATCHES } from "../sentry-sender.mjs";

const created = [];
const opened = [];

async function openJournal() {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-hub-drain-"));
  created.push(dir);
  const journal = new Journal({ dir });
  await journal.open();
  await journal.loadDestinations(["sentry"]);
  opened.push(journal);
  return journal;
}

function spanEvent(index) {
  return {
    eventId: `event-${String(index).padStart(4, "0")}`,
    ts: new Date(1700000000000 + index * 1000).toISOString(),
    kind: "span",
    platform: "a-agent",
    model: "a-model",
    operation: "chat",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    durationMs: 100,
    status: "ok",
  };
}

const okResponse = () => ({ status: 200, body: null });

function sender(journal, fetchCalls, options = {}) {
  return createSentrySender({
    journal,
    endpoint: "https://example.sentry.io/api/1/integration/otlp",
    publicKey: "a".repeat(32),
    fetchImpl: async () => {
      fetchCalls.push(1);
      const verdict = options.respond ? options.respond(fetchCalls.length) : "ok";
      if (verdict !== "ok") return { status: verdict, body: null };
      return okResponse();
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    retryDelayMs: 1,
    ...options,
  });
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

describe("the sentry sender drain", () => {
  it("drains a backlog larger than one readLimit batch in a single pass", async () => {
    const journal = await openJournal();
    await journal.appendBatch(Array.from({ length: 450 }, (_, i) => spanEvent(i)));
    const calls = [];
    const result = await sender(journal, calls).runOnce();
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 450);
    assert.ok(result.quarantined === 0);
    assert.equal(journal.getOffset("sentry") > 0, true);
  });

  it("stops at the request-count budget and resumes on the next pass", async () => {
    const journal = await openJournal();
    await journal.appendBatch(Array.from({ length: 450 }, (_, i) => spanEvent(i)));
    const calls = [];
    const limited = await sender(journal, calls, { drainMaxBatches: 1 }).runOnce();
    assert.equal(limited.ok, true);
    assert.equal(limited.delivered, 200);
    const calls2 = [];
    const rest = await sender(journal, calls2).runOnce();
    assert.equal(rest.ok, true);
    assert.equal(rest.delivered, 250);
    assert.equal(journal.getOffset("sentry") > 0, true);
  });

  it("stops at the wall-clock budget", async () => {
    const journal = await openJournal();
    await journal.appendBatch(Array.from({ length: 450 }, (_, i) => spanEvent(i)));
    const calls = [];
    const result = await sender(journal, calls, { drainBudgetMs: 0 }).runOnce();
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 200);
  });

  it("keeps delivered events when Sentry starts refusing mid-drain and resumes later", async () => {
    const journal = await openJournal();
    await journal.appendBatch(Array.from({ length: 450 }, (_, i) => spanEvent(i)));
    const calls = [];
    // the first request delivers a full batch; every later request 500s
    const failing = await sender(journal, calls, { respond: (n) => (n === 1 ? "ok" : 500) }).runOnce();
    assert.equal(failing.ok, false);
    assert.equal(failing.retry, true);
    assert.ok(failing.delivered > 0);
    assert.ok(failing.delivered < 450);
    const offsetAfterFailure = journal.getOffset("sentry");
    assert.ok(offsetAfterFailure > 0);
    const calls2 = [];
    const resumed = await sender(journal, calls2).runOnce();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.delivered, 450 - failing.delivered);
    assert.ok(journal.getOffset("sentry") > offsetAfterFailure);
  });

  it("answers empty for an empty journal", async () => {
    const journal = await openJournal();
    const calls = [];
    const result = await sender(journal, calls).runOnce();
    assert.deepEqual(result, { ok: true, delivered: 0, quarantined: 0, empty: true });
    assert.equal(calls.length, 0);
  });

  it("never resends an event the sent set already holds", async () => {
    const journal = await openJournal();
    await journal.appendBatch(Array.from({ length: 60 }, (_, i) => spanEvent(i)));
    await journal.markSentBatch("sentry", ["event-0000", "event-0001"]);
    const calls = [];
    const result = await sender(journal, calls).runOnce();
    assert.equal(result.delivered, 58);
  });
});

describe("drain defaults", () => {
  it("keep the pass bounded like the collector-side fix", () => {
    assert.equal(DEFAULT_DRAIN_MAX_BATCHES, 25);
    assert.equal(DEFAULT_DRAIN_BUDGET_MS, 5000);
  });
});
