import { describe, expect, it, vi } from "vitest";
import auditor, {
  auditAndPersist,
  auditReceiptLifecycle,
  LifecycleAuditState,
  persistAudit,
} from "./src/index.mjs";

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "t".repeat(32);

class FakeStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
}

function exactRule() {
  return {
    id: "receipt-retention",
    enabled: true,
    conditions: { prefix: "evidence/" },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 180 * 24 * 60 * 60 } },
  };
}

function createEnvironment() {
  const storage = new FakeStorage();
  const state = new LifecycleAuditState({ storage });
  return {
    storage,
    env: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      RECEIPT_LIFECYCLE_AUDIT_TOKEN: TOKEN,
      AUDIT_STATE: {
        idFromName: (name) => name,
        get: () => ({
          fetch: (request, init) => state.fetch(new Request(request, init)),
        }),
      },
    },
  };
}

function cloudflareResponse(rules) {
  return Response.json({ success: true, result: { rules } });
}

describe("receipt lifecycle auditor", () => {
  it("accepts only the exact receipt lifecycle rule and rejects a conflicting overlap", async () => {
    const { env } = createEnvironment();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cloudflareResponse([exactRule()])));
    await expect(auditReceiptLifecycle(env)).resolves.toMatchObject({ ok: true });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cloudflareResponse([
      exactRule(),
      {
        id: "early-delete",
        enabled: true,
        conditions: { prefix: "evidence/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 60 } },
      },
    ])));
    await expect(auditReceiptLifecycle(env)).resolves.toMatchObject({ ok: false });
  });

  it("fails closed for oversized and malformed lifecycle API bodies", async () => {
    const { env } = createEnvironment();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(auditReceiptLifecycle(env)).resolves.toMatchObject({ ok: false });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(auditReceiptLifecycle(env)).resolves.toMatchObject({ ok: false });
  });

  it("persists an on-demand audit through its own Durable Object", async () => {
    const { env, storage } = createEnvironment();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cloudflareResponse([exactRule()])));
    const response = await auditor.fetch(new Request("https://auditor.internal/audit", { method: "POST" }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(storage.values.get("audit")).toMatchObject({ ok: true });
    const status = await auditor.fetch(new Request("https://auditor.internal/status"), env);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ ok: true });
  });

  it("persists a scheduled audit using waitUntil", async () => {
    const { env, storage } = createEnvironment();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cloudflareResponse([exactRule()])));
    const work = [];
    await auditor.scheduled({}, env, { waitUntil: (promise) => work.push(promise) });
    await Promise.all(work);
    expect(storage.values.get("audit")).toMatchObject({ ok: true });
  });

  it("does nothing when the usage guard is off", async () => {
    const { env, storage } = createEnvironment();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const paused = { ...env, GUARD_MODE: "off" };
    const response = await auditor.fetch(new Request("https://auditor.internal/audit", { method: "POST" }), paused);
    expect(response.status).toBe(503);
    expect((await auditor.fetch(new Request("https://auditor.internal/status"), paused)).status).toBe(503);
    const work = [];
    await auditor.scheduled({}, paused, { waitUntil: (promise) => work.push(promise) });
    expect(work).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
  });

  it("keeps state validation inside the Durable Object", async () => {
    const { env, storage } = createEnvironment();
    await expect(persistAudit(env, { ok: true, checkedAt: 123 })).resolves.toBeUndefined();
    expect(storage.values.get("audit")).toEqual({ ok: true, checkedAt: 123 });
    await expect(auditAndPersist({ ...env, AUDIT_STATE: undefined })).resolves.toMatchObject({ ok: false });
  });
});
