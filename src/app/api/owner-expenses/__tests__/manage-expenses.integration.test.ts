import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

/**
 * UM-1659 end-to-end management lifecycle against a real SQLite test DB:
 * post → list/filter/totals → edit (incl. rekey) → delete → replay stays
 * deleted.  This is the behavior the Nov 2026 overhaul exists for: before
 * it, a posted owner expense could not be listed, edited, or deleted
 * anywhere, and a delete done by hand in the database could be undone by
 * the next receipt-intake replay.
 */

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let parseOwnerExpenseInput: typeof import("@/lib/owner-expense").parseOwnerExpenseInput;
let recordOwnerExpense: typeof import("@/lib/owner-expense").recordOwnerExpense;
let GET: typeof import("../route").GET;
let PATCH: typeof import("../route").PATCH;
let DELETE: typeof import("../route").DELETE;
let AUDIT_GET: typeof import("../audit/route").GET;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;

const BASE = "https://usage.jays.services/api/owner-expenses";

function sessionRequest(
  url: string,
  method: string,
  body?: unknown
): NextRequest {
  const token = createSessionToken();
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `dashboard_session=${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function postExpense(body: Record<string, unknown>) {
  return recordOwnerExpense(parseOwnerExpenseInput(body));
}

const TECH_EXPENSE = {
  provider: "Unusual Whales",
  amountUsd: 50,
  occurredAt: "2026-07-30T12:00:00.000Z",
  kind: "one_time",
  label: "Unusual Whales trial",
  notes: "Category: Tech",
};

const OTHER_EXPENSE = {
  provider: "GCX.raise",
  amountUsd: 192.6,
  occurredAt: "2026-09-08T12:00:00.000Z",
  kind: "one_time",
  label: "Princess Cruises gift cards",
  notes: "Category: Other",
};

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-exp-manage-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.SESSION_SECRET = "s".repeat(64);
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ parseOwnerExpenseInput, recordOwnerExpense } = await import("@/lib/owner-expense"));
  ({ GET, PATCH, DELETE } = await import("../route"));
  ({ GET: AUDIT_GET } = await import("../audit/route"));
  ({ createSessionToken } = await import("@/lib/auth"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.ownerExpenseAudit.deleteMany();
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.quarantinedOwnerExpense.deleteMany();
});

describe("UM-1659 posted-expense management (integration)", () => {
  it("post → delete → replay stays deleted, with tombstone + audit", async () => {
    const recorded = await postExpense(TECH_EXPENSE);
    expect(recorded.persisted).toBe(1);

    const response = await DELETE(
      sessionRequest(BASE, "DELETE", {
        idempotencyKeys: [recorded.idempotencyKey],
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ requested: 1, deleted: 1, tombstoned: 1, notFound: [] });

    // Row gone, tombstone present, audit snapshot written.
    expect(
      await prisma.externalUsageEvent.findUnique({
        where: { idempotencyKey: recorded.idempotencyKey },
      })
    ).toBeNull();
    expect(
      await prisma.externalUsageEventTombstone.findUnique({
        where: { idempotencyKey: recorded.idempotencyKey },
      })
    ).not.toBeNull();
    const audit = await prisma.ownerExpenseAudit.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("delete");
    expect((audit[0].before as { vendor: string }).vendor).toBe("Unusual Whales");

    // The exact replay the receipts intake would make records NOTHING.
    const replay = await postExpense(TECH_EXPENSE);
    expect(replay.persisted).toBe(0);
    expect(replay.tombstoned).toBe(true);
    expect(
      await prisma.externalUsageEvent.count({
        where: { sourceApp: "owner-recorded-expense" },
      })
    ).toBe(0);
  });

  it("bulk-deletes several rows in one call", async () => {
    const a = await postExpense(TECH_EXPENSE);
    const b = await postExpense(OTHER_EXPENSE);
    const response = await DELETE(
      sessionRequest(BASE, "DELETE", {
        idempotencyKeys: [a.idempotencyKey, b.idempotencyKey],
      })
    );
    const body = await response.json();
    expect(body).toMatchObject({ requested: 2, deleted: 2, tombstoned: 2, notFound: [] });
    expect(
      await prisma.externalUsageEvent.count({
        where: { sourceApp: "owner-recorded-expense" },
      })
    ).toBe(0);
    expect(await prisma.ownerExpenseAudit.count()).toBe(2);
  });

  it("edits notes (the Unusual Whales Cash App case) without rekeying", async () => {
    const recorded = await postExpense(TECH_EXPENSE);
    const response = await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: recorded.idempotencyKey,
        notes: "Category: Tech. Paid by Cash App card.",
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rekeyed).toBe(false);
    expect(body.expense.notes).toContain("Cash App card");
    expect(body.expense.category).toBe("Tech");

    const audit = await prisma.ownerExpenseAudit.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("edit");
    expect((audit[0].after as { notes: string }).notes).toContain("Cash App");
  });

  it("edit that changes the amount rekeys, tombstones the old key, and blocks the pre-edit replay", async () => {
    const recorded = await postExpense(TECH_EXPENSE);
    const response = await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: recorded.idempotencyKey,
        amountUsd: 45,
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rekeyed).toBe(true);
    const newKey = body.expense.idempotencyKey as string;
    expect(newKey).not.toBe(recorded.idempotencyKey);

    // Replaying the ORIGINAL receipt cannot resurrect the old $50 row.
    const replay = await postExpense(TECH_EXPENSE);
    expect(replay.persisted).toBe(0);
    expect(replay.tombstoned).toBe(true);
    const rows = await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "owner-recorded-expense" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe(45);
    expect(rows[0].idempotencyKey).toBe(newKey);

    const audit = await prisma.ownerExpenseAudit.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0].resultingKey).toBe(newKey);
  });

  it("rejects an edit that collides with another posted expense (409)", async () => {
    await postExpense(TECH_EXPENSE);
    const other = await postExpense(OTHER_EXPENSE);
    const response = await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: other.idempotencyKey,
        provider: "Unusual Whales",
        amountUsd: 50,
        occurredAt: TECH_EXPENSE.occurredAt,
        label: TECH_EXPENSE.label,
      })
    );
    expect(response.status).toBe(409);
  });

  it("GET filters by category / search / provider and reports Tech vs Other totals", async () => {
    await postExpense(TECH_EXPENSE);
    await postExpense(OTHER_EXPENSE);

    const all = await GET(sessionRequest(`${BASE}?totals=1`, "GET"));
    const allBody = await all.json();
    expect(allBody.totals).toMatchObject({
      count: 2,
      totalUsd: 242.6,
      byCategory: { Tech: 50, Other: 192.6, uncategorized: 0 },
    });

    const techOnly = await GET(sessionRequest(`${BASE}?category=tech&totals=1`, "GET"));
    const techBody = await techOnly.json();
    expect(techBody.expenses).toHaveLength(1);
    expect(techBody.expenses[0].vendor).toBe("Unusual Whales");
    expect(techBody.totals.totalUsd).toBe(50);

    const searched = await GET(sessionRequest(`${BASE}?q=princess`, "GET"));
    const searchedBody = await searched.json();
    expect(searchedBody.expenses).toHaveLength(1);
    expect(searchedBody.expenses[0].vendor).toBe("GCX.raise");

    const byProvider = await GET(sessionRequest(`${BASE}?provider=unusual`, "GET"));
    const providerBody = await byProvider.json();
    expect(providerBody.expenses).toHaveLength(1);

    // After an edit changes an amount, totals move with it.
    const recorded = await prisma.externalUsageEvent.findFirst({
      where: { provider: "Unusual Whales" },
    });
    await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: recorded!.idempotencyKey,
        amountUsd: 45,
      })
    );
    const after = await GET(sessionRequest(`${BASE}?totals=1`, "GET"));
    const afterBody = await after.json();
    expect(afterBody.totals).toMatchObject({
      count: 2,
      totalUsd: 237.6,
      byCategory: { Tech: 45, Other: 192.6, uncategorized: 0 },
    });
  });

  it("undoing a rekeying edit restores the original key and clears its tombstone", async () => {
    const recorded = await postExpense(TECH_EXPENSE);
    const edited = await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: recorded.idempotencyKey,
        amountUsd: 45,
      })
    );
    expect(edited.status).toBe(200);
    const editedBody = await edited.json();
    const keyB = editedBody.expense.idempotencyKey as string;
    expect(
      await prisma.externalUsageEventTombstone.findUnique({
        where: { idempotencyKey: recorded.idempotencyKey },
      })
    ).not.toBeNull();

    // Edit back to the original values: the tombstone on the original key
    // came from this row's own rekey, so the undo is allowed (not a 409).
    const undone = await PATCH(
      sessionRequest(BASE, "PATCH", { idempotencyKey: keyB, amountUsd: 50 })
    );
    expect(undone.status).toBe(200);
    const undoneBody = await undone.json();
    expect(undoneBody.expense.idempotencyKey).toBe(recorded.idempotencyKey);
    // The original key is live again, so its tombstone is gone...
    expect(
      await prisma.externalUsageEventTombstone.findUnique({
        where: { idempotencyKey: recorded.idempotencyKey },
      })
    ).toBeNull();
    // ...and a replay of the original receipt is a plain idempotent no-op.
    const replay = await postExpense(TECH_EXPENSE);
    expect(replay.persisted).toBe(0);
    expect(replay.tombstoned).toBeFalsy();
    expect(
      await prisma.externalUsageEvent.count({
        where: { sourceApp: "owner-recorded-expense" },
      })
    ).toBe(1);
  });

  it("rejects an edit into a genuinely deleted expense's values (409)", async () => {
    const deleted = await postExpense(TECH_EXPENSE);
    await DELETE(
      sessionRequest(BASE, "DELETE", {
        idempotencyKeys: [deleted.idempotencyKey],
      })
    );
    const other = await postExpense(OTHER_EXPENSE);
    const response = await PATCH(
      sessionRequest(BASE, "PATCH", {
        idempotencyKey: other.idempotencyKey,
        provider: "Unusual Whales",
        amountUsd: 50,
        occurredAt: TECH_EXPENSE.occurredAt,
        label: TECH_EXPENSE.label,
      })
    );
    expect(response.status).toBe(409);
  });

  it("filtered GET with a stale cursor returns an empty final page, not page 1", async () => {
    await postExpense(TECH_EXPENSE);
    await postExpense({
      ...OTHER_EXPENSE,
      notes: "Category: Tech",
      label: "Second tech expense",
    });
    const page1 = await GET(
      sessionRequest(`${BASE}?totals=1&category=tech&limit=1`, "GET")
    );
    const page1Body = await page1.json();
    expect(page1Body.expenses).toHaveLength(1);
    expect(page1Body.hasMore).toBe(true);
    const cursor = page1Body.nextCursor as string;

    // The cursor row is deleted before the client asks for page 2.
    await DELETE(sessionRequest(BASE, "DELETE", { idempotencyKeys: [cursor] }));
    const page2 = await GET(
      sessionRequest(
        `${BASE}?totals=1&category=tech&limit=1&cursor=${encodeURIComponent(cursor)}`,
        "GET"
      )
    );
    const page2Body = await page2.json();
    expect(page2Body.expenses).toEqual([]);
    expect(page2Body.hasMore).toBe(false);
    expect(page2Body.nextCursor).toBeNull();
  });

  it("audit endpoint returns the history and requires a session", async () => {
    const recorded = await postExpense(TECH_EXPENSE);
    await DELETE(
      sessionRequest(BASE, "DELETE", {
        idempotencyKeys: [recorded.idempotencyKey],
      })
    );

    const unauthenticated = await AUDIT_GET(
      new NextRequest(`${BASE}/audit`, { method: "GET" })
    );
    expect(unauthenticated.status).toBe(401);

    const response = await AUDIT_GET(sessionRequest(`${BASE}/audit`, "GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      action: "delete",
      idempotencyKey: recorded.idempotencyKey,
    });
    expect(body.entries[0].before.vendor).toBe("Unusual Whales");
  });
});
