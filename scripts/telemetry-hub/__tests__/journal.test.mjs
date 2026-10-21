// The journal test suite.
//
// The journal is the audit trail and the queue.  These tests cover the
// ordering, the per-destination offsets, the sent set that stops a resend,
// and the file modes that keep the content readable only by the user.
//
// This suite runs under Vitest, not node:test.  The repository's Vitest
// include is the default (`**/*.test.mjs`), so it collects every file in
// this directory.  A node:test suite collected this way is imported by
// Vitest, registers zero tests there, and fails the run with "No test suite
// found in file".  Vitest is a dev dependency only -- the hub itself runs on
// Node builtins alone, with no third-party package.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { Journal } from "../journal.mjs";
import { createUmSender } from "../um-sender.mjs";

const created = [];
const opened = [];

async function openJournal() {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-hub-test-"));
  created.push(dir);
  const journal = new Journal({ dir });
  await journal.open();
  await journal.loadDestinations(["um-turns", "um-ingest", "sentry"]);
  opened.push(journal);
  return { dir, journal };
}

function event(index, overrides = {}) {
  return {
    eventId: `event-${index}`,
    ts: new Date(1700000000000 + index * 1000).toISOString(),
    platform: "opencode",
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

describe("the journal", () => {
  it("appends events in order, one JSON object per line (case 11)", async () => {
    const { dir, journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(2));
    await journal.append(event(3));
    await journal.close();

    const raw = await readFile(join(dir, "journal.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((item) => item.eventId),
      ["event-1", "event-2", "event-3"],
    );
    assert.equal(parsed[0].promptText, "prompt 1");
  });

  it("advances the um offset and the sentry offset independently (case 12)", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(2));

    assert.equal(journal.getOffset("um-turns"), 0);
    assert.equal(journal.getOffset("sentry"), 0);

    await journal.setOffset("um-turns", 120);
    assert.equal(journal.getOffset("um-turns"), 120);
    assert.equal(journal.getOffset("sentry"), 0);

    await journal.setOffset("sentry", 240);
    assert.equal(journal.getOffset("sentry"), 240);
    assert.equal(journal.getOffset("um-turns"), 120);

    await journal.setOffset("um-turns", 360);
    assert.equal(journal.getOffset("sentry"), 240);
  });

  it("does not advance an offset when the delivery failed (case 13)", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(2));

    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      retryDelayMs: 0,
      fetchImpl: async () => fakeResponse(503, "server error"),
    });
    const outcome = await sender.runOnce();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.retry, true);
    assert.equal(journal.getOffset("um-turns"), 0);
    assert.equal(journal.getOffset("um-ingest"), 0);

    const healthy = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      retryDelayMs: 0,
      fetchImpl: async () => fakeResponse(200, "{}"),
    });
    const ok = await healthy.runOnce();
    assert.equal(ok.ok, true);
    assert.ok(journal.getOffset("um-turns") > 0);
    assert.ok(journal.getOffset("um-ingest") > 0);
  });

  it("does not offer an event again once it is in the sent set (case 14)", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(2));

    const first = await journal.readBatch("sentry", 10);
    assert.equal(first.events.length, 2);

    await journal.markSent("sentry", "event-1");
    assert.equal(journal.isSent("sentry", "event-1"), true);
    assert.equal(journal.isSent("um-turns", "event-1"), false);

    const second = await journal.readBatch("sentry", 10);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].eventId, "event-2");
    //  The skipped line is still consumed, so it never blocks the events
    //  behind it.
    assert.ok(second.endOffset > first.endOffset - 1);
  });

  it("creates the state directory with mode 700 and the journal with mode 600 (case 15)", async () => {
    const { dir, journal } = await openJournal();
    await journal.append(event(1));
    await journal.close();

    const dirMode = (await stat(dir)).mode & 0o777;
    const journalMode = (await stat(join(dir, "journal.jsonl"))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(journalMode, 0o600);
  });
});

describe("the um sender", () => {
  it("quarantines one poisoned event and delivers the rest of the batch", async () => {
    const { dir, journal } = await openJournal();
    await journal.append(event(1));
    await journal.append(event(2, { sessionId: "poison" }));
    await journal.append(event(3));

    const seen = [];
    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      retryDelayMs: 0,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        const turns = Array.isArray(body.turns) ? body.turns : [];
        seen.push(turns.length);
        const poisoned = turns.some((turn) => turn.conversationId === "poison");
        return poisoned ? fakeResponse(400, "{\"error\":\"bad turn\"}") : fakeResponse(200, "{}");
      },
    });
    const outcome = await sender.runOnce();
    assert.equal(outcome.ok, true);

    const deadLetter = await readFile(join(dir, "dead-letter.jsonl"), "utf8");
    const quarantined = deadLetter
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].eventId, "event-2");
    //  The dead-letter record never carries content.
    assert.equal(JSON.stringify(quarantined[0]).includes("prompt"), false);

    //  The good events were delivered, so the offset moved past the poison.
    assert.ok(journal.getOffset("um-turns") > 0);
  });

  it("never advances an offset in dry-run mode, even for an empty batch", async () => {
    const { journal } = await openJournal();
    //  A log record with no usage produces no ledger row, so the ledger batch
    //  builds to an empty payload.  That early return must still carry the
    //  dry-run flag, or the offset advances and the events are skipped for
    //  every later real run.
    await journal.append(event(1, { kind: "log", costUsd: undefined, tokens: {} }));

    const sender = createUmSender({
      journal,
      dryRun: true,
      resolveToken: async () => "a-test-token",
      fetchImpl: async () => {
        throw new Error("dry-run must not write to the network");
      },
    });

    const outcome = await sender.runOnce();
    assert.equal(outcome.ok, true);
    assert.equal(journal.getOffset("um-turns"), 0);
    assert.equal(journal.getOffset("um-ingest"), 0);
  });

  it("does not post a log record to the um turns channel as a turn", async () => {
    const { journal } = await openJournal();
    await journal.append(event(1, { kind: "log" }));

    const posted = [];
    const sender = createUmSender({
      journal,
      resolveToken: async () => "a-test-token",
      retryDelayMs: 0,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.turns)) posted.push(...body.turns);
        return fakeResponse(200, "{}");
      },
    });
    await sender.runOnce();

    assert.deepEqual(posted, []);
  });

  it("delivers a duplicate event id inside one batch only once", async () => {
    const { journal } = await openJournal();
    //  The journal can hold the same signal twice; both copies sit behind the
    //  same offset, so readBatch itself has to drop the repeat.
    await journal.append(event(1));
    await journal.append(event(1));
    await journal.append(event(2));

    const batch = await journal.readBatch("sentry", 10);
    assert.deepEqual(
      batch.events.map((item) => item.eventId),
      ["event-1", "event-2"],
    );
  });

  it("writes the state file atomically when two writes overlap", async () => {
    const { dir, journal } = await openJournal();
    //  Two concurrent writers of the SAME state file used to share one
    //  `.tmp` path, so the second truncated the body the first was about to
    //  rename, and a truncated offset file reads back as offset 0 -- which
    //  re-delivers the whole journal.
    await Promise.all([
      journal.setOffset("sentry", 111),
      journal.setOffset("sentry", 222),
      journal.setOffset("sentry", 333),
    ]);
    const persisted = JSON.parse(
      await readFile(join(dir, "state", "sentry.offset.json"), "utf8"),
    );
    assert.equal(persisted.offset, journal.getOffset("sentry"));
  });

  it("appends a whole batch with one durable write", async () => {
    const { dir, journal } = await openJournal();
    const written = await journal.appendBatch([event(1), event(2), event(3)]);
    await journal.close();

    const raw = await readFile(join(dir, "journal.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).eventId),
      ["event-1", "event-2", "event-3"],
    );
    assert.equal(written, Buffer.byteLength(raw, "utf8"));
    assert.equal(await journal.appendBatch([]), 0);
  });
});
