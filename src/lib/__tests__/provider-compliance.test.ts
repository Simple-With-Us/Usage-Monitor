import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Every import of provider-compliance must be DYNAMIC and happen inside
// beforeAll, after DATABASE_URL is set: the module pulls in @/lib/prisma, which
// binds a PrismaClient to the connection string at module-load time. A
// top-level static import would therefore connect to the wrong database and
// fail with "table does not exist".
let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let getProviderComplianceSummary: typeof import("../provider-compliance").getProviderComplianceSummary;
let deriveComplianceState: typeof import("../provider-compliance").deriveComplianceState;
let isVerifiableVisibility: typeof import("../provider-compliance").isVerifiableVisibility;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-compliance-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({
    getProviderComplianceSummary,
    deriveComplianceState,
    isVerifiableVisibility,
  } = await import("../provider-compliance"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
});

beforeEach(async () => {
  await prisma.providerUsageReconciliation.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.provider.deleteMany();
});

describe("deriveComplianceState", () => {
  const base = {
    verifiable: true,
    verifiableEventCount: 10,
    verifiedEventCount: 10,
    discrepancyEventCount: 0,
    unverifiableEventCount: 0,
    periodStatus: "ok" as string | null,
  };

  it("never lets a non-verifiable provider read as healthy", () => {
    // The core 'never silently OK' rule: even with a clean period and full
    // coverage, a structurally-blind provider must say so.
    expect(
      deriveComplianceState({ ...base, verifiable: false })
    ).toBe("unverifiable");
  });

  it("ranks a money disagreement above incomplete coverage", () => {
    expect(
      deriveComplianceState({
        ...base,
        verifiedEventCount: 3,
        discrepancyEventCount: 1,
      })
    ).toBe("discrepancy");
  });

  it("surfaces a period-level discrepancy even when every event matched", () => {
    expect(
      deriveComplianceState({ ...base, periodStatus: "discrepancy" })
    ).toBe("discrepancy");
  });

  it("reports partial when only some events are settled", () => {
    expect(
      deriveComplianceState({ ...base, verifiedEventCount: 4 })
    ).toBe("partial");
  });

  it("reports pending when nothing has settled yet", () => {
    expect(
      deriveComplianceState({ ...base, verifiedEventCount: 0 })
    ).toBe("pending");
  });

  it("reports verified only when coverage is complete", () => {
    expect(deriveComplianceState(base)).toBe("verified");
  });

  it("refuses 'verified' when a material share of calls failed verification", () => {
    // REGRESSION (P1): event-level "unverifiable" is written ONLY by the
    // verification worker's retry-exhausted branch, so each one is a check that
    // was attempted MAX_VERIFICATION_ATTEMPTS times and failed. An earlier
    // revision discounted them entirely, so 1 success alongside 99 permanent
    // failures rendered a green "Verified / 100%" badge.
    expect(
      deriveComplianceState({
        ...base,
        verifiableEventCount: 1,
        verifiedEventCount: 1,
        unverifiableEventCount: 99,
      })
    ).toBe("partial");
  });

  it("tolerates a negligible exhausted population", () => {
    expect(
      deriveComplianceState({
        ...base,
        verifiableEventCount: 100,
        verifiedEventCount: 100,
        unverifiableEventCount: 1,
      })
    ).toBe("verified");
  });

  it("says unverifiable when every call permanently failed verification", () => {
    expect(
      deriveComplianceState({
        ...base,
        verifiableEventCount: 0,
        verifiedEventCount: 0,
        unverifiableEventCount: 5,
        periodStatus: null,
      })
    ).toBe("unverifiable");
  });
});

describe("isVerifiableVisibility", () => {
  it("treats actual/partial as verifiable and the rest as not", () => {
    expect(isVerifiableVisibility("actual")).toBe(true);
    expect(isVerifiableVisibility("partial")).toBe(true);
    expect(isVerifiableVisibility("metadata")).toBe(false);
    expect(isVerifiableVisibility("manual")).toBe(false);
    expect(isVerifiableVisibility("none")).toBe(false);
  });
});

describe("getProviderComplianceSummary", () => {
  async function seedProvider(name: string) {
    return prisma.provider.create({
      data: { name, displayName: name, type: "builtin", isActive: true },
    });
  }

  async function seedEvent(
    providerName: string,
    verificationStatus: string | null
  ) {
    return prisma.externalUsageEvent.create({
      data: {
        sourceApp: "socratic-trade",
        provider: providerName,
        metricType: "usage",
        keyRef: "OPENROUTER_API_KEY",
        costUsd: 0.001,
        occurredAt: new Date(),
        providerRequestId: `gen-${Math.random().toString(36).slice(2)}`,
        verificationStatus,
      },
    });
  }

  it("computes coverage from settled vs pending events", async () => {
    const provider = await seedProvider("openrouter");
    await seedEvent("openrouter", "match");
    await seedEvent("openrouter", "match");
    await seedEvent("openrouter", "discrepancy");
    await seedEvent("openrouter", null);

    const summary = await getProviderComplianceSummary(provider);

    expect(summary.matchedEventCount).toBe(2);
    expect(summary.discrepancyEventCount).toBe(1);
    expect(summary.pendingEventCount).toBe(1);
    expect(summary.verifiedEventCount).toBe(3);
    expect(summary.verifiedCoverage).toBeCloseTo(3 / 4);
    expect(summary.state).toBe("discrepancy");
  });

  it("preserves exact-cased provider event matches in the batched query", async () => {
    const provider = await seedProvider("OpenRouter");
    await seedEvent("OpenRouter", "match");

    const summary = await getProviderComplianceSummary(provider);

    expect(summary.matchedEventCount).toBe(1);
    expect(summary.verifiedEventCount).toBe(1);
  });

  it("counts permanently-failed events in coverage instead of discounting them", async () => {
    // REGRESSION (P1): these are retry-exhausted verification FAILURES, not a
    // benign n/a bucket. Discounting them let a provider whose calls almost all
    // failed render as fully verified.
    const provider = await seedProvider("openrouter");
    await seedEvent("openrouter", "match");
    await seedEvent("openrouter", "unverifiable");

    const summary = await getProviderComplianceSummary(provider);

    expect(summary.verifiedCoverage).toBe(0.5);
    expect(summary.unverifiableEventCount).toBe(1);
    expect(summary.state).toBe("partial");
  });

  it("never shows a green badge when nearly every call failed verification", async () => {
    const provider = await seedProvider("openrouter");
    await seedEvent("openrouter", "match");
    for (let i = 0; i < 9; i += 1) {
      await seedEvent("openrouter", "unverifiable");
    }

    const summary = await getProviderComplianceSummary(provider);

    expect(summary.state).not.toBe("verified");
    expect(summary.verifiedCoverage).toBeCloseTo(0.1);
  });

  it("labels a structurally unverifiable provider with a reason", async () => {
    // render's catalog billing.visibility is "metadata".
    const provider = await seedProvider("render");

    const summary = await getProviderComplianceSummary(provider);

    expect(summary.state).toBe("unverifiable");
    expect(summary.unverifiableReason).toBeTruthy();
  });

  it("reads the period delta back from the reconciliation row", async () => {
    const provider = await seedProvider("openai");
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    );
    await prisma.providerUsageReconciliation.create({
      data: {
        providerId: provider.id,
        periodStart,
        periodEnd,
        keyRef: "",
        reportedCostUsd: 40,
        reportedEventCount: 2,
        verifiedCostUsd: 100,
        verifiedSource: "usage-snapshot",
        deltaUsd: 60,
        deltaRatio: 1.5,
        status: "discrepancy",
        checkedAt: now,
      },
    });

    const summary = await getProviderComplianceSummary(provider, now);

    expect(summary.periodDeltaUsd).toBe(60);
    expect(summary.periodReportedCostUsd).toBe(40);
    expect(summary.periodVerifiedCostUsd).toBe(100);
    expect(summary.state).toBe("discrepancy");
  });
});
