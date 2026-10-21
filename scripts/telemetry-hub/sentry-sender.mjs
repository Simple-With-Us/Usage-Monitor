// The Sentry sender.
//
// Sentry gets ONLY counts, durations, the model, the tool names and a
// status.  It never gets the prompt, the response, the tool arguments, the
// tool results, a file path, a project name, a session id or a raw error
// message.
//
// The scrubber in ./allowlist.mjs is the control.  Sentry's own default
// scrubbing does not protect `gen_ai.input.messages`,
// `gen_ai.output.messages`, `gen_ai.tool.call.arguments` or
// `gen_ai.tool.call.result`, and plain OTLP bypasses the SDK PII flags
// entirely, so the content is removed on this Mac before the packet
// leaves.
//
// Two envelopes go out: `/v1/traces` for the turn events and `/v1/logs` for
// the log events.  Sentry has no OTLP metrics path, so none is attempted.
//
// The endpoint is project-specific and region-specific, so it is read from
// the environment and never hardcoded.  The public key is not a secret, but
// it is still read from the environment.

import { gzipSync } from "node:zlib";

import { scrubInternalEvent } from "./allowlist.mjs";
import { NULL_LOGGER } from "./internal-event.mjs";

/** The Sentry OTLP envelopes.  Sentry does not support OTLP metrics. */
export const SENTRY_TRACES_PATH = "/v1/traces";
export const SENTRY_LOGS_PATH = "/v1/logs";

/** Sentry accepts at most 100 log records per envelope. */
export const MAX_LOGS_PER_REQUEST = 100;

/** Sentry accepts at most 1000 spans per request. */
export const MAX_SPANS_PER_REQUEST = 1000;

/** Keep every request body well under 1 MB, far inside the 12 MiB cap. */
export const MAX_BODY_CHARS = 512 * 1024;

/** How many journal events one pass reads before it splits them by kind. */
export const DEFAULT_READ_LIMIT = 200;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;

/** The service name Sentry sees. */
const SERVICE_NAME = "telemetry-hub";
const SERVICE_VERSION = "1";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an HTTP status.  Same policy as the UM sender: a validation
 * failure is a poison event, an auth or routing failure is the channel's
 * own problem, and 429/5xx is transient.
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  if (status === 400 || status === 409 || status === 422) return "poison";
  return "channel";
}

function isoToNanos(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return String(BigInt(Math.round(time)) * 1_000_000n);
}

/** A 32 hex trace id and a 16 hex span id, derived from the event id. */
export function traceAndSpanIds(eventId) {
  const hex = typeof eventId === "string" ? eventId.replace(/[^0-9a-f]/gi, "").toLowerCase() : "";
  const traceId = (hex + "0".repeat(32)).slice(0, 32);
  const spanId = (hex + "0".repeat(16)).slice(0, 16);
  return { traceId, spanId };
}

/**
 * Build the OTLP traces envelope for a list of SCRUBBED events.
 *
 * The input is already scrubbed, so this function never sees a prompt or a
 * response and never has to decide whether one is safe.
 */
export function buildTracesEnvelope(events) {
  const spans = [];
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    const { traceId, spanId } = traceAndSpanIds(event.eventId);
    const start = isoToNanos(event.ts);
    const durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
    const end = start ? String(BigInt(start) + BigInt(Math.max(0, Math.round(durationMs)) * 1_000_000)) : undefined;
    const span = {
      traceId,
      spanId,
      name: typeof event.name === "string" && event.name ? event.name : "chat",
      kind: 3,
      attributes: Array.isArray(event.attributes) ? event.attributes : [],
    };
    if (start) span.startTimeUnixNano = start;
    if (end) span.endTimeUnixNano = end;
    if (isPlainObject(event.status)) span.status = { code: event.status.code };
    spans.push(span);
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: SERVICE_NAME } },
            { key: "service.version", value: { stringValue: SERVICE_VERSION } },
          ],
        },
        scopeSpans: [{ scope: { name: SERVICE_NAME }, spans }],
      },
    ],
  };
}

/**
 * Build the OTLP logs envelope for a list of SCRUBBED events.
 *
 * The body was rebuilt by the scrubber from allowlisted fields, so it never
 * contains producer free text.
 */
export function buildLogsEnvelope(events) {
  const logRecords = [];
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    const { traceId, spanId } = traceAndSpanIds(event.eventId);
    const record = {
      timeUnixNano: isoToNanos(event.ts) ?? String(Date.now() * 1_000_000),
      severityNumber: typeof event.severityNumber === "number" ? event.severityNumber : 9,
      body: isPlainObject(event.body) ? event.body : { stringValue: "" },
      traceId,
      spanId,
      attributes: Array.isArray(event.attributes) ? event.attributes : [],
    };
    logRecords.push(record);
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: SERVICE_NAME } },
            { key: "service.version", value: { stringValue: SERVICE_VERSION } },
          ],
        },
        scopeLogs: [{ scope: { name: SERVICE_NAME }, logRecords }],
      },
    ],
  };
}

/**
 * Split a list into chunks that respect both a count cap and a body size
 * cap.  The body cap is checked on the serialized envelope, so a batch of
 * very large attribute values is split before it reaches the 12 MiB cap.
 *
 * Each event is serialized ONCE, and its size is accumulated as an UPPER
 * BOUND on the chunk: it counts the shared envelope wrapper once per event,
 * while the real envelope contains it once, so the running total never
 * understates the chunk.  Rebuilding and re-serializing the whole candidate
 * for every event made each pass quadratic in JSON bytes, which discarded
 * large amounts of text purely to find the boundaries.
 *
 * The upper bound is loose, so when it says a chunk is full the CANDIDATE is
 * measured EXACTLY before the boundary is drawn, which recovers the precise
 * cut.  That exact measurement is the only place a whole chunk is serialized,
 * so a pass stays linear in the events it accepts, and the cap is enforced
 * rather than approximated.  A single event too large for the cap is emitted
 * on its own, exactly as before, rather than dropped or looping forever.
 */
export function chunkBySize(events, build, { maxCount, maxChars }) {
  const chunks = [];
  const measure = (subset) => JSON.stringify(build(subset)).length;
  const costs = events.map((event) => measure([event]));

  let current = [];
  let currentCost = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const cost = costs[index];
    const countFull = current.length + 1 > maxCount;
    const boundFull = currentCost + cost > maxChars;
    if (current.length > 0 && (countFull || boundFull)) {
      const candidate = current.concat([event]);
      if (countFull || measure(candidate) > maxChars) {
        chunks.push(current);
        current = [];
        currentCost = 0;
      } else {
        current = candidate;
        currentCost += cost;
        continue;
      }
    }
    current = current.concat([event]);
    currentCost += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Create the Sentry sender.
 *
 * @param {object} options
 * @param {import("./journal.mjs").Journal} options.journal
 */
export function createSentrySender({
  journal,
  endpoint = process.env.SENTRY_OTLP_ENDPOINT?.trim(),
  publicKey = process.env.SENTRY_PUBLIC_KEY?.trim(),
  readLimit = DEFAULT_READ_LIMIT,
  dryRun = false,
  logger = NULL_LOGGER,
  fetchImpl = globalThis.fetch,
  retryDelayMs = BASE_BACKOFF_MS,
} = {}) {
  if (!journal) throw new Error("The Sentry sender needs a journal");
  const destination = "sentry";
  const root = endpoint ? endpoint.replace(/\/+$/, "") : "";

  async function post(path, envelope) {
    const json = JSON.stringify(envelope);
    const body = gzipSync(Buffer.from(json, "utf8"));
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-sentry-auth": `sentry sentry_key=${publicKey}`,
          "content-length": String(body.length),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { outcome: "retry", status: 0, errorName: error?.name ?? "Error" };
    }
    const outcome = classifyStatus(response.status);
    if (outcome === "ok") return { outcome, status: response.status };
    let code = "";
    try {
      const text = await response.text();
      const parsed = JSON.parse(text);
      const candidate = parsed?.error?.code ?? parsed?.detail;
      if (typeof candidate === "string") code = candidate.slice(0, 64);
    } catch {
      code = "";
    }
    return { outcome, status: response.status, code };
  }

  async function postWithRetry(path, envelope) {
    let last = { outcome: "retry", status: 0 };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      last = await post(path, envelope);
      if (last.outcome !== "retry") return last;
      if (attempt < MAX_ATTEMPTS && retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    return last;
  }

  /**
   * Deliver one group of events, isolating a single poisoned event.
   *
   * A poison response is answered for the whole envelope, so the group is
   * halved until one event is left; that event is quarantined and the rest
   * is delivered.
   */
  async function deliverGroup(events, path, build) {
    const delivered = [];
    const quarantined = [];

    const attempt = async (subset) => {
      const envelope = build(subset);
      const result = await postWithRetry(path, envelope);
      if (result.outcome === "ok") {
        delivered.push(...subset);
        return { outcome: "ok" };
      }
      if (result.outcome === "retry" || result.outcome === "channel") {
        return { outcome: result.outcome, status: result.status };
      }
      if (subset.length === 1) {
        quarantined.push(subset[0]);
        await journal.quarantine(destination, subset[0], {
          reason: result.code ? `sentry rejected the event: ${result.code}` : "sentry rejected the event",
          status: result.status,
        });
        logger.warn("quarantined an event", {
          destination,
          eventId: subset[0]?.eventId,
          metricType: subset[0]?.operation,
          status: result.status,
        });
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

  /** One pass over the Sentry destination. */
  async function runOnce() {
    const batch = await journal.readBatch(destination, readLimit);
    if (batch.events.length === 0) {
      return { ok: true, delivered: 0, quarantined: 0, empty: true };
    }

    // S1: the content fields are stripped before the scrubber runs, and the
    // scrubber drops them as well.  Two independent barriers.
    const scrubbed = batch.events
      .map((event) => scrubInternalEvent(event))
      .filter((event) => !!event);

    const spans = scrubbed.filter((event) => event.kind !== "log");
    const logs = scrubbed.filter((event) => event.kind === "log");

    if (dryRun) {
      logger.info("sentry dry run", {
        destination,
        events: batch.events.length,
        spans: spans.length,
        logs: logs.length,
        attributeKeys: [...new Set(scrubbed.flatMap((event) => event.attributes.map((a) => a.key)))].sort(),
      });
      return { ok: true, delivered: 0, quarantined: 0, dryRun: true };
    }

    if (!root || !publicKey) {
      logger.error("the sentry otlp endpoint or public key is not configured", { destination });
      return { ok: false, retry: false, delivered: 0, quarantined: 0 };
    }

    const deliveredIds = [];
    let quarantined = 0;

    const spanChunks = chunkBySize(spans, buildTracesEnvelope, {
      maxCount: MAX_SPANS_PER_REQUEST,
      maxChars: MAX_BODY_CHARS,
    });
    for (const chunk of spanChunks) {
      const outcome = await deliverGroup(chunk, SENTRY_TRACES_PATH, buildTracesEnvelope);
      if (outcome.outcome !== "ok") {
        //  Whatever was delivered before the failure stays delivered, so
        //  the next pass does not send it again.  That includes the ids
        //  delivered INSIDE the failing chunk, which the offset would
        //  otherwise leave queued and the next pass would re-post.
        await journal.markSentBatch(destination, [
          ...deliveredIds,
          ...outcome.delivered,
          ...outcome.quarantined,
        ]);
        logger.warn("sentry is not accepting the batch", {
          destination,
          path: SENTRY_TRACES_PATH,
          status: outcome.status,
          outcome: outcome.outcome,
        });
        return { ok: false, retry: outcome.outcome === "retry", delivered: 0, quarantined: 0 };
      }
      const ids = [...outcome.delivered, ...outcome.quarantined]
        .map((event) => event.eventId)
        .filter((id) => typeof id === "string" && id);
      quarantined += outcome.quarantined.length;
      await journal.markSentBatch(destination, ids);
      deliveredIds.push(...ids);
    }

    const logChunks = chunkBySize(logs, buildLogsEnvelope, {
      maxCount: MAX_LOGS_PER_REQUEST,
      maxChars: MAX_BODY_CHARS,
    });
    for (const chunk of logChunks) {
      const outcome = await deliverGroup(chunk, SENTRY_LOGS_PATH, buildLogsEnvelope);
      if (outcome.outcome !== "ok") {
        await journal.markSentBatch(destination, [
          ...deliveredIds,
          ...outcome.delivered,
          ...outcome.quarantined,
        ]);
        logger.warn("sentry is not accepting the batch", {
          destination,
          path: SENTRY_LOGS_PATH,
          status: outcome.status,
          outcome: outcome.outcome,
        });
        return { ok: false, retry: outcome.outcome === "retry", delivered: 0, quarantined: 0 };
      }
      const ids = [...outcome.delivered, ...outcome.quarantined]
        .map((event) => event.eventId)
        .filter((id) => typeof id === "string" && id);
      quarantined += outcome.quarantined.length;
      await journal.markSentBatch(destination, ids);
      deliveredIds.push(...ids);
    }

    await journal.setOffset(destination, batch.endOffset);
    return {
      ok: true,
      delivered: deliveredIds.length,
      quarantined: quarantined.length,
    };
  }

  return {
    destinations: [destination],
    runOnce,
  };
}
