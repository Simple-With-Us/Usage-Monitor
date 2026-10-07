import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prismaModule from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetBudgetLedger } from "../ledger";
import { input, NOW, POLICY } from "./fixture";

const { PrismaClient } = prismaModule;
let dir: string;
let clients: InstanceType<typeof PrismaClient>[];
let ledger: FleetBudgetLedger;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "um-fleet-budget-test-"));
  const url = `file:${join(dir, "synthetic.db")}?connection_limit=1`;
  // This is an isolated synthetic database, never an operator DATABASE_URL.
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe",
  });
  clients = Array.from({ length: 19 }, () => new PrismaClient({ datasources: { db: { url } } }));
  // WAL matches the production SQLite setup; short busy waits let independent
  // engines yield instead of blocking the test process for five seconds each.
  await clients[0].$queryRaw`PRAGMA journal_mode=WAL`;
  await Promise.all(clients.map((client) => client.$queryRaw`PRAGMA busy_timeout=50`));
  ledger = new FleetBudgetLedger(clients[0]);
});
beforeEach(async () => {
  await clients[0].fleetBudgetReservation.deleteMany();
  await clients[0].fleetBudgetDay.deleteMany();
  await clients[0].fleetBudgetGuard.deleteMany();
});
afterAll(async () => {
  await Promise.all(clients?.map((c) => c.$disconnect()) ?? []);
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const usage = { inputTokens: 50_000, cachedInputTokens: 10_000, outputTokens: 10_000 };

describe("durable fleet budget admission", () => {
  it("shares liability across 19 concurrent callers and independent database clients", async () => {
    // Fill the soft allowance, then contend for the shared fallback headroom.
    const policy = POLICY;
    await ledger.reserve("seed", input("seed", { maxInputTokens: 400_000 }), policy, NOW);
    const outcomes = await Promise.allSettled(Array.from({ length: 19 }, (_, i) =>
      new FleetBudgetLedger(clients[i % clients.length]).reserve(`repo-${i}`, input(`request-${i}`, { route: "fallback" }), policy, NOW)));
    const results = outcomes.map((r) => { if (r.status === "rejected") throw r.reason; return r.value; });
    expect(results.filter((r) => r.provider === "deepseek")).toHaveLength(5);
    expect(results.filter((r) => r.provider === "minimax")).toHaveLength(14);
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("1500000");
    expect(await clients[0].fleetBudgetReservation.count()).toBe(20);
  });
  it("deduplicates 19 concurrent identical retries without multiplying liability", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 19 }, (_, i) =>
      new FleetBudgetLedger(clients[i % clients.length]).reserve("one-client", input("one-request"), POLICY, NOW)));
    const results = outcomes.map((r) => { if (r.status === "rejected") throw r.reason; return r.value; });
    expect(new Set(results.map((r) => r.reservationId)).size).toBe(1);
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("200000");
    expect(await clients[0].fleetBudgetReservation.count()).toBe(1);
    await expect(ledger.reserve("one-client", input("one-request", { maxInputTokens: 1 }), POLICY, NOW)).rejects.toMatchObject({ code: "conflict" });
  });
  it("switches exactly at the soft threshold including outstanding reservations", async () => {
    const request = (id: string) => input(id, { maxInputTokens: 400_000 }); // 0.50
    expect((await ledger.reserve("a", request("one"), POLICY, NOW)).provider).toBe("deepseek");
    expect((await ledger.reserve("b", request("two"), POLICY, NOW)).provider).toBe("minimax");
    expect((await ledger.reserve("b", request("three"), POLICY, NOW)).reason).toBe("soft_limit_reached");
    expect((await ledger.reserve("b", request("fallback"), POLICY, NOW)).reservedPolicyMicros).toBe("0");
    expect((await ledger.reserve("b", { ...request("explicit-fallback"), route: "fallback" }, POLICY, NOW)).provider).toBe("deepseek");
  });
  it("admits exact hard-cap equality and never the next micro-unit", async () => {
    const policy = POLICY;
    const one = input("one", { maxInputTokens: 650_000 }); // 0.75
    await ledger.reserve("a", one, policy, NOW);
    await ledger.reserve("b", { ...one, requestId: "two", route: "fallback" }, policy, NOW);
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("1500000");
    expect((await ledger.reserve("c", input("three", { route: "fallback" }), policy, NOW)).provider).toBe("minimax");
  });
  it("uses a one-shot dispatch transition, so retries cannot authorize another call", async () => {
    await ledger.reserve("a", input("one"), POLICY, NOW);
    const results = await Promise.allSettled(Array.from({ length: 19 }, (_, i) =>
      new FleetBudgetLedger(clients[i % clients.length]).dispatch("a", "one", NOW)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(18);
    await expect(ledger.cancel("a", "one", NOW)).rejects.toMatchObject({ code: "not_dispatchable" });
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("200000");
  });
  it("retains liability on timeout, missing usage, expiry and restart; accepts late settlement", async () => {
    await ledger.reserve("a", input("one"), POLICY, NOW);
    await ledger.dispatch("a", "one", NOW);
    await ledger.reconcile("a", "one", null, NOW);
    const restarted = new FleetBudgetLedger(clients[1]);
    expect((await restarted.status(NOW)).reservedPolicyMicros).toBe("200000");
    const late = new Date("2026-10-07T06:00:00Z");
    await expect(restarted.dispatch("a", "one", late)).rejects.toMatchObject({ code: "not_dispatchable" });
    const settled = await restarted.reconcile("a", "one", usage, late);
    expect(settled.day).toBe("2026-10-06");
    expect(settled.estimatedCostMicros).toBe("61000");
    expect((await restarted.status(NOW)).reservedPolicyMicros).toBe("0");
    expect((await restarted.status(NOW)).settledPolicyMicros).toBe("61000");
    expect((await restarted.status(late)).settledPolicyMicros).toBe("0");
  });
  it("settlement retries are idempotent and conflicting outcomes are refused", async () => {
    await ledger.reserve("a", input("one"), POLICY, NOW);
    await ledger.dispatch("a", "one", NOW);
    const first = await ledger.reconcile("a", "one", usage, NOW);
    expect(await ledger.reconcile("a", "one", usage, NOW)).toEqual(first);
    await expect(ledger.reconcile("a", "one", { ...usage, outputTokens: 20_000 }, NOW)).rejects.toMatchObject({ code: "conflict" });
    expect((await ledger.status(NOW)).settledPolicyMicros).toBe("61000");
  });
  it("only cancels provably undispatched calls and leaves durable request tombstones", async () => {
    await ledger.reserve("a", input("one"), POLICY, NOW);
    await ledger.cancel("a", "one", NOW);
    expect((await ledger.cancel("a", "one", NOW)).status).toBe("cancelled");
    expect((await ledger.reserve("a", input("one"), POLICY, NOW)).status).toBe("cancelled");
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("0");
  });
  it("does not allow expired or midnight-crossing dispatch and does not silently reclaim", async () => {
    const before = new Date("2026-10-07T04:59:50Z");
    const reserved = await ledger.reserve("a", input("midnight"), POLICY, before);
    expect(reserved.dispatchBefore).toBe("2026-10-07T05:00:00.000Z");
    await expect(ledger.dispatch("a", "midnight", new Date("2026-10-07T05:00:00Z"))).rejects.toMatchObject({ code: "not_dispatchable" });
    expect((await ledger.status(before)).reservedPolicyMicros).toBe("200000");
    expect((await ledger.reserve("a", input("midnight"), POLICY, new Date("2026-10-07T05:00:00Z"))).day).toBe("2026-10-06");
    await ledger.reserve("b", input("expires"), POLICY, NOW);
    await expect(ledger.dispatch("b", "expires", new Date(NOW.getTime() + 60_000))).rejects.toMatchObject({ code: "not_dispatchable" });
  });
  it("keeps MiniMax estimates and provider-reported costs despite zero policy weight", async () => {
    await ledger.reserve("a", input("minimax", { route: "fallback" }), POLICY, NOW);
    await ledger.dispatch("a", "minimax", NOW);
    const result = await ledger.reconcile("a", "minimax", { ...usage, providerReportedCostMicros: 40_000 }, NOW);
    expect(result.provider).toBe("minimax");
    expect(result.estimatedCostMicros).toBe("30500");
    expect(result.providerReportedCostMicros).toBe("40000");
    expect(result.providerReportedCostVerified).toBe(false);
    expect((await ledger.status(NOW)).settledPolicyMicros).toBe("0");
    expect((await ledger.status(NOW)).estimatedMiniMaxMicros).toBe("30500");
    expect((await ledger.status(NOW)).providerCosts.find((row) => row.provider === "minimax")).toMatchObject({
      policyWeight: 0, settledCalls: 1, outstandingCalls: 0, estimatedCalls: 1,
      knownEstimatedCostMicros: "30500", providerReportedCalls: 1,
      knownProviderReportedCostMicros: "40000", providerReportedCostVerified: false,
    });
  });
  it("shows unresolved MiniMax exposure instead of implying known zero cost", async () => {
    await ledger.reserve("a", input("mm-pending", { route: "fallback" }), POLICY, NOW);
    await ledger.dispatch("a", "mm-pending", NOW);
    await ledger.reconcile("a", "mm-pending", null, NOW);
    const status = await ledger.status(NOW);
    expect(status.reservedPolicyMicros).toBe("0");
    expect(status.providerCosts.find((row) => row.provider === "minimax")).toEqual({
      provider: "minimax", policyWeight: 0, settledCalls: 0, outstandingCalls: 1,
      outstandingMaximumCostMicros: "100000", estimatedCalls: 0, knownEstimatedCostMicros: null,
      providerReportedCalls: 0, knownProviderReportedCostMicros: null, providerReportedCostVerified: false,
    });
  });
  it("persists an overrun and blocks later DS dispatch and admission", async () => {
    await ledger.reserve("a", input("overrun"), POLICY, NOW);
    await ledger.reserve("a", input("pending"), POLICY, NOW);
    await ledger.dispatch("a", "overrun", NOW);
    await ledger.reconcile("a", "overrun", { ...usage, providerReportedCostMicros: 300_000 }, NOW);
    expect((await ledger.status(NOW)).blocked).toBe(true);
    expect((await ledger.status(NOW)).settledPolicyMicros).toBe("300000");
    await expect(ledger.dispatch("a", "pending", NOW)).rejects.toMatchObject({ code: "not_dispatchable" });
    expect((await ledger.reserve("b", input("new"), POLICY, NOW)).provider).toBe("minimax");
    const nextDay = new Date("2026-10-07T08:00:00Z");
    expect((await ledger.reserve("c", input("tomorrow"), POLICY, nextDay)).reason).toBe("ledger_blocked");
    expect((await ledger.status(nextDay)).blocked).toBe(true);
  });
  it("rejects untrusted malformed values, unknown clients, and policy swaps", async () => {
    await expect(ledger.reserve("a", input("bad", { maxInputTokens: -1 }), POLICY, NOW)).rejects.toMatchObject({ code: "invalid_request" });
    await ledger.reserve("a", input("one"), POLICY, NOW);
    await expect(ledger.dispatch("other", "one", NOW)).rejects.toMatchObject({ code: "not_found" });
    await expect(ledger.reserve("a", input("two"), { ...POLICY, hardLimitMicros: 1_000_000 }, NOW)).rejects.toMatchObject({ code: "policy_changed" });
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("200000");
  });
  it("fails closed for stale prices and falls back to freshly priced MiniMax", async () => {
    const stale = { ...POLICY, deepseek: { ...POLICY.deepseek, verifiedAt: "2026-10-01T00:00:00Z", validUntil: "2026-10-02T00:00:00Z" } };
    expect((await ledger.reserve("a", input("one"), stale, NOW)).reason).toBe("deepseek_pricing_unavailable");
    await expect(ledger.reserve("a", input("bad"), POLICY, new Date("2026-10-11T00:00:00Z"))).rejects.toMatchObject({ code: "pricing_unavailable" });
  });
  it("rechecks the clock after lock wait and refuses a reservation in a rolled-over day", async () => {
    const before = new Date("2026-10-07T04:59:59.000Z");
    const after = new Date("2026-10-07T05:00:00.000Z");
    let reads = 0;
    await expect(ledger.reserve("a", input("rollover-lock"), POLICY, () => ++reads === 1 ? before : after))
      .rejects.toMatchObject({ code: "not_dispatchable" });
    expect(reads).toBe(2);
    expect(await clients[0].fleetBudgetReservation.count()).toBe(0);
  });
  it("rechecks dispatch time inside the transaction and after commit, retaining ambiguous liability", async () => {
    await ledger.reserve("a", input("late-lock"), POLICY, NOW);
    await expect(ledger.dispatch("a", "late-lock", () => new Date(NOW.getTime() + 60_000)))
      .rejects.toMatchObject({ code: "not_dispatchable" });
    await ledger.reserve("a", input("late-commit"), POLICY, NOW);
    let reads = 0;
    await expect(ledger.dispatch("a", "late-commit", () => ++reads === 1 ? NOW : new Date(NOW.getTime() + 60_000)))
      .rejects.toMatchObject({ code: "not_dispatchable" });
    expect((await ledger.reserve("a", input("late-commit"), POLICY, NOW)).status).toBe("dispatched");
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("400000");
    await expect(ledger.dispatch("a", "late-commit", NOW)).rejects.toMatchObject({ code: "not_dispatchable" });
  });
  it("bounds contention retries with one monotonic total deadline", async () => {
    const transaction = vi.spyOn(clients[0], "$transaction").mockRejectedValue({ code: "P1008", message: "synthetic timeout" });
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(8_000).mockReturnValue(16_000);
    try {
      await expect(ledger.reserve("a", input("busy"), POLICY, NOW)).rejects.toMatchObject({ code: "ledger_unavailable" });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0][1]).toEqual({ maxWait: 1_000, timeout: 4_000 });
    } finally { clock.mockRestore(); transaction.mockRestore(); }
  });
  it("rejects corrupted stored pricing without releasing liability", async () => {
    const row = await ledger.reserve("a", input("bad-price"), POLICY, NOW);
    await ledger.dispatch("a", "bad-price", NOW);
    await clients[0].fleetBudgetReservation.update({ where: { id: row.reservationId }, data: { pricingJson: "{}" } });
    await expect(ledger.reconcile("a", "bad-price", usage, NOW)).rejects.toMatchObject({ code: "ledger_unavailable" });
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("200000");
    expect((await clients[0].fleetBudgetReservation.findUniqueOrThrow({ where: { id: row.reservationId } })).status).toBe("dispatched");
  });
  it("rolls back all counters when the durable reservation insert fails", async () => {
    await clients[0].$executeRaw`CREATE TRIGGER reject_budget_test BEFORE INSERT ON "FleetBudgetReservation" BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`;
    try { await expect(ledger.reserve("a", input("one"), POLICY, NOW)).rejects.toThrow(); }
    finally { await clients[0].$executeRaw`DROP TRIGGER reject_budget_test`; }
    expect((await ledger.status(NOW)).reservedPolicyMicros).toBe("0");
    expect(await clients[0].fleetBudgetReservation.count()).toBe(0);
  });
});
