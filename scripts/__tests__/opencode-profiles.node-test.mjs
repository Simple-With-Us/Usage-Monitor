import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  collectOpencodeDatabases,
  collectOpencodeEvents,
  opencodeDbPaths,
  readFrozenProjectNames,
  writeFrozenProjectNames,
} from "../opencode-usage-collector.mjs";
import { canAdvanceCollectorCheckpoint } from "../lib/run-session-token-collector.mjs";
import { collectorSentryEvents } from "../lib/collector-sentry-bridge.mjs";

const BASE = 1_792_000_000_000;
const PRIVATE_CONTENT = "private prompt and response must never enter telemetry";

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "opencode-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fixture(path, { session = "ses_primary", message = "msg_primary", child = false, dual = false, agent = "build" } = {}) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)");
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER)");
  if (dual) {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    db.prepare("INSERT INTO session VALUES (?, ?)").run(session, "/obsolete/profile");
  }
  db.prepare("INSERT INTO session_v2 (id,directory,tokens_input,tokens_output,tokens_cache_read,time_created,time_updated) VALUES (?,?,?,?,?,?,?)").run(session, child ? "/home/test/.botfleet/workspaces/child-project" : "/home/test/primary-project", 999999, 999999, 999999, BASE, BASE + 1000);
  const data = {
    time: { created: BASE, completed: BASE + 1000 },
    model: { id: "fixture-model", providerID: "opencode" },
    tokens: { input: child ? 9414 : 10, output: 2, reasoning: 0, cache: { read: child ? 512 : 3, write: 0 } },
    cost: 0,
    agent,
    prompt: PRIVATE_CONTENT,
    response: PRIVATE_CONTENT,
  };
  db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(message, session, "assistant", 1, BASE, BASE + 1000, JSON.stringify(data));
  db.close();
}

const tokenRows = (events) => events.filter((event) => event.metricType === "usage" && event.unit === "token");

test("explicit additional profiles preserve the ordinary source and bound selection", () => {
  assert.deepEqual(opencodeDbPaths({ OPENCODE_DB: "/primary.db" }), ["/primary.db"]);
  assert.deepEqual(opencodeDbPaths({ OPENCODE_DB: "primary.db" }), [resolve("primary.db")]);
  assert.deepEqual(opencodeDbPaths({ OPENCODE_DB: "/primary.db", OPENCODE_ADDITIONAL_DBS_JSON: '["/child.db"]' }), ["/primary.db", "/child.db"]);
  for (const value of ["not-json", "null", '"/child.db"', '["relative.db"]', '[1]', JSON.stringify(["/bad\0.db"]), JSON.stringify(Array(9).fill("/child.db"))]) {
    assert.throws(() => opencodeDbPaths({ OPENCODE_DB: "/primary.db", OPENCODE_ADDITIONAL_DBS_JSON: value }), /bounded array/);
  }
});

test("a v2-only child source adds exact calls and cache reads without substituting session totals", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  const child = join(root, "child.db");
  fixture(primary, { dual: true });
  fixture(child, { session: "ses_child", message: "msg_child", child: true });
  const before = await Promise.all([primary, child].map((path) => readFile(path)));
  const standalone = await collectOpencodeEvents({ dbPath: primary, since: new Date(0) });
  const scanStatus = { complete: true };
  const events = await collectOpencodeDatabases({ dbPaths: [primary, child], since: new Date(0), scanStatus });
  assert.equal(scanStatus.complete, true);
  assert.deepEqual(events.slice(0, standalone.length), standalone);
  const rows = tokenRows(events).filter((event) => event.metadata["session.id"] === "ses_child");
  assert.deepEqual(rows.map((event) => [event.label, event.quantity]), [["token:input", 9414], ["token:output", 2], ["token:cacheRead", 512]]);
  assert.ok(rows.every((event) => event.metadata["agent.launcher"] === "botfleet"));
  assert.ok(!JSON.stringify(events).includes(PRIVATE_CONTENT));
  assert.ok(!JSON.stringify(events).includes(child));
  assert.equal(events.filter((event) => event.metricType === "cost").length, 0);
  const spans = collectorSentryEvents(events, { producerId: "opencode", producerInstanceId: "fixture" });
  assert.equal(spans.length, 2);
  assert.ok(spans.every((event) => event.kind === "span"));
  assert.deepEqual(await Promise.all([primary, child].map((path) => readFile(path))), before);
});

test("repeated paths, symlinks and copied profiles preserve one set of existing event identities", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  const alias = join(root, "alias.db");
  const copy = join(root, "copy.db");
  fixture(primary);
  await symlink(primary, alias);
  await copyFile(primary, copy);
  const standalone = await collectOpencodeEvents({ dbPath: primary, since: new Date(0) });
  const scanStatus = { complete: true };
  const events = await collectOpencodeDatabases({ dbPaths: [primary, primary, alias, copy], since: new Date(0), scanStatus });
  assert.equal(scanStatus.complete, true);
  assert.deepEqual(events, standalone);
  assert.equal(collectorSentryEvents(events, { producerId: "opencode", producerInstanceId: "fixture" }).length, 1);
});

test("profiles share durable frozen project names across replay and source order changes", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  const copy = join(root, "copy.db");
  const state = join(root, "project-names.json");
  fixture(primary);
  await copyFile(primary, copy);
  const frozen = new Map();
  const first = await collectOpencodeDatabases({ dbPaths: [primary, copy], since: new Date(0), frozenProjectNames: frozen });
  await writeFrozenProjectNames(state, frozen);
  for (const path of [primary, copy]) {
    const db = new DatabaseSync(path);
    db.prepare("UPDATE session_v2 SET directory=?").run("/new/project-name");
    db.close();
  }
  const second = await collectOpencodeDatabases({ dbPaths: [copy, primary], since: new Date(0), frozenProjectNames: await readFrozenProjectNames(state) });
  assert.deepEqual(second, first);
  assert.ok(second.every((event) => event.project === "primary-project"));
});

test("missing and unreadable explicit sources retain the checkpoint while other sources still flow", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  fixture(primary);
  const corrupt = join(root, "corrupt.db");
  await writeFile(corrupt, "not a SQLite database");
  for (const source of [join(root, "absent.db"), root, corrupt]) {
    const scanStatus = { complete: true };
    const warnings = [];
    const events = await collectOpencodeDatabases({ dbPaths: [primary, source], since: new Date(0), scanStatus, onWarning: (message) => warnings.push(message) });
    assert.ok(tokenRows(events).length > 0);
    assert.equal(scanStatus.complete, false);
    assert.equal(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: scanStatus.complete }), false);
    assert.ok(warnings.some((message) => message.includes("checkpoint retained")));
    assert.ok(warnings.every((message) => !message.includes(root)));
  }
  await assert.rejects(() => collectOpencodeDatabases({ dbPaths: Array(10).fill(primary) }), /one to nine/);
});

test("missing implicit default paths are empty while explicit and additional missing paths retain the checkpoint", async (t) => {
  const root = await harness(t);
  const missingPrimary = join(root, "default", "opencode.db");
  const blockingParent = join(root, "blocking-file");
  const blockedPrimary = join(blockingParent, "opencode.db");
  const child = join(root, "child.db");
  await writeFile(blockingParent, "a file blocking the database parent path");
  fixture(child, { session: "ses_child", message: "msg_child", child: true });
  const childEvents = await collectOpencodeEvents({ dbPath: child, since: new Date(0) });

  const implicitScan = { complete: true };
  const implicitEvents = await collectOpencodeDatabases({
    dbPaths: [missingPrimary, child],
    allowMissingPrimary: true,
    since: new Date(0),
    scanStatus: implicitScan,
  });
  assert.deepEqual(implicitEvents, childEvents);
  assert.equal(implicitScan.complete, true);
  assert.equal(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: implicitScan.complete }), true);

  const blockedImplicitScan = { complete: true };
  const blockedImplicitEvents = await collectOpencodeDatabases({
    dbPaths: [blockedPrimary, child],
    allowMissingPrimary: true,
    since: new Date(0),
    scanStatus: blockedImplicitScan,
  });
  assert.deepEqual(blockedImplicitEvents, childEvents);
  assert.equal(blockedImplicitScan.complete, true);
  assert.equal(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: blockedImplicitScan.complete }), true);

  const explicitScan = { complete: true };
  const explicitWarnings = [];
  const explicitEvents = await collectOpencodeDatabases({
    dbPaths: [blockedPrimary, child],
    allowMissingPrimary: false,
    since: new Date(0),
    scanStatus: explicitScan,
    onWarning: (message) => explicitWarnings.push(message),
  });
  assert.deepEqual(explicitEvents, childEvents);
  assert.equal(explicitScan.complete, false);
  assert.equal(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: explicitScan.complete }), false);
  assert.ok(explicitWarnings.some((message) => message.includes("checkpoint retained")));

  const additionalScan = { complete: true };
  const additionalEvents = await collectOpencodeDatabases({
    dbPaths: [child, blockedPrimary],
    allowMissingPrimary: true,
    since: new Date(0),
    scanStatus: additionalScan,
  });
  assert.deepEqual(additionalEvents, childEvents);
  assert.equal(additionalScan.complete, false);
  assert.equal(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: additionalScan.complete }), false);
});

test("an older profile without v2 session facts keeps its existing token event identities", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  fixture(primary, { dual: true });
  const db = new DatabaseSync(primary);
  db.exec("DROP TABLE session_v2");
  db.close();
  const standalone = await collectOpencodeEvents({ dbPath: primary, since: new Date(0) });
  const scanStatus = { complete: true };
  const events = await collectOpencodeDatabases({ dbPaths: [primary], since: new Date(0), scanStatus });
  assert.deepEqual(events, standalone);
  assert.equal(scanStatus.complete, true);
  assert.equal(tokenRows(events).length, 3);
  assert.ok(events.every((event) => event.project === undefined));
});

test("conflicting replay identities preserve primary payload and prevent checkpoint advancement", async (t) => {
  const root = await harness(t);
  const primary = join(root, "primary.db");
  const copy = join(root, "copy.db");
  fixture(primary);
  fixture(copy, { agent: "other-agent" });
  const scanStatus = { complete: true };
  const warnings = [];
  const events = await collectOpencodeDatabases({ dbPaths: [primary, copy], since: new Date(0), scanStatus, onWarning: (message) => warnings.push(message) });
  assert.equal(scanStatus.complete, false);
  assert.equal(warnings.filter((message) => message.includes("disagree")).length, 1);
  assert.ok(tokenRows(events).every((event) => event.metadata.agent === "build"));
  assert.equal(new Set(tokenRows(events).map((event) => event.eventId)).size, tokenRows(events).length);
});
