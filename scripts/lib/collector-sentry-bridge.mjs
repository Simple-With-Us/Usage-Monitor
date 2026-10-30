import { createHash, randomUUID } from "node:crypto";
import { mkdir, chmod, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { scrubInternalEvent, scrubOtlpAttributes, rebuildLogBody, scalarFromAnyValue } from "../telemetry-hub/allowlist.mjs";
import { buildLogsEnvelope, buildTracesEnvelope } from "../telemetry-hub/sentry-sender.mjs";
import { projectHubTelemetry, telemetryIdentifier } from "../telemetry-hub/metadata-projection.mjs";

// Non-enumerable source identity never changes a collector's wire payload.
export const COLLECTOR_CALL_ID = Symbol.for("usage-monitor.collector-call-id");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const tokenTypes = new Set(["input", "output", "cacheRead", "cacheCreation"]);
const runFile = promisify(execFile);
const AckCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OtlpCount = z.union([AckCount, z.string().max(16).regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(AckCount)]);
const HubAckSchema = z.strictObject({ ok: z.literal(true), received: AckCount, written: AckCount, ignored: AckCount });
function otlpAckSchema(logs) {
  const camel = logs ? "rejectedLogRecords" : "rejectedSpans";
  const snake = logs ? "rejected_log_records" : "rejected_spans";
  return z.strictObject({
    partialSuccess: z.strictObject({ [camel]: OtlpCount.optional(), errorMessage: z.string().max(2048).optional() }).optional(),
    partial_success: z.strictObject({ [snake]: OtlpCount.optional(), error_message: z.string().max(2048).optional() }).optional(),
  }).refine((ack) => !(ack.partialSuccess && ack.partial_success));
}

export function collectorSentryConfig(env = process.env, producerId) {
  if (env.COLLECTOR_SENTRY_ENABLED !== "1") return null;
  if (env.COLLECTOR_TELEMETRY_HUB_ENDPOINT) {
    let hub;
    try { hub = new URL(env.COLLECTOR_TELEMETRY_HUB_ENDPOINT); } catch { throw new Error("Collector hub endpoint is invalid"); }
    const octets = hub.hostname.split(".").map(Number);
    const tailnet = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    const local = hub.hostname === "127.0.0.1" || hub.hostname === "[::1]";
    if ((hub.protocol !== "https:" && !(hub.protocol === "http:" && (local || tailnet))) || hub.username || hub.password || hub.search || hub.hash) throw new Error("Collector hub endpoint must use HTTPS or private loopback/Tailscale HTTP");
    let token = env.COLLECTOR_TELEMETRY_HUB_TOKEN;
    if (env.COLLECTOR_TELEMETRY_HUB_TOKENS_JSON) {
      let tokens;
      try { tokens = JSON.parse(env.COLLECTOR_TELEMETRY_HUB_TOKENS_JSON); } catch { throw new Error("Collector hub token mapping is invalid"); }
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("Collector hub token mapping is invalid");
      if (!Object.hasOwn(tokens, producerId)) return null;
      token = tokens[producerId];
    }
    if (typeof token !== "string" || !/^\S{32,512}$/.test(token)) throw new Error("Collector hub bearer is missing or invalid");
    return { destination: "hub", endpoint: hub.href.replace(/\/+$/, ""), token, stateRoot: env.COLLECTOR_SENTRY_STATE_DIR || join(homedir(), ".cache", "usage-monitor", "sentry-outbox") };
  }
  const endpoint = env.SENTRY_OTLP_ENDPOINT?.replace(/\/+$/, "");
  const publicKey = env.SENTRY_PUBLIC_KEY;
  let url;
  try { url = new URL(endpoint); } catch { throw new Error("Collector Sentry endpoint is missing or invalid"); }
  if (url.protocol !== "https:" || !(url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Collector Sentry endpoint must be an HTTPS Sentry URL");
  }
  if (typeof publicKey !== "string" || !/^[a-f0-9]+$/i.test(publicKey)) throw new Error("Collector Sentry public key is missing or invalid");
  return { destination: "sentry", endpoint, publicKey, stateRoot: env.COLLECTOR_SENTRY_STATE_DIR || join(homedir(), ".cache", "usage-monitor", "sentry-outbox") };
}

/** Known calls become spans; other token rows remain explicit observations. */
export function collectorSentryEvents(events, { producerId, producerInstanceId = hostname() }) {
  const grouped = new Map();
  const seen = new Set();
  for (const event of events) {
    const type = event?.metadata?.tokenType;
    if (event?.metricType !== "usage" || event.unit !== "token" || !tokenTypes.has(type) || !Number.isFinite(event.quantity) || event.quantity < 0 || typeof event.eventId !== "string") continue;
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const callId = event[COLLECTOR_CALL_ID];
    const id = hash(JSON.stringify([producerId, producerInstanceId, callId || event.eventId]));
    const existing = grouped.get(id);
    const row = existing ?? {
      eventId: id, ts: event.occurredAt, kind: callId ? "span" : "log",
      platform: producerId, vendor: event.provider, model: event.producerKeyRef, operation: callId ? "chat" : "usage_observation", tokens: {},
    };
    row.tokens[type] = (row.tokens[type] ?? 0) + event.quantity;
    const duration = event.metadata?.durationMs;
    if (Number.isFinite(duration) && duration >= 0) {
      row.durationMs = duration;
      const completed = Date.parse(event.occurredAt);
      if (callId && Number.isFinite(completed) && Number.isFinite(completed - duration)) row.ts = new Date(completed - duration).toISOString();
    }
    grouped.set(id, row);
  }
  // Content is projected before it is ever written to disk.
  return [...grouped.values()].map((event) => scrubInternalEvent(projectHubTelemetry(event))).filter(Boolean);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function processBirth(pid) {
  try {
    const [stat, bootId] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return hash(`${bootId.trim()}:${start}`);
  } catch {
    try {
      const { stdout } = await runFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
      const start = stdout.trim();
      return start ? hash(start) : undefined;
    } catch { return undefined; }
  }
}

async function openOutbox(root, { create = true } = {}) {
  const path = join(root, "outbox.sqlite");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  else if (!(await stat(path)).isFile()) throw new Error("Existing collector outbox is required for maintenance");
  const db = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', owner TEXT, pid INTEGER, birth TEXT, sent_at INTEGER)");
    if (!db.prepare("PRAGMA table_info(events)").all().some((column) => column.name === "birth")) db.exec("ALTER TABLE events ADD COLUMN birth TEXT");
    if (!db.prepare("PRAGMA table_info(events)").all().some((column) => column.name === "sent_at")) db.exec("ALTER TABLE events ADD COLUMN sent_at INTEGER");
    if (!db.prepare("PRAGMA table_info(events)").all().some((column) => column.name === "retry_batch_size")) db.exec("ALTER TABLE events ADD COLUMN retry_batch_size INTEGER NOT NULL DEFAULT 100");
    db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  } catch (error) { db.close(); throw error; }
  return db;
}

export async function flushCollectorSentry({ producerId, producerInstanceId, dryRun, log = console.log }) {
  if (dryRun) return;
  try {
    const config = collectorSentryConfig(process.env, producerId);
    if (!config) return;
    const root = await enqueueCollectorSentry([], { producerId, producerInstanceId: producerInstanceId || process.env.USAGE_MACHINE_ID?.trim() || hostname() }, config);
    const result = await drainCollectorSentry(root, config);
    if (result.pending) log("WARNING: collector Sentry delivery pending in durable outbox");
    if (result.quarantined) log(`WARNING: ${result.quarantined} collector Sentry event(s) quarantined in durable outbox`);
  } catch { log("WARNING: collector Sentry delivery deferred; durable outbox retained"); }
}

/** SQLite owns concurrent enqueue/claim transitions and durable receipts. */
export async function enqueueCollectorSentry(events, identity, config) {
  return persistCollectorSentry(collectorSentryEvents(events, identity), identity, config);
}

/** Native aggregate telemetry uses the same privacy projection and independent outbox. */
export async function enqueueCollectorSentryTelemetry(events, identity, config) {
  const projected = events.map((event) => {
    if (!/^[a-f0-9]{64}$/.test(event?.eventId || "")) throw new Error("Native telemetry requires a stable hashed event identity");
    return scrubInternalEvent(projectHubTelemetry(event));
  }).filter(Boolean);
  return persistCollectorSentry(projected, identity, config);
}

async function persistCollectorSentry(events, identity, config) {
  const root = join(config.stateRoot, hash(JSON.stringify([identity.producerId, identity.producerInstanceId || hostname(), config.destination || "sentry", config.endpoint])));
  const db = await openOutbox(root);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT OR IGNORE INTO events (id, payload) VALUES (?, ?)");
    for (const event of events) insert.run(event.eventId, JSON.stringify(event));
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
  return root;
}

/** At-least-once delivery; receipts survive collector checkpoints and restarts. */
export async function drainCollectorSentry(root, config, { fetchImpl = globalThis.fetch, limit = 1000, isAlive = processAlive, birthOf = processBirth, budgetMs = 5000, requestLimit = 32, prioritizeUnnarrowed = false } = {}) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 1000) throw new Error("Outbox request limit must be between 1 and 1000");
  const db = await openOutbox(root);
  const owner = randomUUID();
  const deadline = Date.now() + budgetMs;
  let delivered = 0;
  let quarantined = 0;
  let requests = 0;
  let claimPass = 0;

  const quarantine = (id) => {
    db.prepare("UPDATE events SET state='quarantined', owner=NULL, pid=NULL, birth=NULL WHERE id=? AND owner=?").run(id, owner);
    quarantined += 1;
  };
  const safeEvent = (row) => {
    const event = JSON.parse(row.payload);
    if (event.eventId !== row.id) throw new Error("Outbox identity mismatch");
    const attributes = scrubOtlpAttributes(event.attributes).filter((attribute) => {
      const value = scalarFromAnyValue(attribute.value);
      if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
      return typeof value === "string" && value.split(",").every((part) => telemetryIdentifier(part));
    });
    const nativeTurn = attributes.some((attribute) => attribute.key === "gen_ai.operation.name" && scalarFromAnyValue(attribute.value) === "botfleet.turn");
    const safe = { eventId: row.id, ts: event.ts, kind: event.kind === "span" ? "span" : "log", name: nativeTurn ? "botfleet.turn" : event.kind === "span" ? "chat" : "usage_observation", attributes, body: { stringValue: rebuildLogBody(attributes) } };
    if (nativeTurn) {
      if (safe.kind === "span") safe.status = { code: event.status?.code === 2 ? 2 : 1 };
      else safe.severityNumber = event.severityNumber === 17 ? 17 : 9;
    }
    if (Number.isFinite(event.durationMs) && event.durationMs >= 0) safe.durationMs = event.durationMs;
    return safe;
  };

  const deliverGroup = async (group) => {
    if (!group.length) return;
    if (Date.now() >= deadline || requests >= requestLimit) throw new Error("Outbox delivery budget exhausted");
    requests += 1;
    const logs = group[0].kind === "log";
    const response = await fetchImpl(`${config.endpoint}/v1/${logs ? "logs" : "traces"}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.destination === "hub" ? { authorization: `Bearer ${config.token}` } : { "x-sentry-auth": `sentry sentry_key=${config.publicKey}` }) },
      body: JSON.stringify(logs ? buildLogsEnvelope(group) : buildTracesEnvelope(group)),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: "error",
    });
    let poisoned = [400, 409, 413, 422].includes(response.status);
    if (!response.ok && !poisoned) throw new Error("Outbox destination did not accept delivery");
    if (response.ok) {
      const text = await response.text();
      const raw = text ? JSON.parse(text) : {};
      if (config.destination === "hub") {
        const result = HubAckSchema.safeParse(raw);
        if (!result.success || result.data.received !== result.data.written || result.data.received > group.length || result.data.ignored !== group.length - result.data.received) throw new Error("Hub acknowledgement is incomplete or invalid");
        poisoned = result.data.ignored > 0;
      } else {
        const result = otlpAckSchema(logs).safeParse(raw);
        if (!result.success) throw new Error("OTLP acknowledgement is invalid");
        const partial = result.data.partialSuccess ?? result.data.partial_success;
        const rejected = partial?.rejectedSpans ?? partial?.rejected_spans ?? partial?.rejectedLogRecords ?? partial?.rejected_log_records ?? 0;
        if (rejected > group.length) throw new Error("OTLP acknowledgement rejection count exceeds submitted records");
        poisoned = rejected > 0;
      }
    }
    if (poisoned) {
      if (group.length === 1) { quarantine(group[0].eventId); return; }
      const middle = Math.ceil(group.length / 2);
      // Persist narrowing before recursion so an interrupted split still makes progress.
      db.exec("BEGIN IMMEDIATE");
      try {
        const narrow = db.prepare("UPDATE events SET retry_batch_size=MIN(retry_batch_size,?) WHERE id=? AND owner=?");
        for (const event of group) narrow.run(middle, event.eventId, owner);
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      await deliverGroup(group.slice(0, middle));
      await deliverGroup(group.slice(middle));
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const acknowledge = db.prepare("UPDATE events SET state='sent', owner=NULL, pid=NULL, birth=NULL, sent_at=? WHERE id=? AND owner=?");
      for (const event of group) acknowledge.run(Date.now(), event.eventId, owner);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    delivered += group.length;
  };

  try {
    const invocationBirth = await birthOf(process.pid) ?? null;
    for (let count = 0; count < limit && Date.now() < deadline;) {
      let rows;
      const heldRows = db.prepare("SELECT id, owner, pid, birth FROM events WHERE state='sending' LIMIT 1000").all();
      const processChecks = new Map();
      for (const held of heldRows) {
        if (!Number.isSafeInteger(held.pid) || held.pid <= 0 || processChecks.has(held.pid)) continue;
        processChecks.set(held.pid, (async () => {
          const alive = held.pid === process.pid || isAlive(held.pid);
          return { alive, birth: held.pid === process.pid ? invocationBirth : alive ? await birthOf(held.pid) : undefined };
        })());
      }
      const statuses = new Map(await Promise.all([...processChecks].map(async ([pid, pending]) => [pid, await pending])));
      const stale = heldRows.filter((held) => {
        const status = statuses.get(held.pid);
        return status && (!status.alive || (held.birth && status.birth && held.birth !== status.birth));
      });
      db.exec("BEGIN IMMEDIATE");
      try {
        const recover = db.prepare("UPDATE events SET state='pending', owner=NULL, pid=NULL, birth=NULL WHERE id=? AND state='sending' AND owner IS ? AND pid IS ? AND birth IS ?");
        for (const held of stale) recover.run(held.id, held.owner, held.pid, held.birth);
        const order = prioritizeUnnarrowed && claimPass++ % 2 === 0 ? "retry_batch_size DESC, rowid DESC" : "rowid";
        const candidates = db.prepare(`SELECT id, retry_batch_size FROM events WHERE state='pending' ORDER BY ${order} LIMIT ?`).all(Math.min(100, limit - count));
        const batchSize = candidates.reduce((size, row) => Math.min(size, Number.isSafeInteger(row.retry_batch_size) && row.retry_batch_size > 0 ? row.retry_batch_size : 1), 100);
        const picked = candidates.slice(0, batchSize).map((row) => row.id);
        rows = picked.length ? db.prepare(`SELECT id, payload FROM events WHERE id IN (${picked.map(() => "?").join(",")}) ORDER BY rowid`).all(...picked) : [];
        const claim = db.prepare("UPDATE events SET state='sending', owner=?, pid=?, birth=? WHERE id=?");
        for (const row of rows) claim.run(owner, process.pid, invocationBirth, row.id);
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      if (!rows.length) break;
      count += rows.length;
      const safeEvents = [];
      for (const row of rows) {
        try { safeEvents.push(safeEvent(row)); } catch { quarantine(row.id); }
      }
      try {
        for (const kind of ["span", "log"]) await deliverGroup(safeEvents.filter((event) => event.kind === kind));
      } catch {
        db.prepare("UPDATE events SET state='pending', owner=NULL, pid=NULL, birth=NULL WHERE owner=?").run(owner);
        break;
      }
    }
    return { delivered, quarantined, pending: !!db.prepare("SELECT 1 FROM events WHERE state!='sent' LIMIT 1").get() };
  } finally {
    db.prepare("UPDATE events SET state='pending', owner=NULL, pid=NULL, birth=NULL WHERE owner=?").run(owner);
    db.close();
  }
}

/** Explicit bounded maintenance; pending telemetry is never eligible. */
export async function pruneCollectorSentryReceipts(root, { successfulThrough, retentionDays = 180, limit = 10000, now = Date.now() } = {}) {
  const checkpoint = new Date(successfulThrough).getTime();
  if (!Number.isFinite(checkpoint) || checkpoint > now || !Number.isInteger(retentionDays) || retentionDays < 180 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("Receipt pruning requires a verified checkpoint and at least 180 days of retention");
  const cutoff = new Date(checkpoint - (retentionDays + 1) * 86400000).toISOString();
  const db = await openOutbox(root, { create: false });
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE state='sent' AND sent_at < ? AND json_extract(payload, '$.ts') < ? ORDER BY rowid LIMIT ?)").run(now - retentionDays * 86400000, cutoff, limit);
    db.prepare("INSERT INTO metadata (key,value) VALUES ('receipt_prune_boundary',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(cutoff);
    db.exec("COMMIT");
    return { removed: result.changes, replayBefore: cutoff };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}

export async function retryCollectorSentryQuarantine(root, eventId) {
  if (!/^[a-f0-9]{64}$/.test(eventId || "")) throw new Error("Provide one exact quarantined event ID");
  const db = await openOutbox(root, { create: false });
  try { return { requeued: db.prepare("UPDATE events SET state='pending' WHERE id=? AND state='quarantined'").run(eventId).changes }; }
  finally { db.close(); }
}
