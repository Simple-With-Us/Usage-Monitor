import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { Journal } from "./telemetry-hub/journal.mjs";
import { createSentrySender, MAX_SENTRY_ACK_BYTES } from "./telemetry-hub/sentry-sender.mjs";

const PRIVATE = "PRIVATE_RESPONSE_CONTENT_https://secret@example.test/private";
const id = (n) => n.toString(16).padStart(64, "0");
function event(n, kind = "log") {
  return { eventId: id(n), ts: "2026-10-30T12:00:00Z", kind, platform: "claude-code", operation: "chat", model: "claude-test", tokens: { input: n, output: 2 }, ...(kind === "span" ? { durationMs: 1 } : {}), promptText: PRIVATE, responseText: PRIVATE, sessionId: PRIVATE, project: PRIVATE };
}
class FaultJournal extends Journal {
  async syncStateFile(file) {
    if (this.failFileSync) throw Object.assign(new Error("Injected fsync failure"), { code: "EIO" });
    await super.syncStateFile(file);
  }
  async syncStateDirectory() {
    if (this.failDirectorySync) throw Object.assign(new Error("Injected directory fsync failure"), { code: "EIO" });
    await super.syncStateDirectory();
  }
}
async function fixture(t, events = [event(1), event(2), event(3)]) {
  const dir = await mkdtemp(join(tmpdir(), "sentry-ack-"));
  const opened = [];
  t.after(async () => { for (const journal of opened) await journal.close(); await rm(dir, { recursive: true, force: true }); });
  const reopen = async () => {
    const journal = new FaultJournal({ dir });
    await journal.open(); await journal.loadDestinations(["sentry"]); opened.push(journal);
    return journal;
  };
  const journal = await reopen();
  await journal.appendBatch(events);
  const sender = (j, fetchImpl, logger) => createSentrySender({ journal: j, endpoint: "https://example.sentry.io/api/1/integration/otlp", publicKey: "test-only-public-key", fetchImpl, logger, retryDelayMs: 0 });
  return { dir, journal, reopen, sender };
}
const holdPath = (dir) => join(dir, "state", "sentry-request.json");

test("positive partial ACK holds the entire scrubbed batch without claiming all records rejected", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const warnings = [];
  const logger = { info() {}, error() {}, warn(message, fields) { warnings.push({ message, fields }); } };
  const sender = f.sender(f.journal, async (_url, init) => {
    requests++;
    const prepared = await f.journal.readSentryRequest();
    assert.equal(prepared.phase, "prepared");
    assert.equal(prepared.events.length, 3);
    assert.ok(!gunzipSync(init.body).toString().includes(PRIVATE));
    return Response.json({ partialSuccess: { rejectedLogRecords: "1", errorMessage: PRIVATE } });
  }, logger);
  const result = await sender.runOnce();
  assert.equal(result.held, true);
  assert.equal(result.retry, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.quarantined, 0);
  assert.equal(result.heldEvents, 3);
  assert.equal(result.rejectedCount, 1);
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.ok([1, 2, 3].every((n) => !f.journal.isSent("sentry", id(n))));
  const raw = await readFile(holdPath(f.dir), "utf8");
  const held = JSON.parse(raw);
  assert.equal(held.phase, "held");
  assert.equal(held.responseClass, "partial_success");
  assert.equal(held.rejectedCount, 1);
  assert.deepEqual(held.eventIds, [id(1), id(2), id(3)]);
  assert.equal(held.events[2].attributes.find((a) => a.key === "gen_ai.usage.input_tokens").value.intValue, "3");
  assert.ok(!raw.includes(PRIVATE));
  assert.ok(!raw.includes("errorMessage"));
  assert.ok(!raw.includes("public-key"));
  assert.equal((await stat(holdPath(f.dir))).mode & 0o777, 0o600);
  await sender.runOnce(); await sender.runOnce();
  assert.equal(requests, 1);
  assert.equal(warnings.filter((row) => row.message === "sentry delivery is held").length, 1);
  assert.ok(!JSON.stringify(warnings).includes(id(1)));
  await f.journal.close();
  const restarted = await f.reopen();
  const restartWarnings = [];
  const restartedSender = f.sender(restarted, async () => { assert.fail("A partial batch must not be retried after restart"); }, { ...logger, warn: (message, fields) => restartWarnings.push({ message, fields }) });
  assert.equal((await restartedSender.runOnce()).held, true);
  await restartedSender.runOnce();
  assert.equal(restartWarnings.length, 1);
  assert.equal(restartWarnings[0].fields.rejectedCount, 1);
  await restarted.compactTo(restarted.base + await restarted.fileSize());
  assert.equal(await restarted.fileSize(), 0);
  assert.equal((await restarted.readSentryRequest()).events.length, 3);
});

test("trace partial counts use their own schema and preserve stable held identities", async (t) => {
  const f = await fixture(t, [event(1, "span"), event(2, "span")]);
  const result = await f.sender(f.journal, async (url) => {
    assert.ok(url.endsWith("/v1/traces"));
    return Response.json({ partialSuccess: { rejectedSpans: 1 } });
  }).runOnce();
  assert.equal(result.held, true);
  assert.equal(result.rejectedCount, 1);
  const held = await f.journal.readSentryRequest();
  assert.equal(held.signal, "traces");
  assert.deepEqual(held.eventIds, [id(1), id(2)]);
});

test("normal empty and JSON ACKs, zero warnings and valid int64 strings deliver normally", async (t) => {
  for (const [name, response] of [
    ["empty", () => new Response(null, { status: 200 })],
    ["empty-protobuf", () => new Response(null, { headers: { "content-type": "application/x-protobuf" } })],
    ["json", () => Response.json({})],
    ["zero-number-warning", () => Response.json({ partialSuccess: { rejectedLogRecords: 0, errorMessage: PRIVATE } })],
    ["zero-string-warning", () => Response.json({ partialSuccess: { rejectedLogRecords: "0", errorMessage: PRIVATE } })],
    ["zero-snake", () => Response.json({ partial_success: { rejected_log_records: "0", error_message: PRIVATE } })],
  ]) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    let requests = 0;
    const sender = f.sender(f.journal, async () => { requests++; return response(); });
    const result = await sender.runOnce();
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 3);
    assert.equal(result.quarantined, 0);
    assert.equal(requests, 1);
    assert.equal(await f.journal.readSentryRequest(), null);
    assert.ok([1, 2, 3].every((n) => f.journal.isSent("sentry", id(n))));
    assert.ok(f.journal.getOffset("sentry") > 0);
  });
});

test("invalid or oversized 2xx acknowledgements become typed holds without retries", async (t) => {
  for (const [name, make, expected] of [
    ["invalid-json", () => new Response(PRIVATE, { headers: { "content-type": "application/json" } }), "malformed_ack"],
    ["oversized", () => new Response("x".repeat(MAX_SENTRY_ACK_BYTES + 1), { headers: { "content-type": "application/json" } }), "oversized_ack"],
    ["negative", () => Response.json({ partialSuccess: { rejectedLogRecords: -1 } }), "malformed_ack"],
    ["boolean", () => Response.json({ partialSuccess: { rejectedLogRecords: true } }), "malformed_ack"],
    ["fraction", () => Response.json({ partialSuccess: { rejectedLogRecords: 0.5 } }), "malformed_ack"],
    ["unsafe", () => Response.json({ partialSuccess: { rejectedLogRecords: "9007199254740992" } }), "malformed_ack"],
    ["above-submitted", () => Response.json({ partialSuccess: { rejectedLogRecords: 4 } }), "malformed_ack"],
    ["wrong-signal", () => Response.json({ partialSuccess: { rejectedSpans: 0 } }), "malformed_ack"],
    ["both-names", () => Response.json({ partialSuccess: {}, partial_success: {} }), "malformed_ack"],
    ["unknown-field", () => Response.json({ error: PRIVATE }), "malformed_ack"],
    ["null", () => Response.json(null), "malformed_ack"],
    ["empty-html", () => new Response(null, { headers: { "content-type": "text/html" } }), "unexpected_content_type"],
    ["html-json", () => new Response("{}", { headers: { "content-type": "text/html" } }), "unexpected_content_type"],
    ["stream-failure", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(PRIVATE)); } })), "unreadable_ack"],
  ]) await t.test(name, async (sub) => {
    const f = await fixture(sub);
    let requests = 0;
    const sender = f.sender(f.journal, async () => { requests++; return make(); });
    const result = await sender.runOnce();
    assert.equal(result.held, true);
    assert.equal(result.responseClass, expected);
    assert.equal(result.delivered, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(f.journal.getOffset("sentry"), 0);
    await sender.runOnce();
    assert.equal(requests, 1);
    const raw = await readFile(holdPath(f.dir), "utf8");
    assert.ok(!raw.includes(PRIVATE));
    assert.equal(JSON.parse(raw).responseClass, expected);
  });
});

test("pre-POST fsync failure sends nothing and never advances offset or sent state", async (t) => {
  const f = await fixture(t);
  f.journal.failFileSync = true;
  const sender = f.sender(f.journal, async () => { assert.fail("No request before durable intent"); });
  await assert.rejects(sender.runOnce(), { code: "EIO" });
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.equal(f.journal.isSent("sentry", id(1)), false);
  assert.equal((await sender.runOnce()).held, true);
  await assert.rejects(f.journal.setOffset("sentry", 123), { code: "EIO" });
  assert.equal(f.journal.getOffset("sentry"), 0);
  await assert.rejects(f.journal.markSentBatch("sentry", [id(1)]), { code: "EIO" });
  assert.equal(f.journal.isSent("sentry", id(1)), false);
});

test("pre-POST directory fsync failure leaves an intent and makes no request even after restart", async (t) => {
  const f = await fixture(t);
  f.journal.failDirectorySync = true;
  const sender = f.sender(f.journal, async () => { assert.fail("Directory durability precedes POST"); });
  await assert.rejects(sender.runOnce(), { code: "EIO" });
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.equal((await f.journal.readSentryRequest()).phase, "prepared");
  assert.equal(f.journal.isSent("sentry", id(1)), false);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal((await f.sender(restart, async () => { assert.fail("An unresolved published intent must not be retried"); }).runOnce()).held, true);
});

test("a partial response followed by hold fsync failure retains the pre-POST intent across restart", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const sender = f.sender(f.journal, async () => {
    requests++; f.journal.failFileSync = true;
    return Response.json({ partialSuccess: { rejectedLogRecords: 1, errorMessage: PRIVATE } });
  });
  await assert.rejects(sender.runOnce(), { code: "EIO" });
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.equal(f.journal.isSent("sentry", id(1)), false);
  assert.equal((await f.journal.readSentryRequest()).phase, "prepared");
  await sender.runOnce();
  assert.equal(requests, 1);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal((await f.sender(restart, async () => { assert.fail("Unknown outcome must not be re-posted"); }).runOnce()).held, true);
  assert.ok(!(await readFile(holdPath(f.dir), "utf8")).includes(PRIVATE));
});

test("full ACK sent-state fsync failure retains unresolved intent rather than replaying accepted data", async (t) => {
  const f = await fixture(t);
  const sender = f.sender(f.journal, async () => { f.journal.failFileSync = true; return Response.json({}); });
  await assert.rejects(sender.runOnce(), { code: "EIO" });
  assert.equal(f.journal.isSent("sentry", id(1)), false);
  assert.equal(f.journal.getOffset("sentry"), 0);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal((await f.sender(restart, async () => { assert.fail("No automatic ambiguous replay"); }).runOnce()).held, true);
});

test("a crash before intent removal preserves confirmed sent receipts and still fails closed on restart", async (t) => {
  const f = await fixture(t);
  f.journal.clearSentryRequest = async () => { throw Object.assign(new Error("Injected interruption"), { code: "EIO" }); };
  await assert.rejects(f.sender(f.journal, async () => Response.json({})).runOnce(), { code: "EIO" });
  assert.equal(f.journal.isSent("sentry", id(1)), true);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal(restart.isSent("sentry", id(1)), true);
  assert.equal((await f.sender(restart, async () => { assert.fail("A restart must not repeat an unresolved request"); }).runOnce()).held, true);
});

test("corrupt durable intent blocks delivery and warns only once without exposing state bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(holdPath(f.dir), PRIVATE, { mode: 0o600 });
  const warnings = [];
  const sender = f.sender(f.journal, async () => { assert.fail("Corrupt intent is not permission to send"); }, { info() {}, error() {}, warn(message, fields) { warnings.push({ message, fields }); } });
  await sender.runOnce(); await sender.runOnce();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fields.responseClass, "invalid_request_state");
  assert.ok(!JSON.stringify(warnings).includes(PRIVATE));
});

test("explicit transient failures retain the existing retry contract without persisting response text", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const result = await f.sender(f.journal, async () => {
    requests++;
    assert.equal((await f.journal.readSentryRequest()).phase, "prepared");
    return requests === 1 ? new Response(PRIVATE, { status: 429 }) : Response.json({});
  }).runOnce();
  assert.equal(requests, 2);
  assert.equal(result.delivered, 3);
  assert.equal(result.ok, true);
  assert.equal(await f.journal.readSentryRequest(), null);
  for (const name of await readdir(join(f.dir, "state"))) assert.ok(!(await readFile(join(f.dir, "state", name), "utf8")).includes(PRIVATE));
});

test("existing HTTP 400 isolation delivers valid siblings and never persists rejection text", async (t) => {
  const f = await fixture(t, [event(1), { ...event(2), model: "bad-model" }, event(3)]);
  const sender = f.sender(f.journal, async (_url, init) => {
    const payload = JSON.parse(gunzipSync(init.body));
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    const poisoned = records.some((record) => record.attributes.some((attr) => attr.key === "gen_ai.request.model" && attr.value.stringValue === "bad-model"));
    return poisoned ? new Response(PRIVATE, { status: 400 }) : Response.json({});
  });
  const result = await sender.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 2);
  assert.equal(result.quarantined, 1);
  assert.ok([1, 2, 3].every((n) => f.journal.isSent("sentry", id(n))));
  assert.ok(f.journal.getOffset("sentry") > 0);
  assert.equal(await f.journal.readSentryRequest(), null);
  const rejected = await readFile(join(f.dir, "dead-letter.jsonl"), "utf8");
  assert.ok(!rejected.includes(PRIVATE));
  assert.equal(rejected.trim().split('\n').length, 1);
  assert.equal(JSON.parse(rejected).httpStatus, 400);
  assert.equal((await sender.runOnce()).delivered, 0);
});

test("a later log partial hold preserves an earlier confirmed trace chunk and its durable sent receipt", async (t) => {
  const f = await fixture(t, [event(1, "span"), event(2), event(3)]);
  const sender = f.sender(f.journal, async (url) => url.endsWith('/v1/traces') ? Response.json({}) : Response.json({ partialSuccess: { rejectedLogRecords: 1 } }));
  const result = await sender.runOnce();
  assert.equal(result.held, true);
  assert.equal(result.delivered, 1);
  assert.equal(result.heldEvents, 2);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.quarantined, 0);
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.equal(f.journal.isSent("sentry", id(1)), true);
  assert.equal(f.journal.isSent("sentry", id(2)), false);
  assert.deepEqual((await f.journal.readSentryRequest()).eventIds, [id(2), id(3)]);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal(restart.isSent("sentry", id(1)), true);
  assert.equal((await f.sender(restart, async () => { assert.fail("Neither the accepted trace nor ambiguous logs may be replayed"); }).runOnce()).held, true);
});

test("base-state fsync failure before compaction preserves the original journal and held request", async (t) => {
  const f = await fixture(t);
  await f.sender(f.journal, async () => Response.json({ partialSuccess: { rejectedLogRecords: 1 } })).runOnce();
  const before = await readFile(join(f.dir, "journal.jsonl"));
  const held = await readFile(holdPath(f.dir));
  f.journal.failFileSync = true;
  await assert.rejects(f.journal.compactTo(f.journal.base + await f.journal.fileSize()), { code: "EIO" });
  assert.equal(f.journal.base, 0);
  assert.equal(f.journal.getOffset("sentry"), 0);
  assert.deepEqual(await readFile(join(f.dir, "journal.jsonl")), before);
  assert.deepEqual(await readFile(holdPath(f.dir)), held);
  await f.journal.close();
  const restart = await f.reopen();
  assert.equal(restart.base, 0);
  assert.equal((await restart.readBatch("sentry", 100)).events.length, 3);
  assert.equal((await f.sender(restart, async () => { assert.fail("Compaction failure must not re-post the held request"); }).runOnce()).held, true);
});
