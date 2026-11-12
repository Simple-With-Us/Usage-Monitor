import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import * as helpers from "@/lib/adapters/helpers";

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let verifyOpenRouterGenerations: typeof import("../openrouter-generation-verification").verifyOpenRouterGenerations;
let reconcileProviderUsage: typeof import("../provider-usage-reconciliation").reconcileProviderUsage;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPENROUTER_MANAGEMENT_KEY = "test-key";
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-reconciliation-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ verifyOpenRouterGenerations } = await import(
    "../openrouter-generation-verification"
  ));
  ({ reconcileProviderUsage } = await import(
    "../provider-usage-reconciliation"
  ));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
});

beforeEach(async () => {
  await prisma.providerUsageReconciliation.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
  vi.restoreAllMocks();
});

/**
 * Producers (CT/ST) put the OpenRouter GENERATION ID in `providerRequestId`
 * and the API-KEY REFERENCE in `keyRef`. Fixtures here must mirror that exact
 * contract — a fixture that stuffs the generation id into `keyRef` would make
 * the worker look functional while matching zero real rows in production.
 */
async function seedEvent(overrides: {
  providerRequestId?: string | null;
  costUsd?: number | null;
  verificationStatus?: string | null;
  verifiedSource?: string | null;
  occurredAt?: Date;
}) {
  return prisma.externalUsageEvent.create({
    data: {
      sourceApp: "socratic-trade",
      provider: "openrouter",
      metricType: "usage",
      keyRef: "OPENROUTER_API_KEY",
      costUsd: overrides.costUsd ?? 0.001,
      occurredAt: overrides.occurredAt ?? new Date(),
      providerRequestId: overrides.providerRequestId ?? "gen-abc",
      verificationStatus: overrides.verificationStatus ?? null,
      verifiedSource: overrides.verifiedSource ?? null,
    },
  });
}

function mockGeneration(byId: Record<string, { status: number; cost?: number }>) {
  vi.spyOn(helpers, "fetchJson").mockImplementation(async (url: string) => {
    const match = Object.keys(byId).find((id) => url.includes(id));
    const entry = match ? byId[match] : { status: 404 };
    if (entry.status !== 200) {
      return { ok: false, status: entry.status, data: null, headers: new Headers() };
    }
    return {
      ok: true,
      status: 200,
      data: { data: { id: match, total_cost: entry.cost } },
      headers: new Headers(),
    };
  });
}

describe("verifyOpenRouterGenerations", () => {
  it("verifies by providerRequestId — the field producers actually populate", async () => {
    const event = await seedEvent({
      providerRequestId: "gen-real-1",
      costUsd: 0.002,
    });
    mockGeneration({ "gen-real-1": { status: 200, cost: 0.002 } });

    const result = await verifyOpenRouterGenerations();

    expect(result.examined).toBe(1);
    expect(result.matched).toBe(1);
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stored.verificationStatus).toBe("match");
    // The whole point of the audit layer: the provider's authoritative cost is
    // persisted, not just an id-echo check.
    expect(stored.verifiedCostUsd).toBe(0.002);
    expect(stored.verifiedSource).toBe("openrouter-generation");
    expect(stored.verifiedAt).not.toBeNull();
  });

  it("never selects an event whose generation id is absent, regardless of keyRef", async () => {
    // keyRef deliberately looks like a generation id; providerRequestId is null.
    await prisma.externalUsageEvent.create({
      data: {
        sourceApp: "socratic-trade",
        provider: "openrouter",
        metricType: "usage",
        keyRef: "gen-looks-like-one",
        costUsd: 0.001,
        occurredAt: new Date(),
        providerRequestId: null,
      },
    });
    const fetchSpy = vi.spyOn(helpers, "fetchJson");

    const result = await verifyOpenRouterGenerations();

    expect(result.examined).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags a discrepancy when the provider charged materially more than reported", async () => {
    const event = await seedEvent({
      providerRequestId: "gen-drift",
      costUsd: 0.001,
    });
    mockGeneration({ "gen-drift": { status: 200, cost: 0.5 } });

    const result = await verifyOpenRouterGenerations();

    expect(result.discrepancies).toBe(1);
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stored.verificationStatus).toBe("discrepancy");
    expect(stored.verifiedCostUsd).toBe(0.5);
  });

  it("treats a null reported cost against real provider cost as under-reporting", async () => {
    const event = await seedEvent({
      providerRequestId: "gen-null-cost",
      costUsd: null,
    });
    mockGeneration({ "gen-null-cost": { status: 200, cost: 0.25 } });

    await verifyOpenRouterGenerations();

    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stored.verificationStatus).toBe("discrepancy");
    expect(stored.verifiedCostUsd).toBe(0.25);
  });

  it("retries transient failures as 'error' and re-selects them on a later pass", async () => {
    const event = await seedEvent({ providerRequestId: "gen-flaky" });
    mockGeneration({ "gen-flaky": { status: 500 } });

    const first = await verifyOpenRouterGenerations();
    expect(first.errors).toBe(1);
    const afterFirst = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(afterFirst.verificationStatus).toBe("error");
    expect(afterFirst.verifiedCostUsd).toBeNull();

    // An "error" row must be picked up again — the due-scan is
    // (status IS NULL OR status IN ('pending','error')).
    mockGeneration({ "gen-flaky": { status: 200, cost: 0.003 } });
    const second = await verifyOpenRouterGenerations();
    expect(second.examined).toBe(1);
    const afterSecond = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(afterSecond.verificationStatus).toBe("match");
  });

  it("stops the pass and reports degraded when the key cannot read generations", async () => {
    await seedEvent({ providerRequestId: "gen-a" });
    await seedEvent({ providerRequestId: "gen-b" });
    const fetchSpy = vi
      .spyOn(helpers, "fetchJson")
      .mockResolvedValue({ ok: false, status: 401, data: null, headers: new Headers() });

    const result = await verifyOpenRouterGenerations();

    expect(result.degraded).toBe(true);
    // One probe is enough to learn the key is unscoped; the rest of the batch
    // must not burn its retry budget on the same configuration problem.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("parks a permanently-dead generation id in a TERMINAL state instead of cycling forever", async () => {
    const event = await seedEvent({ providerRequestId: "gen-dead" });
    // A generation OpenRouter has pruned: 404s on every attempt, forever.
    mockGeneration({ "gen-dead": { status: 404 } });

    // Burn the retry budget.
    for (let pass = 0; pass < 5; pass += 1) {
      await verifyOpenRouterGenerations();
    }
    const parked = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(parked.verificationStatus).toBe("unverifiable");
    expect(parked.verifiedSource).toBe("openrouter-generation-exhausted");

    // The next pass must NOT re-select it. If the terminal state were the
    // retryable "error", this row would be picked up again and its attempt
    // counter would reset — a permanent cycle that fills every batch (the scan
    // is oldest-first) and starves newly-ingested events.
    const fetchSpy = vi.spyOn(helpers, "fetchJson");
    fetchSpy.mockClear(); // drop the 5 calls the retry budget already made
    const after = await verifyOpenRouterGenerations();
    expect(after.examined).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never re-fetches an already-settled event", async () => {
    await seedEvent({
      providerRequestId: "gen-settled",
      verificationStatus: "match",
    });
    const fetchSpy = vi.spyOn(helpers, "fetchJson");

    const result = await verifyOpenRouterGenerations();

    expect(result.examined).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reconcileProviderUsage", () => {
  async function seedProvider(name: string, opts: { totalCost?: number | null } = {}) {
    const provider = await prisma.provider.create({
      data: { name, displayName: name, type: "builtin", isActive: true },
    });
    if (opts.totalCost !== undefined && opts.totalCost !== null) {
      await prisma.usageSnapshot.create({
        data: {
          providerId: provider.id,
          fetchedAt: new Date(),
          totalCost: opts.totalCost,
          costScope: "calendar_month_to_date",
        },
      });
    }
    return provider;
  }

  it("upserts one row per provider-period instead of recreating it", async () => {
    const provider = await seedProvider("openai", { totalCost: 10 });

    await reconcileProviderUsage();
    const first = await prisma.providerUsageReconciliation.findMany({
      where: { providerId: provider.id },
    });
    expect(first).toHaveLength(1);

    await reconcileProviderUsage();
    const second = await prisma.providerUsageReconciliation.findMany({
      where: { providerId: provider.id },
    });
    // A moving periodEnd (or delete+create) would produce a second row and
    // destroy the original's createdAt.
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].createdAt.getTime()).toBe(first[0].createdAt.getTime());
    expect(second[0].keyRef).toBe("");
  });

  it("labels structurally unverifiable providers explicitly, never silently ok", async () => {
    // render's catalog billing.visibility is "metadata" — not reconcilable.
    const provider = await seedProvider("render", { totalCost: 5 });

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("unverifiable");
    expect(row.verifiedCostUsd).toBeNull();
    expect(row.deltaUsd).toBeNull();
  });

  it("marks a verifiable provider with no authoritative snapshot as pending", async () => {
    const provider = await seedProvider("openai");

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("pending");
    expect(row.verifiedCostUsd).toBeNull();
  });

  it("never attributes one pushed-cost bucket to several same-key provider rows", async () => {
    // Two ACTIVE rows sharing a canonical key — Provider.name has no unique
    // constraint, so this is reachable (e.g. two OpenAI accounts).
    const first = await seedProvider("openai", { totalCost: 60 });
    const second = await seedProvider("openai", { totalCost: 40 });

    await reconcileProviderUsage();

    const rows = await prisma.providerUsageReconciliation.findMany({
      where: { providerId: { in: [first.id, second.id] } },
    });
    expect(rows).toHaveLength(2);
    // Exactly one row may own the bucket; the sibling must NOT be handed the
    // same pushed dollars a second time (that would fabricate a discrepancy on
    // a perfectly reconciled month).
    const credited = rows.filter((row) => row.reportedCostUsd > 0);
    expect(credited.length).toBe(0);
    const ambiguous = rows.filter((row) => row.status === "unverifiable");
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous[0].deltaUsd).toBeNull();
    expect(ambiguous[1].deltaUsd).toBeNull();
  });

  async function seedPushedUsage(provider: string, costUsd: number) {
    return prisma.externalUsageEvent.create({
      data: {
        sourceApp: "socratic-trade",
        provider,
        metricType: "usage",
        keyRef: `${provider.toUpperCase()}_API_KEY`,
        costUsd,
        occurredAt: new Date(),
      },
    });
  }

  it("records a discrepancy when provider-reported cost exceeds pushed telemetry", async () => {
    const provider = await seedProvider("openai", { totalCost: 100 });
    // Telemetry MUST exist for a discrepancy to mean anything: the comparison
    // is "what the apps said" vs "what the provider billed".
    await seedPushedUsage("openai", 10);

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("discrepancy");
    expect(row.verifiedCostUsd).toBe(100);
    expect(row.reportedCostUsd).toBe(10);
    expect(row.deltaUsd).toBe(90);
    expect(row.verifiedSource).toBe("usage-snapshot");
  });

  it("still reconciles to ok when telemetry and the provider's own bill agree", async () => {
    const provider = await seedProvider("openai", { totalCost: 10 });
    await seedPushedUsage("openai", 10);

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("ok");
    expect(row.reportedEventCount).toBe(1);
    expect(row.deltaUsd).toBe(0);
  });

  it("calls a provider with a real bill and ZERO telemetry unverifiable, not a discrepancy", async () => {
    // The Twilio case that opened PagerDuty incidents #64 and #70: nothing
    // pushes Twilio usage events, so the reconciler was subtracting the whole
    // bill from zero and reporting it as disagreement. No tolerance short of
    // 100% can absorb "reported = 0", so the threshold is the wrong lever.
    const provider = await seedProvider("twilio", { totalCost: 0.71 });

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("unverifiable");
    expect(row.reportedEventCount).toBe(0);
    // No delta at all — provider-alerts raises usage_reconciliation_discrepancy
    // off `status === "discrepancy"` + deltaUsd, so both must stay clear.
    expect(row.deltaUsd).toBeNull();
    expect(row.deltaRatio).toBeNull();
    expect(row.verifiedCostUsd).toBeNull();
  });

  it("resumes normal reconciliation as soon as that provider starts reporting", async () => {
    const provider = await seedProvider("twilio", { totalCost: 0.71 });

    await reconcileProviderUsage();
    expect(
      (
        await prisma.providerUsageReconciliation.findFirstOrThrow({
          where: { providerId: provider.id },
        })
      ).status
    ).toBe("unverifiable");

    // A telemetry source comes online. No manual reset, no row surgery: the
    // upserted row must flip back to a real comparison on the very next pass.
    await seedPushedUsage("twilio", 0.71);
    await reconcileProviderUsage();

    const rows = await prisma.providerUsageReconciliation.findMany({
      where: { providerId: provider.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].reportedCostUsd).toBeCloseTo(0.71, 10);
    expect(rows[0].verifiedCostUsd).toBe(0.71);
  });

  it("calls a provider unverifiable when pushed events exist but none carry a cost", async () => {
    // PagerDuty #104/#105: Congress.Trade pushes Stripe "usage" pings with
    // costUsd: null (it tracks call volume, not spend). That gave
    // reportedEventCount = 2 while reportedCostUsd stayed $0, so the OLD
    // reportedEventCount === 0 guard did not catch it — it fell through to a
    // real comparison, subtracted the genuine $0.45 bill from zero, and paged
    // a "discrepancy" that no tolerance could absorb. This is the same bug
    // class as the Twilio case above, just wearing a second costume.
    const provider = await seedProvider("stripe", { totalCost: 0.45 });
    await prisma.externalUsageEvent.createMany({
      data: [
        {
          sourceApp: "congress-trade",
          provider: "stripe",
          metricType: "usage",
          costUsd: null,
          occurredAt: new Date(),
        },
        {
          sourceApp: "congress-trade",
          provider: "stripe",
          metricType: "usage",
          costUsd: null,
          occurredAt: new Date(),
        },
      ],
    });

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("unverifiable");
    // The raw event count still reflects reality (for display/debugging) —
    // only the unverifiable gate itself is keyed on priced events.
    expect(row.reportedEventCount).toBe(2);
    expect(row.reportedCostUsd).toBe(0);
    expect(row.deltaUsd).toBeNull();
    expect(row.deltaRatio).toBeNull();
    expect(row.verifiedCostUsd).toBeNull();
  });

  it("still reconciles ok when a provider genuinely has zero cost on both sides", async () => {
    // Guards the companion case: an all-unpriced-events provider with a
    // genuinely $0 bill must not be reclassified as a false "discrepancy" —
    // covered above — but a provider with a real PRICED $0 event and a $0
    // bill is a real, verified agreement and must stay "ok".
    const provider = await seedProvider("openai", { totalCost: 0 });
    await seedPushedUsage("openai", 0);

    await reconcileProviderUsage();

    const row = await prisma.providerUsageReconciliation.findFirstOrThrow({
      where: { providerId: provider.id },
    });
    expect(row.status).toBe("ok");
    expect(row.deltaUsd).toBe(0);
  });
});
