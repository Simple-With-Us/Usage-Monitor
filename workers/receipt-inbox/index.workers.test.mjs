import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleFetch, storeAndCommitEvidence } from "./src/index.mjs";

function stub() {
  return env.RECEIPT_INDEX.get(env.RECEIPT_INDEX.idFromName("receipt-inbox-v1"));
}

function metadata(number, receivedAt = new Date().toISOString()) {
  return {
    id: number.toString(16).padStart(64, "0"),
    groupId: null,
    receivedAt,
    senderDomain: "example.com",
    senderAuthentication: "unknown",
    rawSizeBytes: 1,
    attachmentCount: 0,
    supportedAttachmentCount: 0,
    bodyEvidence: true,
    parseState: "parsed",
    quarantineReason: "awaiting_review",
  };
}

async function request(path, method = "GET", body) {
  return stub().fetch(`https://receipt-index.internal${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

describe("receipt inbox Durable Object in workerd", () => {
  beforeEach(async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.put("lifecycle:audit", { ok: true, checkedAt: Date.now() });
    });
  });

  it("serializes concurrent reservations at the 100-message daily ceiling", async () => {
    const results = await Promise.all(Array.from({ length: 101 }, async (_, number) => {
      const response = await request("/admit", "POST", { bytes: number + 1, noForward: true });
      return response.json();
    }));
    expect(results.filter((result) => result.result === "admitted")).toHaveLength(100);
    expect(results.filter((result) => result.result === "quota_exceeded")).toHaveLength(1);
  });

  it("serializes concurrent admissions at the per-sender limit", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, async () => {
      const response = await request("/admit", "POST", { bytes: 1, senderDomain: "spam.example" });
      return response.json();
    }));
    expect(results.filter((result) => result.result === "admitted")).toHaveLength(20);
    expect(results.filter((result) => result.scope === "sender")).toHaveLength(5);
  });

  it("stays ready during a recent cleanup backlog and backs the alarm off", async () => {
    const recent = String(Date.now() - 60_000).padStart(13, "0");
    await runInDurableObject(stub(), async (_instance, state) => {
      const entries = {};
      for (let number = 0; number < 250; number += 1) {
        entries[`pending-expire:${recent}:${number.toString(16).padStart(64, "0")}`] = number.toString(16).padStart(64, "0");
      }
      await state.storage.put(entries);
    });
    const before = Date.now();
    expect((await request("/ready")).status).toBe(200);
    expect((await request("/summary")).status).toBe(200);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect((await state.storage.list({ prefix: "pending-expire:" })).size).toBeGreaterThan(0);
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 25_000);
    });
  });

  it("keeps the backlog alarm backed off after a write request", async () => {
    const recent = String(Date.now() - 60_000).padStart(13, "0");
    await runInDurableObject(stub(), async (_instance, state) => {
      const entries = {};
      for (let number = 0; number < 450; number += 1) {
        entries[`pending-expire:${recent}:${number.toString(16).padStart(64, "0")}`] = number.toString(16).padStart(64, "0");
      }
      await state.storage.put(entries);
    });
    const before = Date.now();
    expect((await (await request("/admit", "POST", { bytes: 1, senderDomain: "vendor.example" })).json()).result).toBe("admitted");
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 25_000);
    });
  });

  it("fails readiness and summary only when the backlog is over a day old", async () => {
    const stale = String(Date.now() - 25 * 60 * 60 * 1000).padStart(13, "0");
    await runInDurableObject(stub(), async (_instance, state) => {
      const entries = {};
      for (let number = 0; number < 450; number += 1) {
        entries[`pending-expire:${stale}:${number.toString(16).padStart(64, "0")}`] = number.toString(16).padStart(64, "0");
      }
      await state.storage.put(entries);
    });
    const ready = await request("/ready");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ reason: "cleanup_backlog" });
    expect((await request("/summary")).status).toBe(503);
  });

  it("heads a missing fixed key on /health against real R2", async () => {
    const response = await handleFetch(new Request("https://receipt-inbox.jays.services/health", {
      headers: { Authorization: `Bearer ${env.RECEIPT_INBOX_READ_TOKEN}` },
    }), env);
    expect(response.status).toBe(200);
  });

  it("lists committed receipts newest first and never lists pending reservations", async () => {
    const baseTime = Date.now();
    const times = [
      new Date(baseTime - 3 * 3600 * 1000).toISOString(),
      new Date(baseTime - 1 * 3600 * 1000).toISOString(),
      new Date(baseTime - 2 * 3600 * 1000).toISOString(),
    ];
    for (let number = 1; number <= 3; number += 1) {
      await request("/reserve", "POST", metadata(number, times[number - 1]));
    }
    await request(`/commit/${metadata(1).id}`, "POST");
    await request(`/commit/${metadata(2).id}`, "POST");
    const summary = await request("/summary").then((response) => response.json());
    expect(summary.items.map((item) => item.id)).toEqual([metadata(2).id, metadata(1).id]);
    expect(summary.needsReviewCount).toBe(2);
  });

  it("expires review metadata, dedupe markers, and group markers with the evidence window", async () => {
    const id = "a".repeat(64);
    const groupId = "b".repeat(64);
    const inboxKey = `inbox:needs_review:0000000000001:${id}`;
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put({
        [inboxKey]: {
          ...metadata(10, "2025-01-01T00:00:00.000Z"),
          id,
          groupId,
          status: "needs_review",
        },
        [`dedupe:${id}`]: { id, status: "committed", key: inboxKey },
        [`group:${groupId}`]: { id, status: "committed" },
        [`expire:0000000000001:${id}`]: id,
        "counter:needs_review": 1,
      });
    });
    const summary = await request("/summary").then((response) => response.json());
    expect(summary.items).toEqual([]);
    expect(summary.needsReviewCount).toBe(0);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get(`dedupe:${id}`)).toBeUndefined();
      expect(await state.storage.get(`group:${groupId}`)).toBeUndefined();
    });
  });

  it("resumes a real Workerd reservation after interruption before and after R2 storage", async () => {
    const item = metadata(20);
    expect(await request("/reserve", "POST", item).then((response) => response.json())).toMatchObject({
      result: "reserved",
      resumed: false,
    });
    const retried = await request("/reserve", "POST", item).then((response) => response.json());
    expect(retried).toMatchObject({ result: "reserved", resumed: true, id: item.id });

    await env.RECEIPTS_BUCKET.put(`evidence/${item.id}.eml`, new TextEncoder().encode("receipt evidence"));
    expect(await env.RECEIPTS_BUCKET.get(`evidence/${item.id}.eml`)).not.toBeNull();
    const afterR2Interruption = await request("/reserve", "POST", item).then((response) => response.json());
    expect(afterR2Interruption).toMatchObject({ result: "reserved", resumed: true, id: item.id });
    await storeAndCommitEvidence(env, item.id, new TextEncoder().encode("receipt evidence"));
    const summary = await request("/summary").then((response) => response.json());
    expect(summary.items.map((entry) => entry.id)).toEqual([item.id]);
    expect(await env.RECEIPTS_BUCKET.get(`evidence/${item.id}.eml`)).not.toBeNull();
  });

  it("releases a reservation in one real transaction, freeing its group marker", async () => {
    const item = { ...metadata(50), groupId: "e".repeat(64) };
    await request("/reserve", "POST", item);
    expect(await request(`/release/${item.id}`, "POST").then((response) => response.json())).toEqual({ result: "released" });
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get(`pending:${item.id}`)).toBeUndefined();
      expect(await state.storage.get(`dedupe:${item.id}`)).toBeUndefined();
      expect(await state.storage.get(`group:${item.groupId}`)).toBeUndefined();
      expect((await state.storage.list({ prefix: "pending-expire:" })).size).toBe(0);
    });
    const second = { ...metadata(51), groupId: item.groupId };
    expect(await request("/reserve", "POST", second).then((response) => response.json())).toMatchObject({ result: "reserved" });
  });

  it("never lets a different wrapper take over a pending attachment-group reservation", async () => {
    const first = { ...metadata(40), groupId: "f".repeat(64) };
    const second = { ...metadata(41), groupId: first.groupId };
    expect(await request("/reserve", "POST", first).then((response) => response.json())).toMatchObject({
      result: "reserved",
      id: first.id,
    });
    expect(await request("/reserve", "POST", second).then((response) => response.json())).toEqual({
      result: "busy",
    });
    expect(await env.RECEIPTS_BUCKET.get(`evidence/${first.id}.eml`)).toBeNull();
    expect(await env.RECEIPTS_BUCKET.get(`evidence/${second.id}.eml`)).toBeNull();
  });

  it("expires interrupted pending reservations through a Durable Object alarm", async () => {
    const id = "c".repeat(64);
    const groupId = "d".repeat(64);
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put({
        [`pending:${id}`]: { ...metadata(30), id, groupId, day: "2026-07-18", status: "pending" },
        [`dedupe:${id}`]: { id, status: "pending" },
        [`group:${groupId}`]: { id, status: "pending" },
        [`pending-expire:0000000000001:${id}`]: id,
        "daily:2026-07-18": { count: 1, bytes: 1 },
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get(`pending:${id}`)).toBeUndefined();
      expect(await state.storage.get(`dedupe:${id}`)).toBeUndefined();
      expect(await state.storage.get(`group:${groupId}`)).toBeUndefined();
    });
  });

  it("fails readiness while more than one cleanup batch is expired and drains it by alarm", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const entries = { "counter:needs_review": 101 };
      for (let number = 0; number < 101; number += 1) {
        const id = number.toString(16).padStart(64, "0");
        const inboxKey = `inbox:needs_review:${String(number).padStart(13, "0")}:${id}`;
        entries[inboxKey] = { ...metadata(number, "2025-01-01T00:00:00.000Z"), status: "needs_review" };
        entries[`dedupe:${id}`] = { id, status: "committed", key: inboxKey };
        entries[`expire:0000000000001:${id}`] = id;
      }
      await state.storage.put(entries);
    });

    expect((await request("/ready")).status).toBe(503);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await request("/ready")).status).toBe(200);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("counter:needs_review")).toBe(0);
      expect((await state.storage.list({ prefix: "expire:" })).size).toBe(0);
    });
  });

  it("refreshes lifecycle state immediately after the 24-hour freshness boundary", async () => {
    const staleCheckedAt = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put("lifecycle:audit", { ok: true, checkedAt: staleCheckedAt });
    });
    const response = await handleFetch(new Request("https://receipt-inbox.jays.services/health", {
      headers: { Authorization: `Bearer ${env.RECEIPT_INBOX_READ_TOKEN}` },
    }), env);
    expect(response.status).toBe(200);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect((await state.storage.get("lifecycle:audit")).checkedAt).toBeGreaterThan(staleCheckedAt);
    });
  });
});
