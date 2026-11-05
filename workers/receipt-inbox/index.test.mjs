import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { auditorReadIsRedundant, handleEmail, handleFetch, HOP_HEADER, inspectAttachments, isDedicatedReceiptAddress, isNoForwardRecipient, isReceiptInboxAddress, mailLoopReason, ReceiptInboxIndex, senderAuthentication, validateLifecycleRules } from "./src/index.mjs";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value(left, right) {
      const leftBytes = new Uint8Array(left);
      const rightBytes = new Uint8Array(right);
      if (leftBytes.byteLength !== rightBytes.byteLength) return false;
      let mismatch = 0;
      for (let index = 0; index < leftBytes.byteLength; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
      return mismatch === 0;
    },
  });
}

class FakeBucket {
  objects = new Map();
  failNextPut = false;
  listCalls = 0;
  headCalls = 0;
  async head() {
    this.headCalls += 1;
    return null;
  }
  async put(key, value) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated R2 failure");
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, bytes);
  }
  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? { body: bytes } : null;
  }
  async list({ prefix = "", limit = 1000 } = {}) {
    this.listCalls += 1;
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit) };
  }
}

class FakeStorage {
  values = new Map();
  alarmAt = null;
  async transaction(callback) { return callback(this); }
  async get(key) { return this.values.get(key); }
  async put(keyOrEntries, value) {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else for (const [key, entry] of Object.entries(keyOrEntries)) this.values.set(key, entry);
  }
  async delete(keyOrKeys) {
    for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) this.values.delete(key);
  }
  async list({ prefix = "", start = "", end = "\uffff", limit = 1000 }) {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix) && key >= start && key < end)
      .sort()
      .slice(0, limit));
  }
  async setAlarm(value) { this.alarmAt = value; }
  async deleteAlarm() { this.alarmAt = null; }
}

function createEnvironment() {
  const storage = new FakeStorage();
  const index = new ReceiptInboxIndex({ storage });
  const controls = {
    failNextCommit: false,
    lifecycleAuditCalls: 0,
    lifecycleAudit: { ok: true, checkedAt: 0 },
  };
  const env = {
    RECEIPT_INBOX_ADDRESS: "receipts-secret-123@receipts.jays.services",
    RECEIPT_INBOX_RETENTION_ACK: "receipt-evidence-lifecycle-configured-v1",
    RECEIPT_INBOX_IDENTITY_KEY: "i".repeat(32),
    RECEIPT_INBOX_READ_TOKEN: "r".repeat(32),
    RECEIPT_INBOX_EVIDENCE_TOKEN: "e".repeat(32),
    RECEIPT_FALLBACK_ADDRESS: "socratic.trade@jays.services",
    LIFECYCLE_AUDITOR: {
      async fetch() {
        controls.lifecycleAuditCalls += 1;
        return Response.json(controls.lifecycleAudit);
      },
    },
    RECEIPTS_BUCKET: new FakeBucket(),
    RECEIPT_INDEX: {
      idFromName: () => "receipt-index",
      get: () => ({
        fetch: (request, init) => {
          const url = new URL(request);
          if (controls.failNextCommit && url.pathname.startsWith("/commit/")) {
            controls.failNextCommit = false;
            return Response.json({ error: "simulated index failure" }, { status: 503 });
          }
          return index.fetch(new Request(request, init));
        },
      }),
    },
  };
  storage.values.set("lifecycle:audit", { ok: true, checkedAt: Date.now() });
  return {
    env,
    index,
    storage,
    controls,
  };
}

function stream(bytes) {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function receiptMessage(rawText, overrides = {}) {
  const raw = new TextEncoder().encode(rawText);
  return {
    from: "billing@openai.com",
    to: "receipts-secret-123@receipts.jays.services",
    headers: new Headers({ "authentication-results": "attacker; dkim=pass; dmarc=pass" }),
    raw: stream(raw),
    rawSize: raw.byteLength,
    async forward(address, headers) { this.forwardedTo = address; this.forwardedHeaders = headers; },
    setReject(reason) { this.rejected = reason; },
    ...overrides,
  };
}

function rawReceipt(wrapper = "Private account receipt 1234") {
  return [
    "From: OpenAI Billing <billing@openai.com>",
    "To: receipts-secret-123@receipts.jays.services",
    `Subject: ${wrapper}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=receipt",
    "",
    "--receipt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your receipt is attached.",
    "--receipt",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=private-account-receipt.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--receipt--",
    "",
  ].join("\r\n");
}

function rawImageReceipt(wrapper) {
  return [
    "From: OpenAI Billing <billing@openai.com>",
    "To: receipts-secret-123@receipts.jays.services",
    `Subject: ${wrapper}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/related; boundary=receipt",
    "",
    "--receipt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Receipt body ${wrapper}`,
    "--receipt",
    "Content-Type: image/png",
    "Content-Disposition: inline; filename=logo.png",
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--receipt--",
    "",
  ].join("\r\n");
}

describe("receipt inbox email worker", () => {
  it("accepts any local-part on receipts.jays.services, including short and high-entropy", () => {
    expect(isReceiptInboxAddress("receipts@receipts.jays.services")).toBe(true);
    expect(isReceiptInboxAddress("short@receipts.jays.services")).toBe(true);
    expect(isReceiptInboxAddress("receipts-secret-123@receipts.jays.services")).toBe(true);
    expect(isReceiptInboxAddress("rcpt-abcdef0123456789@receipts.jays.services")).toBe(true);
    // Apex and other subdomains stay rejected (personal mail / non-intake).
    expect(isReceiptInboxAddress("receipts-secret-123@jays.services")).toBe(false);
    expect(isReceiptInboxAddress("receipts@mail.jays.services")).toBe(false);
    expect(isReceiptInboxAddress("not-an-email")).toBe(false);
    // Alias keeps working for older call sites.
    expect(isDedicatedReceiptAddress("receipts@receipts.jays.services")).toBe(true);
  });

  it("rejects unknown recipients, missing retention acknowledgement, and oversize messages before reading raw", async () => {
    const { env, storage } = createEnvironment();
    let rawRead = false;
    const message = receiptMessage("x", { rawSize: 11 * 1024 * 1024 });
    Object.defineProperty(message, "raw", { get() { rawRead = true; return stream(new Uint8Array([1])); } });
    await handleEmail(message, env);
    expect(message.rejected).toContain("exceeds");
    expect(rawRead).toBe(false);

    // Other domains / apex are still unknown even if configured wrongly.
    let apexRawRead = false;
    const apex = receiptMessage("x", { to: "receipts-secret-123@jays.services" });
    Object.defineProperty(apex, "raw", {
      get() { apexRawRead = true; return stream(new Uint8Array([1])); },
    });
    await handleEmail(apex, {
      ...env,
      RECEIPT_INBOX_ADDRESS: "receipts-secret-123@jays.services",
    });
    expect(apex.rejected).toBe("Unknown receipt mailbox");
    expect(apex.forwardedTo).toBeUndefined();
    expect(apexRawRead).toBe(false);

    const foreignDomain = receiptMessage("x", { to: "receipts@example.com" });
    await handleEmail(foreignDomain, env);
    expect(foreignDomain.rejected).toBe("Unknown receipt mailbox");

    const noRetention = receiptMessage("x");
    await handleEmail(noRetention, { ...env, RECEIPT_INBOX_RETENTION_ACK: "" });
    expect(noRetention.rejected).toContain("retention");

    storage.values.set("lifecycle:audit", { ok: false, checkedAt: Date.now() });
    const lifecycleDrift = receiptMessage("x");
    await expect(handleEmail(lifecycleDrift, env)).rejects.toThrow("lifecycle readiness");
    expect(lifecycleDrift.forwardedTo).toBe("socratic.trade@jays.services");
  });

  it("admits short *@receipts.jays.services recipients as well as the configured high-entropy address", async () => {
    const { env } = createEnvironment();
    await handleEmail(
      receiptMessage(rawReceipt("short-address receipt"), {
        to: "receipts@receipts.jays.services",
      }),
      env
    );
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);

    // Separate index/bucket: attachment-group dedupe is intentional across
    // identical PDFs, so this case needs an isolated environment.
    const shortConfig = createEnvironment();
    shortConfig.env.RECEIPT_INBOX_ADDRESS = "receipts@receipts.jays.services";
    await handleEmail(
      receiptMessage(rawReceipt("long-address receipt"), {
        to: "rcpt-abcdef0123456789xyz@receipts.jays.services",
      }),
      shortConfig.env
    );
    expect(shortConfig.env.RECEIPTS_BUCKET.objects.size).toBe(1);
  });

  it("dedupes identical MIME and different wrappers around the same supported attachment", async () => {
    const { env } = createEnvironment();
    await handleEmail(receiptMessage(rawReceipt()), env);
    await handleEmail(receiptMessage(rawReceipt()), env);
    await handleEmail(receiptMessage(rawReceipt("Forwarded wrapper changed")), env);
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);

    const response = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env);
    const body = await response.json();
    expect(body.needsReviewCount).toBe(1);
    expect(body.items[0]).toMatchObject({
      senderDomain: "openai.com",
      senderAuthentication: "unknown",
      supportedAttachmentCount: 1,
      status: "needs_review",
      subject: "Private account receipt 1234",
    });
    expect(JSON.stringify(body)).not.toContain("private-account-receipt.pdf");
    expect(JSON.stringify(body)).not.toContain("billing@openai.com");
  });

  it("does not merge distinct receipts that reuse an inline image", async () => {
    const { env } = createEnvironment();
    await handleEmail(receiptMessage(rawImageReceipt("first")), env);
    await handleEmail(receiptMessage(rawImageReceipt("second")), env);
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(2);
  });

  it("forwards before storage checks; relay rejection still files evidence in R2", async () => {
    const { env, storage } = createEnvironment();
    storage.values.set("lifecycle:audit", { ok: false, checkedAt: Date.now() });
    const preserved = receiptMessage("x");
    await expect(handleEmail(preserved, env)).rejects.toThrow("original forwarded");
    expect(preserved.forwardedTo).toBe("socratic.trade@jays.services");

    const { env: healthyEnv } = createEnvironment();
    const fallbackFailure = receiptMessage(rawReceipt("relay rejected receipt"), {
      async forward() { throw new Error("simulated fallback failure"); },
    });
    await handleEmail(fallbackFailure, healthyEnv);
    expect(fallbackFailure.forwardedTo).toBeUndefined();
    expect(healthyEnv.RECEIPTS_BUCKET.objects.size).toBe(1);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), healthyEnv).then((response) => response.json());
    expect(summary.items[0].forwardedToFallback).toBe(false);
  });

  it("matches the no-forward local-part case-insensitively and ignores other recipients", () => {
    expect(isNoForwardRecipient("filing-only@receipts.jays.services", "filing-only")).toBe(true);
    expect(isNoForwardRecipient("FILING-ONLY@receipts.jays.services", "filing-only")).toBe(true);
    expect(isNoForwardRecipient("other@receipts.jays.services", "filing-only")).toBe(false);
    expect(isNoForwardRecipient("filing-only@receipts.jays.services", "")).toBe(false);
    expect(isNoForwardRecipient("filing-only@receipts.jays.services", "   ")).toBe(false);
    expect(isNoForwardRecipient("filing-only@receipts.jays.services", undefined)).toBe(false);
    expect(isNoForwardRecipient(undefined, "filing-only")).toBe(false);
  });

  it("files no-forward intake without fallback forwarding or fallback configuration", async () => {
    const { env } = createEnvironment();
    env.RECEIPT_NO_FORWARD_LOCAL_PART = "filing-only";
    const message = receiptMessage(rawReceipt("no-forward receipt"), {
      to: "filing-only@receipts.jays.services",
    });
    await handleEmail(message, env);
    expect(message.forwardedTo).toBeUndefined();
    expect(message.rejected).toBeUndefined();
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].forwardedToFallback).toBe(false);

    // No-forward intake does not require the fallback destination either.
    const { env: envNoFallback } = createEnvironment();
    envNoFallback.RECEIPT_NO_FORWARD_LOCAL_PART = "filing-only";
    delete envNoFallback.RECEIPT_FALLBACK_ADDRESS;
    const messageNoFallback = receiptMessage(rawReceipt("no-forward receipt"), {
      to: "FILING-ONLY@receipts.jays.services",
    });
    await handleEmail(messageNoFallback, envNoFallback);
    expect(messageNoFallback.forwardedTo).toBeUndefined();
    expect(messageNoFallback.rejected).toBeUndefined();
    expect(envNoFallback.RECEIPTS_BUCKET.objects.size).toBe(1);

    // The normal path still forwards.
    const { env: envNormal } = createEnvironment();
    const normal = receiptMessage(rawReceipt("normal receipt"));
    await handleEmail(normal, envNormal);
    expect(normal.forwardedTo).toBe("socratic.trade@jays.services");
  });

  it("reports healthy on /health for no-forward-only deployments", async () => {
    const { env } = createEnvironment();
    env.RECEIPT_NO_FORWARD_LOCAL_PART = "filing-only";
    delete env.RECEIPT_FALLBACK_ADDRESS;
    const health = await handleFetch(new Request("https://receipt-inbox.jays.services/health", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(health.ok).toBe(true);

    // Normal recipients are still rejected without a fallback.
    const normal = receiptMessage(rawReceipt("normal receipt"));
    await handleEmail(normal, env);
    expect(normal.rejected).toBe("Receipt fallback is not configured");
  });

  it("releases its reservation after an R2 failure, so the retry is not suppressed", async () => {
    const { env, storage } = createEnvironment();
    env.RECEIPTS_BUCKET.failNextPut = true;
    await expect(handleEmail(receiptMessage(rawReceipt()), env)).rejects.toThrow("simulated R2 failure");
    const reservationKeys = () => [...storage.values.keys()].filter((key) => /^(?:pending|pending-expire|dedupe):/.test(key));
    expect(reservationKeys()).toEqual([]);

    await handleEmail(receiptMessage(rawReceipt()), env);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(summary.needsReviewCount).toBe(1);
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
    expect([...storage.values.keys()].some((key) => key.startsWith("pending:"))).toBe(false);
  });

  it("recovers when evidence storage succeeds but the visible index commit fails", async () => {
    const { env, controls } = createEnvironment();
    controls.failNextCommit = true;
    await expect(handleEmail(receiptMessage(rawReceipt()), env)).rejects.toThrow("HTTP 503");
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);

    await handleEmail(receiptMessage(rawReceipt()), env);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(summary.needsReviewCount).toBe(1);
  });

  it("requires separate tokens for summary/evidence and can resolve review status", async () => {
    const { env } = createEnvironment();
    await handleEmail(receiptMessage(rawReceipt()), env);
    const unauthorized = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary"), env);
    expect(unauthorized.status).toBe(401);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    const id = summary.items[0].id;

    const evidence = await handleFetch(new Request(`https://receipt-inbox.jays.services/v1/receipts/${id}/evidence`, {
      headers: { Authorization: `Bearer ${"e".repeat(32)}` },
    }), env);
    expect(evidence.headers.get("content-disposition")).toContain("attachment");
    expect(evidence.headers.get("x-content-type-options")).toBe("nosniff");

    const reviewed = await handleFetch(new Request(`https://receipt-inbox.jays.services/v1/receipts/${id}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${"e".repeat(32)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "reviewed" }),
    }), env);
    expect(await reviewed.json()).toEqual({ result: "updated" });
    const after = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(after.needsReviewCount).toBe(0);
    expect(after.items).toEqual([]);
  });

  it("requires the read token before probing storage readiness", async () => {
    const { env } = createEnvironment();
    const unauthorized = await handleFetch(new Request("https://receipt-inbox.jays.services/health"), env);
    expect(unauthorized.status).toBe(401);
    const ready = await handleFetch(new Request("https://receipt-inbox.jays.services/health", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, status: "ready" });
  });

  it("refreshes stale lifecycle readiness through the isolated auditor service", async () => {
    const { env, storage, controls } = createEnvironment();
    storage.values.set("lifecycle:audit", { ok: false, checkedAt: 0 });
    controls.lifecycleAudit = { ok: true, checkedAt: Date.now() };
    const ready = await handleFetch(new Request("https://receipt-inbox.jays.services/health", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env);
    expect(ready.status).toBe(200);
    expect(controls.lifecycleAuditCalls).toBe(1);
    expect(storage.values.get("lifecycle:audit")).toMatchObject({ ok: true });
  });

  it("atomically enforces the durable daily message ceiling", async () => {
    const { env, index } = createEnvironment();
    for (let number = 0; number < 101; number += 1) {
      const response = await index.fetch(new Request("https://receipt-index.internal/admit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes: 1, noForward: true }),
      }));
      expect((await response.json()).result).toBe(number < 100 ? "admitted" : "quota_exceeded");
    }

    let rawRead = false;
    const rejected = receiptMessage("x");
    Object.defineProperty(rejected, "raw", {
      get() { rawRead = true; return stream(new Uint8Array([1])); },
    });
    await handleEmail(rejected, env);
    expect(rejected.rejected).toContain("daily intake limit");
    expect(rejected.forwardedTo).toBeUndefined();
    expect(rawRead).toBe(false);
  });

  it("checks attachment magic bytes and never trusts Authentication-Results", () => {
    expect(inspectAttachments([
      { mimeType: "application/pdf", content: new TextEncoder().encode("not a pdf") },
      { mimeType: "image/png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ])).toMatchObject({ supportedAttachmentCount: 1, rejectedAttachmentCount: 1 });
    const validPng = { mimeType: "image/png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
    expect(inspectAttachments(Array.from({ length: 6 }, () => validPng))).toMatchObject({
      attachmentCount: 6,
      supportedAttachmentCount: 5,
      rejectedAttachmentCount: 1,
    });
    expect(senderAuthentication(new Headers({ "authentication-results": "attacker; dmarc=pass" }))).toBe("unknown");
  });

  it("does not POST owner expenses from unauthenticated email intake", async () => {
    const { env } = createEnvironment();
    env.OWNER_EXPENSE_TOKEN = "o".repeat(32);
    env.OWNER_EXPENSE_INGEST_URL = "https://usage.jays.services";
    env.XAI_API_KEY = "x".repeat(32);
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body });
      if (String(url).includes("api.x.ai") || String(url).includes("api.deepseek.com")) {
        return new Response("unavailable", { status: 503 });
      }
      throw new Error("intake must not call the network to file ledger cash");
    };
    try {
      const priced = rawReceipt("OpenAI invoice Amount paid $19.99").replace(
        "Your receipt is attached.",
        "Amount paid $19.99 Total $19.99",
      );
      await handleEmail(receiptMessage(priced), env);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.every((call) => !String(call.url).includes("owner-expenses"))).toBe(true);
    expect(calls.every((call) => !String(call.url).includes("usage.jays.services"))).toBe(true);
    const summary = await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", {
      headers: { Authorization: `Bearer ${"r".repeat(32)}` },
    }), env).then((response) => response.json());
    expect(summary.needsReviewCount).toBe(1);
    expect(summary.items[0]).toMatchObject({
      amountUsd: 19.99,
      classificationAction: "file",
      status: "needs_review",
    });
  });

  it("requires one exact non-conflicting 180-day evidence lifecycle rule", () => {
    const exact = {
      id: "receipt-retention",
      enabled: true,
      conditions: { prefix: "evidence/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 15_552_000 } },
    };
    expect(validateLifecycleRules([exact])).toBe(true);
    expect(validateLifecycleRules([exact, {
      id: "conflicting-global-delete",
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
    }])).toBe(false);
    expect(validateLifecycleRules([{ ...exact, enabled: false }])).toBe(false);
  });
});

function receivedHeader(count, cloudflarePasses = 2) {
  const headers = new Headers();
  for (let number = 0; number < count; number += 1) {
    const by = number < cloudflarePasses ? "cloudflare-email.net" : "b.example";
    headers.append("received", `from a${number}.example (a${number}.example [192.0.2.1]) by ${by} with ESMTPS id x${number} for <r@receipts.jays.services>; Tue, 3 Nov 2026 12:00:0${number % 10} +0000`);
  }
  return headers;
}

function forbidIndex(env) {
  env.RECEIPT_INDEX = {
    idFromName: () => "receipt-index",
    get: () => ({ fetch: () => { throw new Error("must not call the Durable Object"); } }),
  };
}

function readHeaders() {
  return { headers: { Authorization: `Bearer ${"r".repeat(32)}` } };
}

describe("mail loop guard", () => {
  it("tags every fallback forward with the hop header", async () => {
    const { env } = createEnvironment();
    const message = receiptMessage(rawReceipt("hop tag"));
    await handleEmail(message, env);
    expect(message.forwardedHeaders.get(HOP_HEADER)).toBe("1");
  });

  it("drops a hop-tagged copy before any Durable Object call, forward or reject", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const message = receiptMessage("x", { headers: new Headers({ [HOP_HEADER]: "1" }) });
    await handleEmail(message, env);
    expect(message.forwardedTo).toBeUndefined();
    expect(message.rejected).toBeUndefined();
  });

  it("drops a copy over 8 Received headers, counting headers rather than date commas", async () => {
    expect(mailLoopReason(receivedHeader(8))).toBeNull();
    expect(mailLoopReason(receivedHeader(9))).toBe("received_count");
    expect(mailLoopReason(new Headers())).toBeNull();
    expect(mailLoopReason(undefined)).toBeNull();

    const { env } = createEnvironment();
    forbidIndex(env);
    const message = receiptMessage("x", { headers: receivedHeader(10) });
    await handleEmail(message, env);
    expect(message.forwardedTo).toBeUndefined();
    expect(message.rejected).toBeUndefined();
  });

  it("files mail with an ordinary Received chain", async () => {
    const { env } = createEnvironment();
    const message = receiptMessage(rawReceipt("ordinary chain"), { headers: receivedHeader(7) });
    await handleEmail(message, env);
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
  });

  it("never silently drops a long first delivery that crossed Cloudflare once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mailLoopReason(receivedHeader(15, 1))).toBeNull();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "receipt_long_received_chain" }));

    const { env } = createEnvironment();
    const message = receiptMessage(rawReceipt("long corporate chain"), { headers: receivedHeader(15, 1) });
    await handleEmail(message, env);
    expect(message.forwardedTo).toBe("socratic.trade@jays.services");
    expect(message.rejected).toBeUndefined();
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
    warn.mockRestore();
  });
});

describe("daily intake sub-limits", () => {
  const admit = (index, body) => index.fetch(new Request("https://receipt-index.internal/admit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).then((response) => response.json());

  it("limits one sender domain to 20 messages a day without blocking others", async () => {
    const { index } = createEnvironment();
    for (let number = 0; number < 20; number += 1) {
      expect((await admit(index, { bytes: 1, senderDomain: "spam.example" })).result).toBe("admitted");
    }
    expect(await admit(index, { bytes: 1, senderDomain: "spam.example" })).toEqual({ result: "quota_exceeded", scope: "sender" });
    expect((await admit(index, { bytes: 1, senderDomain: "vendor.example" })).result).toBe("admitted");
  });

  it("limits one sender domain's bytes, so ten huge messages cannot use the whole day", async () => {
    const { index } = createEnvironment();
    const bytes = 10 * 1024 * 1024;
    expect((await admit(index, { bytes, senderDomain: "big.example" })).result).toBe("admitted");
    expect((await admit(index, { bytes, senderDomain: "big.example" })).result).toBe("admitted");
    expect(await admit(index, { bytes, senderDomain: "big.example" })).toEqual({ result: "quota_exceeded", scope: "sender" });
  });

  it("is not confused by a sender domain named like an Object property", async () => {
    const { index } = createEnvironment();
    expect((await admit(index, { bytes: 1, senderDomain: "constructor" })).result).toBe("admitted");
    expect((await admit(index, { bytes: 1, senderDomain: "constructor" })).result).toBe("admitted");
  });

  it("keeps a reserve for no-forward batches once public mail reaches its 60", async () => {
    const { index } = createEnvironment();
    for (let number = 0; number < 60; number += 1) {
      expect((await admit(index, { bytes: 1, senderDomain: `d${number}.example` })).result).toBe("admitted");
    }
    expect(await admit(index, { bytes: 1, senderDomain: "late.example" })).toEqual({ result: "quota_exceeded", scope: "public" });
    for (let number = 0; number < 40; number += 1) {
      expect((await admit(index, { bytes: 1, senderDomain: "agent.example", noForward: true })).result).toBe("admitted");
    }
    expect(await admit(index, { bytes: 1, senderDomain: "agent.example", noForward: true })).toEqual({ result: "quota_exceeded", scope: "daily" });
  });

  it("exempts a large no-forward batch from the sender limit", async () => {
    const { index } = createEnvironment();
    for (let number = 0; number < 40; number += 1) {
      expect((await admit(index, { bytes: 1, senderDomain: "agent.example", noForward: true })).result).toBe("admitted");
    }
    expect((await admit(index, { bytes: 1, senderDomain: "vendor.example" })).result).toBe("admitted");
  });

  it("counts a record written before the sub-limits existed as public", async () => {
    const { index, storage } = createEnvironment();
    const day = new Date().toISOString().slice(0, 10);
    storage.values.set(`daily:${day}`, { count: 60, bytes: 60 });
    expect((await admit(index, { bytes: 1, senderDomain: "vendor.example" })).scope).toBe("public");
    expect((await admit(index, { bytes: 1, noForward: true })).result).toBe("admitted");
  });

  it("sends the sender domain and path from the email handler", async () => {
    const { env, index } = createEnvironment();
    for (let number = 0; number < 20; number += 1) await admit(index, { bytes: 1, senderDomain: "openai.com" });
    const limited = receiptMessage(rawReceipt("over the sender limit"));
    await handleEmail(limited, env);
    expect(limited.rejected).toContain("daily intake limit");
    expect(limited.forwardedTo).toBeUndefined();

    env.RECEIPT_NO_FORWARD_LOCAL_PART = "filing-only";
    const batch = receiptMessage(rawReceipt("batch path"), { to: "filing-only@receipts.jays.services" });
    await handleEmail(batch, env);
    expect(batch.rejected).toBeUndefined();
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
  });
});

describe("failed evidence puts", () => {
  it("frees the attachment group, so a different wrapper of the same PDF is not busy for a day", async () => {
    const { env, storage } = createEnvironment();
    env.RECEIPTS_BUCKET.failNextPut = true;
    const pdf = rawReceipt("first wrapper");
    await expect(handleEmail(receiptMessage(pdf), env)).rejects.toThrow("simulated R2 failure");
    expect([...storage.values.keys()].some((key) => key.startsWith("group:"))).toBe(false);

    await handleEmail(receiptMessage(rawReceipt("second wrapper")), env);
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(1);
  });

  it("still reports the put failure when the release also fails", async () => {
    const { env, storage } = createEnvironment();
    const real = env.RECEIPT_INDEX.get();
    env.RECEIPT_INDEX = {
      idFromName: () => "receipt-index",
      get: () => ({
        fetch: (request, init) => (new URL(request).pathname.startsWith("/release/")
          ? Response.json({ error: "simulated" }, { status: 503 })
          : real.fetch(request, init)),
      }),
    };
    env.RECEIPTS_BUCKET.failNextPut = true;
    await expect(handleEmail(receiptMessage(rawReceipt("release fails")), env)).rejects.toThrow("simulated R2 failure");
    expect([...storage.values.keys()].some((key) => key.startsWith("pending:"))).toBe(true);
  });

  it("keeps the reservation when only the commit fails, because the evidence is stored", async () => {
    const { env, storage, controls } = createEnvironment();
    controls.failNextCommit = true;
    await expect(handleEmail(receiptMessage(rawReceipt("commit fails")), env)).rejects.toThrow("HTTP 503");
    expect([...storage.values.keys()].some((key) => key.startsWith("pending:"))).toBe(true);
  });

  it("does not release a group marker held by another reservation", async () => {
    const { index, storage } = createEnvironment();
    const id = "1".repeat(64);
    const other = "2".repeat(64);
    const groupId = "3".repeat(64);
    const receivedAt = new Date().toISOString();
    await storage.put({
      [`pending:${id}`]: { id, groupId, receivedAt, status: "pending" },
      [`dedupe:${id}`]: { id, status: "pending" },
      [`group:${groupId}`]: { id: other, status: "committed" },
    });
    const released = await index.fetch(new Request(`https://receipt-index.internal/release/${id}`, { method: "POST" }));
    expect(await released.json()).toEqual({ result: "released" });
    expect(await storage.get(`group:${groupId}`)).toEqual({ id: other, status: "committed" });
    const again = await index.fetch(new Request(`https://receipt-index.internal/release/${id}`, { method: "POST" }));
    expect(await again.json()).toEqual({ result: "not_found" });
  });
});

describe("forward failure logs", () => {
  it("log a fixed kind and never the provider's text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createEnvironment();
    const refused = receiptMessage(rawReceipt("relay refused"), {
      async forward() { throw new Error("550 CS01 rejected for private.person@example.com"); },
    });
    await handleEmail(refused, env);
    const paused = receiptMessage("x", {
      async forward() { throw new Error("unexpected failure for private.person@example.com"); },
    });
    await handleEmail(paused, { ...env, GUARD_MODE: "off" });
    const lines = error.mock.calls.map((call) => call.join(" "));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "receipt_fallback_forward_failed", paused: false, kind: "relay_policy" },
      { event: "receipt_fallback_forward_failed", paused: true, kind: "other" },
    ]);
    expect(lines.join(" ")).not.toContain("private.person");
    error.mockRestore();
  });
});

describe("readiness cost", () => {
  it("never lists R2 on email or summary, and heads one fixed key on /health", async () => {
    const { env } = createEnvironment();
    await handleEmail(receiptMessage(rawReceipt("readiness cost")), env);
    await handleFetch(new Request("https://receipt-inbox.jays.services/v1/receipts/summary", readHeaders()), env);
    expect(env.RECEIPTS_BUCKET.listCalls).toBe(0);
    expect(env.RECEIPTS_BUCKET.headCalls).toBe(0);

    const health = await handleFetch(new Request("https://receipt-inbox.jays.services/health", readHeaders()), env);
    expect(health.status).toBe(200);
    expect(env.RECEIPTS_BUCKET.listCalls).toBe(0);
    expect(env.RECEIPTS_BUCKET.headCalls).toBe(1);
  });

  it("reports /health unavailable when the R2 head fails", async () => {
    const { env } = createEnvironment();
    env.RECEIPTS_BUCKET.head = async () => { throw new Error("simulated R2 outage"); };
    const health = await handleFetch(new Request("https://receipt-inbox.jays.services/health", readHeaders()), env);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ reason: "storage_unavailable" });
  });

  it("skips the auditor read only for an ok result taken since the latest cron", async () => {
    const twelveHours = 12 * 60 * 60 * 1000;
    const slot = Date.UTC(2026, 10, 4, 12, 17);
    expect(auditorReadIsRedundant({ ok: true, checkedAt: slot + 1000 }, slot + 3600_000)).toBe(true);
    // A cron has run since this result, including when an off-cron audit made it recent.
    expect(auditorReadIsRedundant({ ok: true, checkedAt: slot - 3600_000 }, slot + 1000)).toBe(false);
    expect(auditorReadIsRedundant({ ok: true, checkedAt: slot - twelveHours }, slot + 1000)).toBe(false);
    expect(auditorReadIsRedundant({ ok: false, checkedAt: slot + 1000 }, slot + 3600_000)).toBe(false);
    expect(auditorReadIsRedundant({ ok: true, checkedAt: slot + 7200_000 }, slot + 3600_000)).toBe(false);

    const { env, storage, controls } = createEnvironment();
    await handleEmail(receiptMessage(rawReceipt("fresh audit")), env);
    expect(controls.lifecycleAuditCalls).toBe(0);

    const past = Date.now() - twelveHours - 60_000;
    storage.values.set("lifecycle:audit", { ok: true, checkedAt: past });
    controls.lifecycleAudit = { ok: false, checkedAt: Date.now() };
    const drifted = receiptMessage(rawReceipt("bad cron result"));
    await expect(handleEmail(drifted, env)).rejects.toThrow("lifecycle readiness");
    expect(controls.lifecycleAuditCalls).toBe(1);
  });

  it("keeps the cron slots in step with the auditor schedule", () => {
    const config = readFileSync(new URL("../receipt-lifecycle-auditor/wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toContain('"crons": ["17 */12 * * *"]');
  });

  it("backs a cleanup backlog off to 30 seconds instead of 1", async () => {
    const { index, storage } = createEnvironment();
    await index.scheduleNextAlarm(true);
    expect(storage.alarmAt).toBeGreaterThanOrEqual(Date.now() + 25_000);
  });
});

describe("guard off", () => {
  const off = { GUARD_MODE: "off" };

  it("answers 503 on every route before any auth or storage", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const response = await handleFetch(new Request("https://receipt-inbox.jays.services/health", readHeaders()), { ...env, ...off });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(env.RECEIPTS_BUCKET.headCalls).toBe(0);
  });

  it("forwards mail to the fallback instead of bouncing, touching nothing else", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const message = receiptMessage(rawReceipt("paused"));
    await handleEmail(message, { ...env, ...off });
    expect(message.forwardedTo).toBe("socratic.trade@jays.services");
    expect(message.forwardedHeaders.get(HOP_HEADER)).toBe("1");
    expect(message.rejected).toBeUndefined();
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(0);
  });

  it("forwards no-forward mail too, since nothing else would keep it", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const message = receiptMessage(rawReceipt("paused batch"), { to: "filing-only@receipts.jays.services" });
    await handleEmail(message, { ...env, ...off, RECEIPT_NO_FORWARD_LOCAL_PART: "filing-only" });
    expect(message.forwardedTo).toBe("socratic.trade@jays.services");
  });

  it("rejects only when no copy can be kept", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const noFallback = receiptMessage("x");
    await handleEmail(noFallback, { ...env, ...off, RECEIPT_FALLBACK_ADDRESS: undefined });
    expect(noFallback.rejected).toContain("paused");

    const failing = receiptMessage("x", { async forward() { throw new Error("relay refused"); } });
    await handleEmail(failing, { ...env, ...off });
    expect(failing.rejected).toContain("paused");
  });

  it("still drops looped copies and rejects unknown mailboxes", async () => {
    const { env } = createEnvironment();
    forbidIndex(env);
    const looped = receiptMessage("x", { headers: new Headers({ [HOP_HEADER]: "1" }) });
    await handleEmail(looped, { ...env, ...off });
    expect(looped.forwardedTo).toBeUndefined();
    expect(looped.rejected).toBeUndefined();

    const unknown = receiptMessage("x", { to: "someone@example.com" });
    await handleEmail(unknown, { ...env, ...off });
    expect(unknown.rejected).toBe("Unknown receipt mailbox");
    expect(unknown.forwardedTo).toBeUndefined();
  });

  it("skips alarm cleanup", async () => {
    const storage = new FakeStorage();
    storage.values.set("pending-expire:0000000000001:x", "x");
    await new ReceiptInboxIndex({ storage }, off).alarm();
    expect(storage.values.has("pending-expire:0000000000001:x")).toBe(true);
    await new ReceiptInboxIndex({ storage }, {}).alarm();
    expect(storage.values.has("pending-expire:0000000000001:x")).toBe(false);
  });
});

describe("R2 budget", () => {
  async function freshModule() {
    vi.resetModules();
    return import("./src/index.mjs");
  }

  it("refuses puts past 60 a minute and neither throws nor loses a forwarded copy", async () => {
    const { storeAndCommitEvidence, handleEmail: freshHandleEmail } = await freshModule();
    const { env } = createEnvironment();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "a".repeat(64);
    env.RECEIPT_INDEX = {
      idFromName: () => "receipt-index",
      get: () => env.realIndex,
    };
    const real = createEnvironment();
    env.realIndex = real.env.RECEIPT_INDEX.get();
    for (let number = 0; number < 60; number += 1) {
      await storeAndCommitEvidence(env, id, new Uint8Array([1])).catch(() => {});
    }
    const before = env.RECEIPTS_BUCKET.objects.size;
    await expect(storeAndCommitEvidence(env, id, new Uint8Array([1]))).rejects.toThrow("budget exceeded");
    expect(env.RECEIPTS_BUCKET.objects.size).toBe(before);

    const forwarded = receiptMessage(rawReceipt("budget forwarded"));
    await expect(freshHandleEmail(forwarded, env)).resolves.toBeUndefined();
    expect(forwarded.forwardedTo).toBe("socratic.trade@jays.services");
    expect(forwarded.rejected).toBeUndefined();

    env.RECEIPT_NO_FORWARD_LOCAL_PART = "filing-only";
    const batch = receiptMessage(rawImageReceipt("budget batch"), { to: "filing-only@receipts.jays.services" });
    await expect(freshHandleEmail(batch, env)).resolves.toBeUndefined();
    expect(batch.rejected).toContain("budget");
    warn.mockRestore();
  });

  it("shares one scope across an event, so a second put in it is refused", async () => {
    const fresh = await freshModule();
    const { env } = createEnvironment();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = createEnvironment();
    env.RECEIPT_INDEX = { idFromName: () => "receipt-index", get: () => real.env.RECEIPT_INDEX.get() };
    const id = "b".repeat(64);
    const run = fresh.budget.invocation();
    await fresh.storeAndCommitEvidence(env, id, new Uint8Array([1]), run).catch(() => {});
    const puts = env.RECEIPTS_BUCKET.objects.size;
    expect(puts).toBe(1);
    await expect(fresh.storeAndCommitEvidence(env, id, new Uint8Array([1]), run)).rejects.toThrow("per invocation");
    expect(run.used().r2Put).toBe(1);
    warn.mockRestore();
  });

  it("answers 429 when R2 reads pass the minute cap", async () => {
    const { handleFetch: freshHandleFetch } = await freshModule();
    const { env } = createEnvironment();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = () => new Request("https://receipt-inbox.jays.services/health", readHeaders());
    for (let number = 0; number < 120; number += 1) {
      expect((await freshHandleFetch(request(), env)).status).toBe(200);
    }
    const limited = await freshHandleFetch(request(), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(env.RECEIPTS_BUCKET.headCalls).toBe(120);
    warn.mockRestore();
  });
});
