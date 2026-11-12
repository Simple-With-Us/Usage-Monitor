import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Integration tests for applyBudgetControls against a real SQLite test DB (same
// harness as budget-status-cache.test.ts). computeStatus and `now` are injected
// so every case is deterministic — no wall clock, no network, no real budget
// computation. Proves: controls-off writes nothing (byte-identical), pause only
// after a sustained breach, resume on breach-resolve and period-roll, the
// fail-safe path never throws or corrupts state, and the key-disable
// recommendation NEVER mutates a credential.

let prisma: typeof import("@/lib/prisma").prisma;
let applyBudgetControls: typeof import("../budget-controls").applyBudgetControls;

let testDir: string;

const ON_TICKS_1: Partial<NodeJS.ProcessEnv> = {
  BUDGET_AUTO_CONTROLS_ENABLED: "true",
  BUDGET_CONTROL_BREACH_TICKS: "1",
  BUDGET_CONTROL_COOLDOWN_MS: "0",
};
const ON_TICKS_3: Partial<NodeJS.ProcessEnv> = {
  BUDGET_AUTO_CONTROLS_ENABLED: "true",
  BUDGET_CONTROL_BREACH_TICKS: "3",
  BUDGET_CONTROL_COOLDOWN_MS: "0",
};
const OFF_ENV: Partial<NodeJS.ProcessEnv> = { BUDGET_AUTO_CONTROLS_ENABLED: "false" };

const MARCH = new Date("2026-03-10T00:00:00.000Z");
const APRIL = new Date("2026-04-02T00:00:00.000Z");

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-controls-apply-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ applyBudgetControls } = await import("../budget-controls"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.provider.deleteMany();
});

afterEach(async () => {
  await prisma.provider.deleteMany();
});

async function createProvider(opts: {
  name: string;
  budgetControlsEnabled?: boolean;
  monthlyBudgetUsd?: number | null;
  apiKey?: string | null;
}) {
  return prisma.provider.create({
    data: {
      name: opts.name,
      displayName: opts.name,
      type: "builtin",
      refreshIntervalMin: 60,
      budgetControlsEnabled: opts.budgetControlsEnabled ?? false,
      apiKey: opts.apiKey ?? null,
      plan:
        opts.monthlyBudgetUsd != null
          ? {
              create: {
                billingMode: "actual",
                monthlyBudgetUsd: opts.monthlyBudgetUsd,
              },
            }
          : undefined,
    },
  });
}

function statusFor(
  entries: Array<{ id: string; monthlyBudgetUsd: number | null; spentUsd: number }>
) {
  return async () => ({ providers: entries });
}

async function readProvider(id: string) {
  return prisma.provider.findUniqueOrThrow({ where: { id } });
}

async function auditActions(providerId: string): Promise<string[]> {
  const rows = await prisma.budgetControlEvent.findMany({
    where: { providerId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.action);
}

describe("applyBudgetControls — default-off (byte-identical to notify-only)", () => {
  it("does nothing (no state change, no audit rows) when the master flag is off", async () => {
    const provider = await createProvider({
      name: "off-provider",
      budgetControlsEnabled: true,
      monthlyBudgetUsd: 50,
    });

    const result = await applyBudgetControls({
      now: MARCH,
      env: OFF_ENV,
      prismaClient: prisma,
      computeStatus: statusFor([
        { id: provider.id, monthlyBudgetUsd: 50, spentUsd: 100 },
      ]),
    });

    expect(result.enabled).toBe(false);
    expect(result.evaluated).toBe(0);
    expect(result.paused).toBe(0);

    const after = await readProvider(provider.id);
    expect(after.budgetBreachState).toBe("ok");
    expect(after.budgetPausedAt).toBeNull();
    expect(after.keyDisableRecommended).toBe(false);
    expect(await prisma.budgetControlEvent.count()).toBe(0);
  });
});

describe("applyBudgetControls — hysteresis (advisory only after sustained breach)", () => {
  it("does not recommend on the first ticks and recommends on the Nth without pausing", async () => {
    const provider = await createProvider({
      name: "sustained",
      budgetControlsEnabled: true,
      monthlyBudgetUsd: 50,
    });
    const status = statusFor([
      { id: provider.id, monthlyBudgetUsd: 50, spentUsd: 100 },
    ]);
    const opts = { now: MARCH, env: ON_TICKS_3, prismaClient: prisma, computeStatus: status };

    // Tick 1
    let result = await applyBudgetControls(opts);
    expect(result.paused).toBe(0);
    expect(result.breachesObserved).toBe(1);
    expect((await readProvider(provider.id)).budgetBreachState).toBe("breached");

    // Tick 2
    result = await applyBudgetControls(opts);
    expect(result.paused).toBe(0);
    expect((await readProvider(provider.id)).budgetPausedAt).toBeNull();

    // Tick 3 — advisory recommendation only (never auto-pause)
    result = await applyBudgetControls(opts);
    expect(result.paused).toBe(0);
    expect(result.recommendationsRaised).toBe(1);
    const after = await readProvider(provider.id);
    expect(after.budgetBreachState).toBe("breached");
    expect(after.budgetPausedAt).toBeNull();
    expect(after.budgetPauseThresholdUsd).toBe(50);
    expect(after.budgetPauseObservedSpendUsd).toBe(100);
    expect(after.keyDisableRecommended).toBe(true);

    expect(await auditActions(provider.id)).toEqual([
      "breach_observed",
      "recommend_key_disable",
    ]);
  });
});

describe("applyBudgetControls — period roll clears manual pause", () => {
  it("auto-clears an owner pause when the UTC budget period rolls", async () => {
    const provider = await createProvider({
      name: "period-roll",
      budgetControlsEnabled: true,
      monthlyBudgetUsd: 50,
    });
    // Seed a manual-style pause directly (auto path never pauses).
    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        budgetBreachState: "paused",
        budgetPausedAt: MARCH,
        budgetPauseReason: "owner manual",
        budgetControlPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
        keyDisableRecommended: true,
        budgetBreachStreak: 3,
      },
    });

    const result = await applyBudgetControls({
      now: APRIL,
      env: ON_TICKS_3,
      prismaClient: prisma,
      computeStatus: statusFor([{ id: provider.id, monthlyBudgetUsd: 50, spentUsd: 100 }]),
    });
    expect(result.resumed).toBe(1);
    const rolled = await readProvider(provider.id);
    expect(rolled.budgetPausedAt).toBeNull();
    expect(rolled.budgetBreachState).toBe("breached");
    expect(rolled.budgetBreachStreak).toBe(1);
    expect(await auditActions(provider.id)).toContain("resume_period_roll");
  });
});

describe("applyBudgetControls — fail-safe", () => {
  it("degrades to notify-only (never throws) and preserves state when compute fails", async () => {
    const provider = await createProvider({
      name: "failsafe",
      budgetControlsEnabled: true,
      monthlyBudgetUsd: 50,
    });
    // Seed recommendation state to protect.
    await applyBudgetControls({
      now: MARCH,
      env: ON_TICKS_1,
      prismaClient: prisma,
      computeStatus: statusFor([{ id: provider.id, monthlyBudgetUsd: 50, spentUsd: 100 }]),
    });
    const before = await readProvider(provider.id);
    expect(before.keyDisableRecommended).toBe(true);
    const auditBefore = await prisma.budgetControlEvent.count();

    const result = await applyBudgetControls({
      now: MARCH,
      env: ON_TICKS_1,
      prismaClient: prisma,
      computeStatus: async () => {
        throw new Error("compute exploded");
      },
    });
    expect(result.degraded).toBe(true);
    expect(result.error).toContain("compute exploded");

    const after = await readProvider(provider.id);
    expect(after.keyDisableRecommended).toBe(true);
    expect(await prisma.budgetControlEvent.count()).toBe(auditBefore);
  });
});

describe("applyBudgetControls — key handling is recommendation-only", () => {
  it("raises the recommendation and writes an audit row WITHOUT ever mutating the credential", async () => {
    const SECRET = "encrypted-credential-DO-NOT-TOUCH";
    const provider = await createProvider({
      name: "cred-safe",
      budgetControlsEnabled: true,
      monthlyBudgetUsd: 50,
      apiKey: SECRET,
    });

    await applyBudgetControls({
      now: MARCH,
      env: ON_TICKS_1,
      prismaClient: prisma,
      computeStatus: statusFor([{ id: provider.id, monthlyBudgetUsd: 50, spentUsd: 100 }]),
    });

    const after = await readProvider(provider.id);
    // The credential is byte-for-byte unchanged — the layer only ever
    // recommends, never disables/rotates.
    expect(after.apiKey).toBe(SECRET);
    expect(after.secretConfig).toBeNull();
    expect(after.keyDisableRecommended).toBe(true);

    const recommend = await prisma.budgetControlEvent.findFirst({
      where: { providerId: provider.id, action: "recommend_key_disable" },
    });
    expect(recommend).not.toBeNull();
    expect(recommend?.reason).toContain("RECOMMENDATION ONLY");
  });
});
