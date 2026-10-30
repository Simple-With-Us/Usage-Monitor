import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectMinimaxRuntimeEvents } from "./minimax-runtime-usage-collector.mjs";
import { botFleetRuntimeTelemetry, projectBotFleetRuntimeEvent } from "./lib/botfleet-session-telemetry.mjs";
import { collectBotFleetSessionTelemetry } from "./botfleet-session-collector.mjs";
import { drainCollectorSentry, enqueueCollectorSentryTelemetry } from "./lib/collector-sentry-bridge.mjs";

const nativeBase = { provider: "claude", providerInstanceId: "instance", threadId: "thread", turnId: "turn" };
const started = { ...nativeBase, eventId: "native-start", type: "turn.started", createdAt: "2026-10-30T12:00:00Z", raw: { payload: "PRIVATE_CONTENT" } };
const completed = { ...nativeBase, eventId: "native-complete", type: "turn.completed", createdAt: "2026-10-30T12:00:01.250Z", ok: false, servedModel: "claude-test", usage: { input: 25, cachedInput: 10, cacheWrite5m: 2, cacheWrite1h: 1, reasoning: 1 }, cost: 999, billingMode: "actual", raw: { payload: "PRIVATE_CONTENT" }, response: "PRIVATE_CONTENT" };
const selected = (records) => records.map(projectBotFleetRuntimeEvent).filter(Boolean);
const nativeWindow = { since: new Date("2026-10-30T00:00:00Z"), until: new Date("2026-10-31T00:00:00Z") };

test("BotFleet native aggregates preserve unknown tokens and exact timing without content or vendor guesses", () => {
  const [event] = botFleetRuntimeTelemetry(selected([completed, started, started, completed]), { producerInstanceId: "test-host" });
  assert.equal(event.operation, "botfleet.turn");
  assert.equal(event.kind, "span");
  assert.equal(event.ts, started.createdAt.replace("Z", ".000Z"));
  assert.equal(event.durationMs, 1250);
  assert.equal(event.status, "error");
  assert.deepEqual(event.tokens, { input: 25, cacheRead: 10, reasoning: 1, cacheCreation: 3 });
  assert.equal(event.vendor, undefined);
  assert.equal(event.tokens.output, undefined);
  assert.ok(!JSON.stringify(event).includes("PRIVATE_CONTENT"));
  assert.equal(event.cost, undefined);
  const [unknown] = botFleetRuntimeTelemetry(selected([{ ...completed, eventId: "unknown", usage: {}, servedModel: undefined, model: "must-not-infer" }]), { producerInstanceId: "test-host" });
  assert.equal(unknown.kind, "log");
  assert.equal(unknown.durationMs, undefined);
  assert.deepEqual(unknown.tokens, {});
  assert.equal(unknown.model, undefined);
  const [unknownOutcome] = botFleetRuntimeTelemetry(selected([started, { ...completed, ok: undefined }]), { producerInstanceId: "test-host" });
  assert.equal(unknownOutcome.kind, "log");
  assert.equal(unknownOutcome.status, undefined);
  const [ambiguous] = botFleetRuntimeTelemetry(selected([started, { ...started, eventId: "another-start" }, completed]), { producerInstanceId: "test-host" });
  assert.equal(ambiguous.kind, "log");
  assert.equal(ambiguous.durationMs, undefined);
  const [otherHost] = botFleetRuntimeTelemetry(selected([started, completed]), { producerInstanceId: "other-host" });
  assert.notEqual(otherHost.eventId, event.eventId);
});

test("native reader handles rotation, content, malformed lines and explicit history gaps without source deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-events-"));
  try {
    const gap = { eventId: "history-gap", type: "runtime.error", raw: { source: "botfleet.event-log", payload: { kind: "dropped" } }, message: "PRIVATE_CONTENT" };
    await writeFile(join(root, "thread.ndjson.1"), [started, gap, { type: "item.completed", content: "PRIVATE_CONTENT" }].map(JSON.stringify).join("\n") + "\n");
    await writeFile(join(root, "thread.ndjson"), [started, completed, gap].map(JSON.stringify).join("\n") + "\ninvalid-json\n");
    await writeFile(join(root, "ignored.txt"), JSON.stringify({ ...completed, eventId: "must-not-read" }));
    await symlink(join(root, "ignored.txt"), join(root, "ignored.ndjson"));
    const { events, stats } = await collectBotFleetSessionTelemetry({ eventsDir: root, producerInstanceId: "test-host", ...nativeWindow });
    assert.equal(events.length, 1);
    assert.equal(stats.sourceFiles, 2);
    assert.equal(stats.malformedLines, 1);
    assert.equal(stats.historyGaps, 1);
    assert.ok(!JSON.stringify({ events, stats }).includes("PRIVATE_CONTENT"));
    const absent = await collectBotFleetSessionTelemetry({ eventsDir: join(root, "absent"), producerInstanceId: "test-host", ...nativeWindow });
    assert.equal(absent.stats.sourceAvailable, false);
    assert.deepEqual(absent.events, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native publication requires an explicit window and reports retained completions outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-window-"));
  try {
    const rows = [started, completed,
      { ...completed, eventId: "old", createdAt: "2026-10-30T11:59:59.999Z" },
      { ...completed, eventId: "lower-bound", createdAt: "2026-10-30T12:00:00Z" },
      { ...completed, eventId: "upper-bound", createdAt: "2026-10-30T13:00:00Z" },
      { ...completed, eventId: "future", createdAt: "2026-10-30T13:00:00.001Z" }];
    const path = join(root, "thread.ndjson");
    const body = rows.map(JSON.stringify).join("\n") + "\n";
    await writeFile(path, body);
    await assert.rejects(collectBotFleetSessionTelemetry({ eventsDir: root, producerInstanceId: "test-host" }), /explicit operational window/);
    const { events, stats } = await collectBotFleetSessionTelemetry({ eventsDir: root, producerInstanceId: "test-host", since: new Date("2026-10-30T12:00:00Z"), until: new Date("2026-10-30T13:00:00Z") });
    assert.equal(events.length, 3);
    assert.equal(stats.retainedCompletions, 5);
    assert.equal(stats.outsideLookbackCompletions, 1);
    assert.equal(stats.afterWindowCompletions, 1);
    assert.equal(await readFile(path, "utf8"), body);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native BotFleet uses only durable telemetry delivery and keeps aggregate names through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-outbox-"));
  try {
    const config = { stateRoot: root, destination: "hub", endpoint: "https://hub.example.test", token: "test-only-native-source-bearer-00000000000000" };
    const identity = { producerId: "botfleet", producerInstanceId: "test-host" };
    const native = botFleetRuntimeTelemetry(selected([started, completed]), identity);
    native[0].promptText = "PRIVATE_CONTENT";
    const outbox = await enqueueCollectorSentryTelemetry(native, identity, config);
    assert.equal((await drainCollectorSentry(outbox, config, { fetchImpl: async () => new Response("", { status: 503 }) })).pending, true);
    const db = new DatabaseSync(join(outbox, "outbox.sqlite"));
    assert.ok(!db.prepare("SELECT payload FROM events").get().payload.includes("PRIVATE_CONTENT"));
    db.close();
    let sent;
    const result = await drainCollectorSentry(outbox, config, { fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, "/v1/traces");
      sent = JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans[0];
      return Response.json({ ok: true, received: 1, written: 1, ignored: 0 });
    } });
    assert.equal(result.delivered, 1);
    assert.equal(sent.name, "botfleet.turn");
    assert.equal(sent.status.code, 2);
    assert.ok(sent.attributes.some((a) => a.key === "gen_ai.operation.name" && a.value.stringValue === "botfleet.turn"));
    assert.ok(!sent.attributes.some((a) => a.key === "gen_ai.system" || a.key === "gen_ai.usage.output_tokens"));
    await enqueueCollectorSentryTelemetry(native, identity, config);
    assert.equal((await drainCollectorSentry(outbox, config, { fetchImpl: async () => { throw new Error("No replay expected"); } })).delivered, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native batches do not sit behind previously rejected groups and retain those groups", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-priority-"));
  try {
    const config = { stateRoot: root, endpoint: "https://example.sentry.io", publicKey: "abc123" };
    const identity = { producerId: "botfleet", producerInstanceId: "test-host" };
    const old = botFleetRuntimeTelemetry(selected([started, { ...completed, servedModel: "old-model" }]), identity);
    const outbox = await enqueueCollectorSentryTelemetry(old, identity, config);
    const db = new DatabaseSync(join(outbox, "outbox.sqlite"));
    db.exec("UPDATE events SET retry_batch_size=1");
    db.close();
    const current = botFleetRuntimeTelemetry(selected([started, { ...completed, eventId: "current", servedModel: "current-model" }]), identity);
    await enqueueCollectorSentryTelemetry(current, identity, config);
    const models = [];
    const result = await drainCollectorSentry(outbox, config, { requestLimit: 2, prioritizeUnnarrowed: true, fetchImpl: async (_url, options) => {
      const span = JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans[0];
      models.push(span.attributes.find((a) => a.key === "gen_ai.request.model").value.stringValue);
      return Response.json({});
    } });
    assert.deepEqual(models, ["current-model", "old-model"]);
    assert.equal(result.delivered, 2);
    assert.equal(result.quarantined, 0);
    assert.equal(result.pending, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MiniMax native workspace correlation preserves rows and never guesses ambiguous sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-telemetry-"));
  const dbPath = join(root, "runtime.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)");
    const insert = db.prepare("INSERT INTO local_runtime_token_usage VALUES (?, ?, 'worker', 'native', 'MiniMax-M3', 1792900000000, 5, 6, 0, 7, 0)");
    insert.run(1, "session-managed");
    insert.run(2, "session-ordinary");
    const collect = () => collectMinimaxRuntimeEvents({ dbPath, since: new Date(0) });
    const baseline = await collect();
    assert.equal(baseline.length, 6);
    assert.ok(baseline.every((event) => event.metadata["session.id"] && !event.metadata["agent.launcher"]));
    db.exec("CREATE TABLE local_runtime_sessions (session_id TEXT, workspace_dir TEXT, project_workspace_dir TEXT)");
    const session = db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)");
    session.run("session-managed", "/home/test/.botfleet/workspaces/native-child", "/ordinary-project");
    session.run("session-ordinary", "/ordinary-project", "/home/test/.botfleet/workspaces/decoy");
    const linked = await collect();
    const ledger = (events) => events.map((event) => [event.eventId, event.quantity]);
    assert.deepEqual(ledger(linked), ledger(baseline));
    assert.ok(linked.filter((event) => event.metadata["session.id"] === "session-managed").every((event) => event.metadata["agent.launcher"] === "botfleet"));
    assert.ok(linked.filter((event) => event.metadata["session.id"] === "session-ordinary").every((event) => !event.metadata["agent.launcher"]));
    assert.ok(!JSON.stringify(linked).includes("/home/test/"));
    session.run("session-managed", "/home/test/.botfleet/workspaces/ambiguous", null);
    const ambiguous = await collect();
    assert.deepEqual(ledger(ambiguous), ledger(baseline));
    assert.ok(ambiguous.every((event) => !event.metadata["agent.launcher"]));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
