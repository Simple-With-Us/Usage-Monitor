// The local OTLP receiver test suite.
//
// The receiver is the only unauthenticated surface the hub exposes, on
// 127.0.0.1.  These tests cover the properties that keep a malformed request
// from reaching the rest of the process: a rejected handler must not become an
// UNHANDLED rejection (Node terminates the process on those by default), and
// the listener must stay up afterwards.
//
// This suite runs under Vitest, not node:test.  The repository's Vitest
// include is the default (`**/*.test.mjs`), so it collects every file in
// this directory.  A node:test suite collected this way is imported by
// Vitest, registers zero tests there, and fails the run with "No test suite
// found in file".  Vitest is a dev dependency only -- the hub itself runs on
// Node builtins alone, with no third-party package.

import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { Journal } from "../journal.mjs";
import { createReceiver } from "../otlp-receiver.mjs";

const created = [];
const opened = [];
const listeners = [];

afterEach(async () => {
  while (listeners.length > 0) {
    await listeners.pop().close();
  }
  while (opened.length > 0) {
    await opened.pop().close();
  }
  while (created.length > 0) {
    await rm(created.pop(), { recursive: true, force: true });
  }
});

/** Start a receiver on an ephemeral port and return its base URL. */
async function listen() {
  const dir = await mkdtemp(join(tmpdir(), "telemetry-hub-receiver-test-"));
  created.push(dir);
  const journal = new Journal({ dir });
  await journal.open();
  await journal.loadDestinations(["um-turns", "um-ingest", "sentry"]);
  opened.push(journal);

  const receiver = createReceiver({ journal, port: 0 });
  listeners.push(receiver);
  const address = await receiver.listen();
  return { journal, base: `http://127.0.0.1:${address.port}` };
}

/**
 * Send a raw request line over a socket.
 *
 * `fetch` normalizes the target before it reaches the server, so the malformed
 * paths this test needs have to go out verbatim.
 */
function rawRequest(port, target) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve({ raw: data, timedOut: true });
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("close", () => resolve({ raw: data, timedOut: false }));
    socket.on("error", () => resolve({ raw: data, timedOut: false, socketError: true }));
  });
}

describe("the otlp receiver", () => {
  it("answers a malformed request path instead of dying on it", async () => {
    //  `//` is a protocol-relative URL with an empty host, so `new URL()`
    //  throws on it before any routing runs.  Unhandled, that rejection takes
    //  the whole hub process down.
    const { base } = await listen();
    const port = Number(new URL(base).port);
    const response = await rawRequest(port, "//");
    assert.equal(response.timedOut, false, "the request must be answered, never hang");
    assert.match(response.raw, /^HTTP\/1\.1 \d{3}/);

    //  The listener is still serving after the bad request.
    const metrics = await fetch(`${base}/v1/metrics`, { method: "POST" });
    assert.equal(metrics.status, 501);
  });

  it("answers a journaling failure without taking the listener down", async () => {
    const { base } = await listen();
    const response = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(response.status, 400);

    const traces = await fetch(`${base}/v1/traces`, { method: "GET" });
    assert.equal(traces.status, 405);
  });

  it("journals a batch in one durable write", async () => {
    const { base } = await listen();
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "gen_ai.system", value: { stringValue: "opencode" } }] },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [1, 2, 3].map((n) => ({
                traceId: String(n).repeat(32).slice(0, 32),
                spanId: String(n).repeat(16).slice(0, 16),
                name: "chat",
                startTimeUnixNano: String(1700000000000000000 + n),
                endTimeUnixNano: String(1700000000100000000 + n),
                attributes: [
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } },
                ],
              })),
            },
          ],
        },
      ],
    };
    const response = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.written, 3);

    const batch = await opened[0].readBatch("sentry", 10);
    assert.equal(batch.events.length, 3);
  });
});
