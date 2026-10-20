// The local OTLP receiver.
//
// Producers on this Mac post OTLP-JSON to 127.0.0.1:4318.  The receiver
// normalizes each signal into the hub's internal form and appends it to the
// journal.  It never talks to the network itself and it never answers with
// anything derived from a producer value.
//
// The listener is bound to 127.0.0.1 only.  It is never bound to 0.0.0.0:
// this receiver accepts unauthenticated local telemetry, so it must not be
// reachable from the network.
//
// The body cap is 12 MiB, the same as Sentry's container cap, so a malformed
// or hostile producer cannot exhaust memory.  `/v1/metrics` is refused with
// 501: Sentry has no OTLP metrics path and the plan does not either, so
// accepting metrics would only create a sink that can never be delivered.

import { createServer } from "node:http";

import { normalizeOtlpLogs, normalizeOtlpTraces, NULL_LOGGER } from "./internal-event.mjs";

/** The largest body the receiver will read.  Matches Sentry's container cap. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

const RECEIVER_HOST = "127.0.0.1";
const RECEIVER_PORT = 4318;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sendJson(response, status, payload) {
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
export function createReceiver({ journal, logger = NULL_LOGGER, host = RECEIVER_HOST, port = RECEIVER_PORT } = {}) {
  if (!journal) throw new Error("The receiver needs a journal");

  const server = createServer((request, response) => {
    void handleRequest(request, response, { journal, logger });
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

async function handleRequest(request, response, { journal, logger }) {
  const path = new URL(request.url ?? "/", `http://${RECEIVER_HOST}:${RECEIVER_PORT}`).pathname;

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

  const normalized = path === "/v1/traces" ? normalizeOtlpTraces(payload) : normalizeOtlpLogs(payload);
  let written = 0;
  for (const event of normalized.events) {
    await journal.append(event);
    written += 1;
  }
  logger.info("receiver accepted a batch", {
    path,
    received: normalized.events.length,
    ignored: normalized.ignored,
    written,
  });
  sendJson(response, 200, {
    ok: true,
    received: normalized.events.length,
    ignored: normalized.ignored,
    written,
  });
}
