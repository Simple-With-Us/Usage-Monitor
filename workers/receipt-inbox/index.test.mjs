import { describe, expect, it } from "vitest";
import { handleEmail, handleFetch, inspectAttachments, isDedicatedReceiptAddress, isNoForwardRecipient, isReceiptInboxAddress, ReceiptInboxIndex, senderAuthentication, validateLifecycleRules } from "./src/index.mjs";

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
    async forward(address) { this.forwardedTo = address; },
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

  it("forwards an admitted original before storage checks and never reads raw when fallback fails", async () => {
    const { env, storage } = createEnvironment();
    storage.values.set("lifecycle:audit", { ok: false, checkedAt: Date.now() });
    const preserved = receiptMessage("x");
    await expect(handleEmail(preserved, env)).rejects.toThrow("original forwarded");
    expect(preserved.forwardedTo).toBe("socratic.trade@jays.services");

    let rawRead = false;
    const fallbackFailure = receiptMessage("x", {
      async forward() { throw new Error("simulated fallback failure"); },
    });
    Object.defineProperty(fallbackFailure, "raw", {
      get() { rawRead = true; return stream(new Uint8Array([1])); },
    });
    await expect(handleEmail(fallbackFailure, env)).rejects.toThrow("simulated fallback failure");
    expect(rawRead).toBe(false);
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

  it("recovers a pending reservation after an R2 failure instead of suppressing the retry", async () => {
    const { env, storage } = createEnvironment();
    env.RECEIPTS_BUCKET.failNextPut = true;
    await expect(handleEmail(receiptMessage(rawReceipt()), env)).rejects.toThrow("simulated R2 failure");
    expect([...storage.values.keys()].some((key) => key.startsWith("pending:"))).toBe(true);

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
        body: JSON.stringify({ bytes: 1 }),
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
