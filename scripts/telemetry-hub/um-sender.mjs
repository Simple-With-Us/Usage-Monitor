// The Usage Monitor sender.
//
// The UM destination gets EVERYTHING, including the prompt, the response,
// the tool names and the tool arguments that the producer recorded.  The
// sender therefore posts TWO payloads per batch:
//
//   POST /api/otlp/v1/traces   { turns: [...] }        -> AgentTurn
//   POST /api/ingest/usage     { schemaVersion: 2, ... } -> ExternalUsageEvent
//
// The two payloads land in different tables, so they cannot double count
// against the ledger.  The traces route NEVER writes ExternalUsageEvent.
//
// The two channels are tracked separately, each with its own journal offset
// and its own sent set, because a partial failure on one channel must not
// replay the other channel.
//
// A 4xx from UM is answered for the WHOLE batch, so a single poisoned event
// would otherwise wedge the queue forever.  The sender isolates the poison
// by halving the batch until one event is left, quarantines that event into
// the dead-letter file, and delivers the rest.
//
// Secrets are resolved AT SEND TIME.  The token is never written to disk,
// never passed on a command line, never logged and never part of an error
// message.
//
// The token is expected to be the UNCSCOPED USAGE_INGEST_TOKEN.  A token
// minted for a producer scope is checked against the platform of a turn, so
// a scoped token would have to allow every platform the hub carries
// ("opencode", ...) on top of the hub's own producer id.

import { fleetSecretsGet } from "../lib/fleet-secrets.mjs";

import { NULL_LOGGER } from "./internal-event.mjs";

/** The default UM base URL.  The routes are fixed; the host comes from config. */
export const DEFAULT_UM_BASE_URL = "https://usage.jays.services";

/** The default producer id of the hub in the shared v2 usage contract. */
export const DEFAULT_PRODUCER_ID = "telemetry-hub";

/** The ledger provider used when the producer does not name one. */
export const DEFAULT_PROVIDER = "external-api";

/** Events per request.  UM caps turns at 200 and usage events at 100. */
export const DEFAULT_BATCH_SIZE = 50;

/** How long a single HTTP attempt may take. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Retry attempts for a retryable failure, and the backoff between them. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;

/** How long a resolved ingest token is reused before it is read again. */
const TOKEN_MEMO_MS = 60_000;

const UMBER_TURNS_DESTINATION = "um-turns";
const UMBER_INGEST_DESTINATION = "um-ingest";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function omitUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function truncate(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an HTTP status.
 *
 *   ok       delivered
 *   retry    transient: 429, 5xx, or a network error.  The offset stays.
 *   poison   a validation failure of the payload: 400, 409, 422.  One event
 *            in the batch is bad, so the event is isolated and quarantined.
 *   channel  the request itself is wrong: 401, 403, 404, 405, 413.  No
 *            event is at fault, so nothing is quarantined and the batch
 *            stays queued.
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  if (status === 400 || status === 409 || status === 422) return "poison";
  return "channel";
}

/**
 * Build the UM turn for one internal event.
 *
 * This is the CONTENT path: the prompt and the response travel to UM and
 * nowhere else.  UM truncates them again on ingest; the local truncation
 * here only keeps the request body small.
 */
export function buildUmTurn(event) {
  if (!isPlainObject(event)) return null;
  const tokens = isPlainObject(event.tokens) ? event.tokens : {};
  const cacheRead = typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
  const cacheCreation = typeof tokens.cacheCreation === "number" ? tokens.cacheCreation : 0;
  const toolNames = Array.isArray(event.toolNames) ? event.toolNames : [];
  return omitUndefined({
    platform: event.platform,
    seat: event.platform,
    repo: truncate(event.project, 120),
    conversationId: truncate(event.sessionId, 200),
    model: truncate(event.model, 160),
    inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
    outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
    cacheTokens: cacheRead + cacheCreation,
    costUsd: typeof event.costUsd === "number" ? event.costUsd : undefined,
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    toolCount: toolNames.length,
    toolNames: toolNames.length > 0 ? toolNames : undefined,
    error: event.status === "error" ? truncate(event.errorType, 200) ?? "error" : undefined,
    promptText: truncate(event.promptText, 4000),
    responseText: truncate(event.responseText, 4000),
    occurredAt: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
  });
}

/**
 * Build one shared-contract v2 usage event for the ledger.
 *
 * The token semantics follow the OTLP semconv: `input` is the UNCACHED
 * input, and the cache counters are separate.  The monitor's legacy
 * metadata mapping expects a prompt figure that INCLUDES the cache reads
 * and writes, so the total prompt size is sent and the monitor subtracts
 * the cache counters itself.  That keeps the derived `input` equal to the
 * uncached input.
 *
 * An event with no usage at all (a log record with no tokens and no cost)
 * returns null, so the ledger does not collect zero rows that would only
 * add noise to the budget and rollup math.
 */
export function buildUsageV2Event(event, { provider } = {}) {
  if (!isPlainObject(event)) return null;
  const tokens = isPlainObject(event.tokens) ? event.tokens : {};
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const output = typeof tokens.output === "number" ? tokens.output : 0;
  const cacheRead = typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
  const cacheCreation = typeof tokens.cacheCreation === "number" ? tokens.cacheCreation : 0;
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
  const hasCost = typeof event.costUsd === "number" && Number.isFinite(event.costUsd);
  if (!hasCost && input + output + cacheRead + cacheCreation + reasoning <= 0) return null;
  const metadata = omitUndefined({
    model: truncate(event.model, 160),
    harness: truncate(event.platform, 80),
    seat: truncate(event.platform, 80),
    operation: truncate(event.operation, 80),
    promptTokens: input + cacheRead + cacheCreation,
    completionTokens: output,
    cachedTokens: cacheRead,
    cacheWriteTokens: cacheCreation,
    reasoningTokens: reasoning,
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    ttftMs: typeof event.ttftMs === "number" ? event.ttftMs : undefined,
    toolCount: Array.isArray(event.toolNames) ? event.toolNames.length : 0,
    toolStatus: truncate(event.toolStatus, 32),
    status: truncate(event.status, 16),
    errorType: truncate(event.errorType, 120),
  });
  return omitUndefined({
    eventId: event.eventId,
    provider: truncate(event.provider, 120) ?? provider ?? DEFAULT_PROVIDER,
    service: truncate(event.platform, 80),
    project: truncate(event.project, 120),
    metricType: "usage",
    unit: "request",
    quantity: 1,
    requests: 1,
    costUsd: hasCost ? event.costUsd : undefined,
    billingMode: hasCost ? "actual" : "estimated",
    confidence: hasCost ? "actual" : "estimated",
    occurredAt: typeof event.ts === "string" ? event.ts : new Date().toISOString(),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

/** Build the shared-contract v2 batch envelope. */
export function buildUsageV2Batch(events, { producerId, producerInstanceId } = {}) {
  return omitUndefined({
    schemaVersion: 2,
    producerId: producerId ?? DEFAULT_PRODUCER_ID,
    producerInstanceId,
    events: events.filter((event) => !!event),
  });
}

/**
 * Deliver a batch, isolating a single poisoned event.
 *
 * A poison response is answered for the whole batch, so the batch is
 * halved until one event is left.  That event is quarantined and the rest
 * of the batch is delivered.
 */
export async function deliverWithIsolation(events, post, { onQuarantine } = {}) {
  const delivered = [];
  const quarantined = [];

  const attempt = async (subset) => {
    const result = await post(subset);
    if (result.outcome === "ok") {
      delivered.push(...subset);
      return { outcome: "ok" };
    }
    if (result.outcome === "retry" || result.outcome === "channel") {
      return { outcome: result.outcome, status: result.status };
    }
    // poison
    if (subset.length === 1) {
      quarantined.push(subset[0]);
      if (typeof onQuarantine === "function") await onQuarantine(subset[0], result);
      return { outcome: "ok" };
    }
    const middle = Math.ceil(subset.length / 2);
    const left = await attempt(subset.slice(0, middle));
    if (left.outcome !== "ok") return left;
    const right = await attempt(subset.slice(middle));
    if (right.outcome !== "ok") return right;
    return { outcome: "ok" };
  };

  const result = await attempt(events);
  return { ...result, delivered, quarantined };
}

/**
 * Resolve the UM ingest token at send time.
 *
 * The environment wins, so a LaunchAgent can be configured without the
 * secret CLI.  Otherwise the token is read from the Mac-side fleet secret
 * store.  The value is held in memory only and is never written to disk.
 */
export function createTokenResolver({ env = process.env, now = () => Date.now() } = {}) {
  let memo = { value: undefined, at: Number.NEGATIVE_INFINITY };
  return async function resolveToken() {
    const fromEnv = env.USAGE_INGEST_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const stamp = now();
    //  The memo is checked on the stamp alone, not on a truthy value, so a
    //  MISS is memoized too.  Otherwise a missing token respawned the
    //  `fleet-secrets` CLI (twice, at a 30s timeout each) on every pass.
    if (stamp - memo.at < TOKEN_MEMO_MS) return memo.value;
    let value;
    try {
      value = fleetSecretsGet("USAGE_INGEST_TOKEN", { useCache: false });
    } catch {
      value = undefined;
    }
    memo = { value: typeof value === "string" && value.trim() ? value.trim() : undefined, at: stamp };
    return memo.value;
  };
}

/**
 * Create the UM sender.
 *
 * @param {object} options
 * @param {import("./journal.mjs").Journal} options.journal
 */
export function createUmSender({
  journal,
  baseUrl = process.env.UM_BASE_URL?.trim() || DEFAULT_UM_BASE_URL,
  producerId = process.env.TELEMETRY_HUB_PRODUCER_ID?.trim() || DEFAULT_PRODUCER_ID,
  producerInstanceId = process.env.TELEMETRY_HUB_PRODUCER_INSTANCE_ID?.trim(),
  provider = process.env.TELEMETRY_HUB_PROVIDER?.trim() || DEFAULT_PROVIDER,
  batchSize = DEFAULT_BATCH_SIZE,
  dryRun = false,
  logger = NULL_LOGGER,
  fetchImpl = globalThis.fetch,
  resolveToken = createTokenResolver(),
  retryDelayMs = BASE_BACKOFF_MS,
} = {}) {
  if (!journal) throw new Error("The UM sender needs a journal");
  const root = baseUrl.replace(/\/+$/, "");

  async function postJson(path, body, token) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-usage-telemetry-version": "2",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The message of a fetch error can quote the request, so only the
      // error NAME is safe to report.
      return { outcome: "retry", status: 0, errorName: error?.name ?? "Error" };
    }
    const status = response.status;
    const outcome = classifyStatus(status);
    if (outcome === "ok") return { outcome, status };
    let code = "";
    try {
      const text = await response.text();
      const parsed = JSON.parse(text);
      const candidate = parsed?.error?.code ?? parsed?.error;
      if (typeof candidate === "string") code = candidate.slice(0, 64);
    } catch {
      code = "";
    }
    return { outcome, status, code };
  }

  async function postWithRetry(path, body, token) {
    let last = { outcome: "retry", status: 0 };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      last = await postJson(path, body, token);
      if (last.outcome !== "retry") return last;
      if (attempt < MAX_ATTEMPTS && retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    return last;
  }

  async function runChannel({ destination, events, build, path, token, dryRunChannel }) {
    //  Every early return carries `dryRun`, because the caller advances the
    //  destination offset whenever the result is `ok` and NOT dry-run.  An
    //  empty batch that dropped the flag would advance the offset in
    //  `--dry-run` mode and skip those events for every later real run.
    if (events.length === 0) {
      return { ok: true, delivered: 0, quarantined: 0, dryRun: dryRunChannel === true };
    }
    const body = build(events);
    //  An event with no usage produces no ledger row, so a batch can be
    //  empty.  There is nothing to post then, and the offset still moves.
    const list = Array.isArray(body?.events) ? body.events : Array.isArray(body?.turns) ? body.turns : null;
    if (list && list.length === 0) {
      return {
        ok: true,
        delivered: 0,
        quarantined: 0,
        skipped: events.length,
        dryRun: dryRunChannel === true,
      };
    }
    if (dryRunChannel) {
      logger.info("um channel dry run", {
        destination,
        events: events.length,
        payloadKeys: Object.keys(body ?? {}),
      });
      return { ok: true, delivered: 0, quarantined: 0, dryRun: true };
    }
    const outcome = await deliverWithIsolation(events, (subset) => postWithRetry(path, build(subset), token), {
      onQuarantine: async (event, detail) => {
        await journal.quarantine(destination, event, {
          reason: detail.code ? `um rejected the event: ${detail.code}` : "um rejected the event",
          status: detail.status,
        });
        logger.warn("quarantined an event", {
          destination,
          eventId: event?.eventId,
          metricType: event?.operation,
          status: detail.status,
        });
      },
    });
    if (outcome.outcome === "retry" || outcome.outcome === "channel") {
      //  Whatever was delivered before the failure stays delivered, so the
      //  next pass does not send it again.
      const partial = [...outcome.delivered, ...outcome.quarantined]
        .map((event) => event?.eventId)
        .filter((id) => typeof id === "string" && id);
      if (partial.length > 0) await journal.markSentBatch(destination, partial);
      logger.warn("um channel is not accepting the batch", {
        destination,
        status: outcome.status,
        outcome: outcome.outcome,
      });
      return { ok: false, retry: outcome.outcome === "retry", delivered: 0, quarantined: outcome.quarantined.length };
    }
    const ids = [...outcome.delivered, ...outcome.quarantined]
      .map((event) => event?.eventId)
      .filter((id) => typeof id === "string" && id);
    await journal.markSentBatch(destination, ids);
    return {
      ok: true,
      delivered: outcome.delivered.length,
      quarantined: outcome.quarantined.length,
    };
  }

  /**
   * One pass over both UM channels.
   *
   * The two channels advance independently: a failure on one never moves
   * the other one's offset.
   */
  async function runOnce() {
    const token = await resolveToken();
    if (!token) {
      logger.error("the um ingest token is not available", { destination: "um" });
      return { ok: false, retry: false, turns: { ok: false }, ingest: { ok: false } };
    }

    const turnBatch = await journal.readBatch(UMBER_TURNS_DESTINATION, batchSize);
    const ingestBatch = await journal.readBatch(UMBER_INGEST_DESTINATION, batchSize);

    const turns = await runChannel({
      destination: UMBER_TURNS_DESTINATION,
      events: turnBatch.events.filter((event) => isPlainObject(event) && event.kind !== "log"),
      build: (events) => ({ turns: events.map((event) => buildUmTurn(event)).filter(Boolean) }),
      path: "/api/otlp/v1/traces",
      token,
      dryRunChannel: dryRun,
    });
    if (turns.ok && turnBatch.events.length > 0 && !turns.dryRun) {
      await journal.setOffset(UMBER_TURNS_DESTINATION, turnBatch.endOffset);
    }

    const ingest = await runChannel({
      destination: UMBER_INGEST_DESTINATION,
      events: ingestBatch.events,
      build: (events) =>
        buildUsageV2Batch(events.map((event) => buildUsageV2Event(event, { provider })), {
          producerId,
          producerInstanceId,
        }),
      path: "/api/ingest/usage",
      token,
      dryRunChannel: dryRun,
    });
    if (ingest.ok && ingestBatch.events.length > 0 && !ingest.dryRun) {
      await journal.setOffset(UMBER_INGEST_DESTINATION, ingestBatch.endOffset);
    }

    return {
      ok: turns.ok && ingest.ok,
      retry: turns.retry === true || ingest.retry === true,
      turns,
      ingest,
    };
  }

  return {
    destinations: [UMBER_TURNS_DESTINATION, UMBER_INGEST_DESTINATION],
    runOnce,
  };
}
