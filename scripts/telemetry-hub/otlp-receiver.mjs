// The local OTLP receiver.
//
// Producers on this Mac post OTLP-JSON to 127.0.0.1:4318.  The receiver
// normalizes each signal into the hub's internal form and appends it to the
// journal.  It never talks to the network itself and it never answers with
// anything derived from a producer value.
//
// The default listener accepts local telemetry on loopback only.
// A configured non-loopback listener requires scoped bearer sources and
// stamps their configured identity before journaling any producer claims.
//
// The body cap is 12 MiB, the same as Sentry's container cap, so a malformed
// or hostile producer cannot exhaust memory.  `/v1/metrics` is refused with
// 501: Sentry has no OTLP metrics path and the plan does not either, so
// accepting metrics would only create a sink that can never be delivered.
//
// The payload is validated with Zod before it reaches a normalizer.  The
// inbound boundary is the last place where an unknown field can be refused,
// so the normalizers and the journal only ever see a shape that was
// checked.  A payload that does not match is answered with 400 and a fixed
// message: the answer never quotes the payload, because the payload holds
// the producer content.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { normalizeOtlpLogs, normalizeOtlpTraces, NULL_LOGGER } from "./internal-event.mjs";

/** The largest body the receiver will read.  Matches Sentry's container cap. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

const RECEIVER_HOST = "127.0.0.1";
const RECEIVER_PORT = 4318;

export function parseReceiverSources(raw) {
  if (!raw) return [];
  const schema = z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9._-]{1,80}$/),
    platform: z.string().regex(/^[a-z0-9._-]{1,80}$/),
    token: z.string().regex(/^\S{32,512}$/),
  })).min(1).max(64);
  let parsed;
  try { parsed = schema.safeParse(JSON.parse(raw)); } catch { throw new Error("Hub source configuration is invalid"); }
  if (!parsed.success || new Set(parsed.data.map((source) => source.token)).size !== parsed.data.length) throw new Error("Hub source configuration is invalid");
  return parsed.data;
}

function authenticatedSource(request, sources) {
  const bearer = /^Bearer (\S{32,512})$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  const digest = createHash("sha256").update(bearer).digest();
  return sources.find((source) => timingSafeEqual(digest, source.digest));
}

//  An OTLP timestamp is a 64 bit number.  The JSON mapping of the OTLP
//  specification sends it as a string, but producers send both, so both are
//  accepted and the normalizer reads them the same way.
const OtlpTimestampSchema = z.union([z.string(), z.number()]);

//  An OTLP AnyValue.  The nested shapes are accepted and ignored: they are
//  the shapes a producer uses to smuggle content, and the scrubber refuses
//  them anyway.
const OtlpAnyValueSchema = z.looseObject({
  stringValue: z.string().optional(),
  boolValue: z.boolean().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.union([z.string(), z.number()]).optional(),
  arrayValue: z.unknown().optional(),
  kvlistValue: z.unknown().optional(),
  bytesValue: z.union([z.string(), z.number()]).optional(),
});

const OtlpAttributeSchema = z.looseObject({
  key: z.string(),
  value: OtlpAnyValueSchema,
});

const OtlpScopeSchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  attributes: z.array(OtlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
});

const OtlpResourceSchema = z.looseObject({
  attributes: z.array(OtlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
});

const OtlpStatusSchema = z.looseObject({
  code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
});

const OtlpSpanSchema = z.looseObject({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  name: z.string().optional(),
  kind: z.number().int().optional(),
  startTimeUnixNano: OtlpTimestampSchema.optional(),
  endTimeUnixNano: OtlpTimestampSchema.optional(),
  attributes: z.array(OtlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
  events: z.array(z.unknown()).optional(),
  links: z.array(z.unknown()).optional(),
  status: OtlpStatusSchema.optional(),
});

const OtlpLogRecordSchema = z.looseObject({
  timeUnixNano: OtlpTimestampSchema.optional(),
  observedTimeUnixNano: OtlpTimestampSchema.optional(),
  severityNumber: z.number().int().optional(),
  severityText: z.string().optional(),
  body: OtlpAnyValueSchema.optional(),
  attributes: z.array(OtlpAttributeSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  flags: z.number().optional(),
});

//  The spans and the log rows are held as unknown values here, because
//  they are checked one by one below.  A whole array of rows is never
//  rejected because of one bad row in it.
const OtlpScopeSpansSchema = z.looseObject({
  scope: OtlpScopeSchema.optional(),
  spans: z.array(z.unknown()).optional(),
});

const OtlpScopeLogsSchema = z.looseObject({
  scope: OtlpScopeSchema.optional(),
  logRecords: z.array(z.unknown()).optional(),
});

//  The scope entries are held as unknown values here too, because they are
//  checked one by one in the loops below.  A scope entry that does not
//  match costs that entry only, and never its siblings in the same
//  resource.
const OtlpResourceSpansSchema = z.looseObject({
  resource: OtlpResourceSchema.optional(),
  scopeSpans: z.array(z.unknown()).optional(),
});

const OtlpResourceLogsSchema = z.looseObject({
  resource: OtlpResourceSchema.optional(),
  scopeLogs: z.array(z.unknown()).optional(),
});

/**
 * The accepted shape of an OTLP traces envelope.
 *
 * The envelope is checked on its own: a payload that is not an OTLP
 * payload at all is refused.  The rows inside it are checked one by one,
 * so a single malformed span does not cost the whole batch.
 */
export const OTLP_TRACES_SCHEMA = z.looseObject({
  resourceSpans: z.array(z.unknown()).optional(),
});

/** The accepted shape of an OTLP logs envelope. */
export const OTLP_LOGS_SCHEMA = z.looseObject({
  resourceLogs: z.array(z.unknown()).optional(),
});

/** The answer of the receiver, for a caller that wants to check it. */
export const RECEIVER_RESPONSE_SCHEMA = z.looseObject({
  ok: z.boolean().optional(),
  received: z.number().int().nonnegative().optional(),
  ignored: z.number().int().nonnegative().optional(),
  written: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/**
 * Keep the resources, the scopes and the rows that are well formed.
 *
 * Every level is checked on its own, so one bad span or one bad log row
 * costs that row only.  The count of the dropped rows is returned, and
 * the caller reports it.
 */
function projectTraces(payload) {
  const resources = [];
  let dropped = 0;
  for (const rawResource of payload.resourceSpans ?? []) {
    const resource = OtlpResourceSpansSchema.safeParse(rawResource);
    if (!resource.success) {
      dropped += 1;
      continue;
    }
    const scopeSpans = [];
    for (const rawScope of resource.data.scopeSpans ?? []) {
      const scope = OtlpScopeSpansSchema.safeParse(rawScope);
      if (!scope.success) {
        dropped += 1;
        continue;
      }
      const spans = [];
      for (const rawSpan of scope.data.spans ?? []) {
        const span = OtlpSpanSchema.safeParse(rawSpan);
        if (!span.success) {
          dropped += 1;
          continue;
        }
        spans.push(span.data);
      }
      if (spans.length > 0) scopeSpans.push({ scope: scope.data.scope, spans });
    }
    if (scopeSpans.length > 0) resources.push({ resource: resource.data.resource, scopeSpans });
  }
  return { payload: { resourceSpans: resources }, dropped };
}

/** Keep the log rows that are well formed.  See `projectTraces`. */
function projectLogs(payload) {
  const resources = [];
  let dropped = 0;
  for (const rawResource of payload.resourceLogs ?? []) {
    const resource = OtlpResourceLogsSchema.safeParse(rawResource);
    if (!resource.success) {
      dropped += 1;
      continue;
    }
    const scopeLogs = [];
    for (const rawScope of resource.data.scopeLogs ?? []) {
      const scope = OtlpScopeLogsSchema.safeParse(rawScope);
      if (!scope.success) {
        dropped += 1;
        continue;
      }
      const logRecords = [];
      for (const rawRecord of scope.data.logRecords ?? []) {
        const record = OtlpLogRecordSchema.safeParse(rawRecord);
        if (!record.success) {
          dropped += 1;
          continue;
        }
        logRecords.push(record.data);
      }
      if (logRecords.length > 0) scopeLogs.push({ scope: scope.data.scope, logRecords });
    }
    if (scopeLogs.length > 0) resources.push({ resource: resource.data.resource, scopeLogs });
  }
  return { payload: { resourceLogs: resources }, dropped };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  response.end(body);
}

/**
 * Read a request body with a hard byte ceiling.
 *
 * Returns `{ ok: false, tooLarge: true }` instead of buffering an
 * unbounded body, and destroys the socket when the cap is hit.
 */
function readBoundedBody(request, maxBytes) {
  return new Promise((resolve) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      resolve({ ok: false, tooLarge: true });
      request.destroy();
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, tooLarge: true });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    request.on("error", () => finish({ ok: false, tooLarge: false }));
    request.on("aborted", () => finish({ ok: false, tooLarge: false }));
  });
}

/**
 * Create the receiver.
 *
 * @param {object} options
 * @param {import("./journal.mjs").Journal} options.journal
 * @param {object} [options.logger]
 */
export function createReceiver({ journal, logger = NULL_LOGGER, host = RECEIVER_HOST, port = RECEIVER_PORT, sources = [] } = {}) {
  if (!journal) throw new Error("The receiver needs a journal");
  const configuredSources = sources.map((source) => ({ id: source.id, platform: source.platform, digest: createHash("sha256").update(source.token).digest() }));
  if (host !== "127.0.0.1" && host !== "::1" && configuredSources.length === 0) throw new Error("A non-loopback hub receiver requires authenticated sources");

  const server = createServer((request, response) => {
    const source = configuredSources.length ? authenticatedSource(request, configuredSources) : null;
    if (configuredSources.length && !source) {
      sendJson(response, 401, { error: "Authentication required" });
      return;
    }
    //  A rejection inside the handler must never take the hub down: an
    //  unhandled rejection ends the process on Node 15 and later.  The
    //  handler answers a 500 and logs the error NAME only, because the
    //  message of an error can quote the payload.
    void handleRequest(request, response, { journal, logger, source }).catch((error) => {
      logger.error("the otlp request failed", { errorName: error?.name ?? "Error" });
      sendJson(response, 500, { error: "The hub could not handle the request" });
    });
  });

  server.on("clientError", (error, socket) => {
    if (socket && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return {
    server,
    host,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleRequest(request, response, { journal, logger, source }) {
  //  A malformed request target, such as "//", is not a valid URL.  It is
  //  answered with 400 instead of throwing out of the handler.
  let path;
  try {
    path = new URL(request.url ?? "/", `http://${RECEIVER_HOST}:${RECEIVER_PORT}`).pathname;
  } catch {
    sendJson(response, 400, { error: "Malformed request target" });
    return;
  }

  if (path !== "/v1/traces" && path !== "/v1/logs" && path !== "/v1/metrics") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/v1/metrics") {
    sendJson(response, 501, {
      error: "OTLP metrics are not supported: the hub has no metrics destination",
    });
    return;
  }

  const contentType = String(request.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    sendJson(response, 415, {
      error: `Unsupported Content-Type "${contentType.slice(0, 64)}". Send application/json.`,
    });
    return;
  }

  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) {
    if (read.tooLarge) {
      sendJson(response, 413, { error: "Payload too large" });
      return;
    }
    sendJson(response, 400, { error: "Could not read the request body" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(read.body.toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Body is not valid JSON" });
    return;
  }
  if (!isPlainObject(payload)) {
    sendJson(response, 400, { error: "Body must be a JSON object" });
    return;
  }

  //  The envelope is validated before a normalizer sees it, and then the
  //  rows inside it are validated one by one.  A payload that is not an
  //  OTLP payload at all, or one that has no usable row left, is refused
  //  with 400 and a fixed message: the answer never quotes the payload.
  const isTraces = path === "/v1/traces";
  const schema = isTraces ? OTLP_TRACES_SCHEMA : OTLP_LOGS_SCHEMA;
  const checked = schema.safeParse(payload);
  if (!checked.success) {
    logger.warn("the otlp payload is not an otlp envelope", {
      path,
      issues: checked.error.issues.length,
    });
    sendJson(response, 400, { error: "The OTLP payload does not match the expected shape" });
    return;
  }

  const projected = isTraces ? projectTraces(checked.data) : projectLogs(checked.data);
  const identity = source ? { sourceId: source.id, platform: source.platform } : {};
  const normalized = isTraces
    ? normalizeOtlpTraces(projected.payload, identity)
    : normalizeOtlpLogs(projected.payload, identity);
  if (source) {
    for (const event of normalized.events) {
      event.platform = source.platform;
      event.authenticatedSource = source.id;
      event.serviceName = `telemetry-hub.${source.id}`;
      // Caller-supplied attribute aliases cannot undo the authenticated identity.
      for (const key of ["agent.platform", "gen_ai.system", "gen_ai.agent.name", "agent.seat", "seat"]) delete event.attrs?.[key];
    }
  }
  const ignored = normalized.ignored + projected.dropped;
  if (projected.dropped > 0) {
    logger.warn("the otlp payload had rows that do not match the expected shape", {
      path,
      dropped: projected.dropped,
    });
  }
  if (normalized.events.length === 0) {
    sendJson(response, 400, { error: "The OTLP payload has no usable row" });
    return;
  }

  //  One write and one fsync for the whole batch: a flush per event delays
  //  the answer and invites the producer to retry the same spans.
  const written = await journal.appendBatch(normalized.events);
  logger.info("receiver accepted a batch", {
    path,
    received: normalized.events.length,
    ignored,
    written: normalized.events.length,
    bytes: written,
  });
  sendJson(response, 200, {
    ok: true,
    received: normalized.events.length,
    ignored,
    written: normalized.events.length,
  });
}
