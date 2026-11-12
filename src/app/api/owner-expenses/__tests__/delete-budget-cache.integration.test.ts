import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let testDir: string;
let parseOwnerExpenseInput: typeof import("@/lib/owner-expense").parseOwnerExpenseInput;
let recordOwnerExpense: typeof import("@/lib/owner-expense").recordOwnerExpense;
let prisma: typeof import("@/lib/prisma").prisma;
let DELETE: typeof import("../route").DELETE;
let createSessionToken: typeof import("@/lib/auth").createSessionToken;
let computeBudgetStatus: typeof import("@/lib/budget-status").computeBudgetStatus;
let __setBudgetStatusCacheOverrideForTests: typeof import("@/lib/budget-status").__setBudgetStatusCacheOverrideForTests;
let __resetBudgetStatusCacheForTests: typeof import("@/lib/budget-status").__resetBudgetStatusCacheForTests;

const NOW = new Date("2026-11-15T12:00:00.000Z");

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-exp-delete-cache-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.SESSION_SECRET = "s".repeat(64);
  process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({
    computeBudgetStatus,
    __setBudgetStatusCacheOverrideForTests,
    __resetBudgetStatusCacheForTests,
  } = await import("@/lib/budget-status"));
  ({ parseOwnerExpenseInput, recordOwnerExpense } = await import("@/lib/owner-expense"));
  __setBudgetStatusCacheOverrideForTests(true);
  ({ DELETE } = await import("../route"));
  ({ createSessionToken } = await import("@/lib/auth"));
}, 60_000);

afterAll(async () => {
  __resetBudgetStatusCacheForTests();
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetBudgetStatusCacheForTests();
  __setBudgetStatusCacheOverrideForTests(true);
  await prisma.externalUsageEvent.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

describe("DELETE /api/owner-expenses budget cache (integration)", () => {
  it("drops cached month-to-date spend after a successful delete (UM-1583)", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "testvendor",
        displayName: "Test Vendor",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", monthlyBudgetUsd: 500 } },
      },
    });

    const recorded = await recordOwnerExpense(
      parseOwnerExpenseInput({
        provider: provider.name,
        amountUsd: 25,
        occurredAt: NOW.toISOString(),
        kind: "usage",
        label: "UM-1583 regression",
      })
    );
    expect(recorded.persisted).toBe(1);

    const warm = await computeBudgetStatus(NOW);
    expect(warm.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(25);

    const token = createSessionToken();
    const response = await DELETE(
      new NextRequest("https://usage.jays.services/api/owner-expenses", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: `dashboard_session=${token}`,
        },
        body: JSON.stringify({ idempotencyKeys: [recorded.idempotencyKey] }),
      })
    );
    expect(response.status).toBe(200);

    const refreshed = await computeBudgetStatus(NOW);
    expect(refreshed.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(0);
  });
});
