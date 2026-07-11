import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Exercises the corrected per-project budget math end to end: explicit projectId
// is authoritative, the sourceApp-name fallback only applies to untagged rows,
// and percentage allocation distributes the true residual without
// double-counting directly-attributed cost.
describe("project attribution (integration)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
  let computeProjectBudgetStatus: typeof import("../budget-status").computeProjectBudgetStatus;
  let resolveProjectIdsByName: typeof import("../project-resolver").resolveProjectIdsByName;
  let summarizeExternalUsageEvents: typeof import("../external-usage-events").summarizeExternalUsageEvents;
  let sumMonthToDateExternalCostAttribution: typeof import("../external-usage-events").sumMonthToDateExternalCostAttribution;

  const NOW = new Date("2026-07-15T12:00:00.000Z");
  const occurredAt = new Date("2026-07-10T00:00:00.000Z");

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-attribution-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);

    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents } = await import("../external-usage-events"));
    ({ summarizeExternalUsageEvents, sumMonthToDateExternalCostAttribution } = await import("../external-usage-events"));
    ({ computeProjectBudgetStatus } = await import("../budget-status"));
    ({ resolveProjectIdsByName } = await import("../project-resolver"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
    await prisma.providerProjectAllocation.deleteMany();
    await prisma.providerPlan.deleteMany();
    await prisma.project.deleteMany();
    await prisma.provider.deleteMany();
  });

  it("resolves project names case-insensitively and leaves unknowns unresolved", async () => {
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", nameKey: "socratic trade" },
    });
    // Producer sends a differently-cased name; it still resolves (keyed by
    // nameKey / lowercased name). An unrelated name does not resolve.
    const map = await resolveProjectIdsByName(["SOCRATIC TRADE", "unknown-app"]);
    expect(map.get("socratic trade")).toBe(project.id);
    expect(map.has("unknown-app")).toBe(false);
  });

  it("rejects case-variant project names at the database level (closes the create race)", async () => {
    await prisma.project.create({ data: { name: "Socratic Trade", nameKey: "socratic trade" } });
    // Two concurrent creates both pass an app-level check but the unique nameKey
    // constraint fails the second insert — the guarantee an app check can't give.
    await expect(
      prisma.project.create({ data: { name: "socratic trade", nameKey: "socratic trade" } })
    ).rejects.toThrow();
  });

  it("backfills attribution when a previously unknown project is created", async () => {
    const event = {
      idempotencyKey: "late-project-resolution",
      sourceApp: "socratic-trade",
      provider: "openai",
      projectId: null,
      billingMode: "actual",
      metricType: "cost",
      costUsd: 2,
      occurredAt,
      metadata: { project: "Later Project" },
    };
    await persistExternalUsageEvents([event]);
    const project = await prisma.project.create({ data: { name: "Later Project" } });

    await expect(
      persistExternalUsageEvents([{ ...event, projectId: project.id }])
    ).resolves.toBeDefined();
    expect(
      await prisma.externalUsageEvent.findUniqueOrThrow({
        where: { idempotencyKey: event.idempotencyKey },
        select: { projectId: true },
      })
    ).toEqual({ projectId: project.id });
  });

  it("rejects reuse of one idempotency key across two resolved projects", async () => {
    const first = await prisma.project.create({ data: { name: "First Project" } });
    const second = await prisma.project.create({ data: { name: "Second Project" } });
    const event = {
      idempotencyKey: "project-identity-collision",
      sourceApp: "socratic-trade",
      provider: "openai",
      projectId: first.id,
      billingMode: "actual",
      metricType: "cost",
      costUsd: 2,
      occurredAt,
      metadata: { project: "First Project" },
    };
    await persistExternalUsageEvents([event]);

    await expect(
      persistExternalUsageEvents([{ ...event, projectId: second.id }])
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });

  it("keeps delimiter-containing summary and attribution dimensions distinct", async () => {
    await persistExternalUsageEvents([
      {
        idempotencyKey: "summary-delimiter-a",
        sourceApp: "a|b",
        provider: "c",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 1,
        occurredAt,
      },
      {
        idempotencyKey: "summary-delimiter-b",
        sourceApp: "a",
        environment: "b|",
        provider: "c",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 1,
        occurredAt,
      },
      {
        idempotencyKey: "attribution-delimiter-a",
        sourceApp: "c",
        provider: "a|b",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 2,
        occurredAt,
      },
      {
        idempotencyKey: "attribution-delimiter-b",
        sourceApp: "b|c",
        provider: "a",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 3,
        occurredAt,
      },
    ]);

    const summary = await summarizeExternalUsageEvents(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z")
    );
    const attribution = await sumMonthToDateExternalCostAttribution(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z")
    );

    expect(summary.groups).toHaveLength(4);
    expect(attribution).toHaveLength(4);
  });

  it("does not subtract canonical direct spend from a duplicate provider's snapshot residual", async () => {
    const project = await prisma.project.create({
      data: { name: "Duplicate allocation", nameKey: "duplicate allocation" },
    });
    await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "Canonical push owner",
        type: "builtin",
        plan: { create: { monthlyBudgetUsd: 100 } },
      },
    });
    const duplicate = await prisma.provider.create({
      data: {
        name: "OpenAI",
        displayName: "Independent key",
        type: "builtin",
        allocations: { create: { projectId: project.id, percentage: 100 } },
        snapshots: {
          create: {
            fetchedAt: NOW,
            totalCost: 10,
            costWindowStart: new Date("2026-07-01T00:00:00.000Z"),
            costWindowEnd: NOW,
            costScope: "calendar_month_to_date",
          },
        },
      },
    });
    await persistExternalUsageEvents([
      {
        idempotencyKey: "duplicate-direct-cost",
        sourceApp: "socratic-trade",
        provider: "openai",
        projectId: project.id,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 5,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.providers.find((provider) => provider.id === duplicate.id)?.spentUsd).toBe(10);
    expect(status.projects[0]).toMatchObject({ directUsd: 5, allocatedUsd: 10, spentUsd: 15 });
  });

  it("attributes projectId-tagged cost directly and never double-counts under allocation", async () => {
    const provider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "push", refreshIntervalMin: 60 },
    });
    const project = await prisma.project.create({
      data: { name: "Socratic Trade", monthlyBudgetUsd: 100 },
    });

    // $10 tagged to the project, $4 untagged — both under the anthropic provider.
    await persistExternalUsageEvents([
      {
        idempotencyKey: "tagged-1",
        sourceApp: "claude-code",
        provider: "anthropic",
        projectId: project.id,
        billingMode: "actual",
        metricType: "usage",
        costUsd: 10,
        occurredAt,
      },
      {
        idempotencyKey: "untagged-1",
        sourceApp: "some-other-app",
        provider: "anthropic",
        projectId: null,
        billingMode: "actual",
        metricType: "usage",
        costUsd: 4,
        occurredAt,
      },
    ]);

    // Without any allocation, only the directly-tagged $10 lands on the project.
    let status = await computeProjectBudgetStatus(NOW);
    let proj = status.projects.find((p) => p.id === project.id)!;
    expect(proj.directUsd).toBeCloseTo(10);
    expect(proj.allocatedUsd).toBeCloseTo(0);
    expect(proj.spentUsd).toBeCloseTo(10);
    expect(status.summary).toMatchObject({
      totalSpentUsd: 14,
      unassignedSpentUsd: 4,
    });

    // Allocate 100% of the anthropic provider to the project. The provider's
    // month-to-date spend is $14; $10 is already directly attributed, so the
    // residual distributed by allocation is only $4 — total $14, not $24.
    await prisma.providerProjectAllocation.create({
      data: { providerId: provider.id, projectId: project.id, percentage: 100 },
    });

    status = await computeProjectBudgetStatus(NOW);
    proj = status.projects.find((p) => p.id === project.id)!;
    expect(proj.directUsd).toBeCloseTo(10);
    expect(proj.allocatedUsd).toBeCloseTo(4);
    expect(proj.spentUsd).toBeCloseTo(14);
    expect(status.summary).toMatchObject({
      totalSpentUsd: 14,
      unassignedSpentUsd: 0,
    });
  });
});
