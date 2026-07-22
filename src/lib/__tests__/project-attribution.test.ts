import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
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
  let backfillProjectIdFromMetadataName: typeof import("../project-resolver").backfillProjectIdFromMetadataName;
  let createProject: typeof import("@/app/api/projects/route").POST;
  let createSessionToken: typeof import("../auth").createSessionToken;
  let SESSION_COOKIE_NAME: typeof import("../auth").SESSION_COOKIE_NAME;

  const NOW = new Date("2026-07-15T12:00:00.000Z");
  const occurredAt = new Date("2026-07-10T00:00:00.000Z");

  function authedProjectRequest(body: unknown): NextRequest {
    const token = createSessionToken();
    return new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-attribution-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.SESSION_SECRET = "a".repeat(64);
    setupPrismaSqliteTestDb(dbPath);

    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents } = await import("../external-usage-events"));
    ({ computeProjectBudgetStatus } = await import("../budget-status"));
    ({ resolveProjectIdsByName, backfillProjectIdFromMetadataName } = await import(
      "../project-resolver"
    ));
    ({ POST: createProject } = await import("@/app/api/projects/route"));
    ({ createSessionToken, SESSION_COOKIE_NAME } = await import("../auth"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    const { clearMtdScanMemo } = await import("../mtd-scan-memo");
    clearMtdScanMemo();
    const { __resetBudgetStatusCacheForTests, __resetProjectBudgetStatusCacheForTests } =
      await import("../budget-status");
    __resetBudgetStatusCacheForTests();
    __resetProjectBudgetStatusCacheForTests();
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
    expect(map.get("socratic-trade")).toBe(project.id);
    expect(map.has("unknown-app")).toBe(false);
  });

  it("resolves producer slugs to canonical dotted project names", async () => {
    const socratic = await prisma.project.create({
      data: { name: "SocraticTrade.com", nameKey: "socratictrade.com" },
    });
    const congress = await prisma.project.create({
      data: { name: "Congress.Trade", nameKey: "congress.trade" },
    });

    const map = await resolveProjectIdsByName(["socratic-trade", "congress-trade"]);
    expect(map.get("socratic-trade")).toBe(socratic.id);
    expect(map.get("congress-trade")).toBe(congress.id);
  });

  it("rejects canonically equivalent project aliases at creation", async () => {
    const first = await createProject(authedProjectRequest({ name: "Congress.Trade" }));
    const duplicate = await createProject(authedProjectRequest({ name: "congress-trade" }));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(400);
    expect(await prisma.project.findMany({ select: { name: true, nameKey: true } })).toEqual([
      { name: "Congress.Trade", nameKey: "congress-trade" },
    ]);
  });

  it("rejects project create without a dashboard session outside vitest (Wave G/H / E18)", async () => {
    // Under vitest, mutator session re-check is skipped so handlers can be unit
    // tested without minting cookies. Force-enforce by clearing VITEST.
    const prevVitest = process.env.VITEST;
    process.env.VITEST = "false";
    try {
      const res = await createProject(
        new NextRequest("http://localhost/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "No Session Project" }),
        })
      );
      expect(res.status).toBe(401);
    } finally {
      if (prevVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
    }
  });

  it("backfills metadata.project rows when a Project is created via API (Wave G / E6)", async () => {
    await persistExternalUsageEvents([
      {
        idempotencyKey: "api-create-backfill-1",
        sourceApp: "socratic-trade",
        provider: "openai",
        projectId: null,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 7,
        occurredAt,
        metadata: { project: "New Budget Project" },
      },
      {
        idempotencyKey: "api-create-backfill-other",
        sourceApp: "socratic-trade",
        provider: "openai",
        projectId: null,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 1,
        occurredAt,
        metadata: { project: "Unrelated" },
      },
    ]);

    const res = await createProject(
      authedProjectRequest({ name: "New Budget Project", monthlyBudgetUsd: 50 })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backfilledEvents).toBe(1);

    const matched = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: "api-create-backfill-1" },
      select: { projectId: true },
    });
    const other = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: "api-create-backfill-other" },
      select: { projectId: true },
    });
    expect(matched.projectId).toBe(body.id);
    expect(other.projectId).toBeNull();

    // Helper is idempotent for already-attributed rows.
    expect(await backfillProjectIdFromMetadataName(body.id, body.name)).toBe(0);
  });

  it("uses the same oldest canonical project for ingest and legacy budgets", async () => {
    const first = await prisma.project.create({
      data: {
        id: "a-oldest-canonical-project",
        name: "Congress.Trade",
        nameKey: "legacy-congress-dot",
        monthlyBudgetUsd: 100,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const duplicate = await prisma.project.create({
      data: {
        id: "z-newer-canonical-project",
        name: "congress-trade",
        nameKey: "legacy-congress-dash",
        monthlyBudgetUsd: 100,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const resolved = await resolveProjectIdsByName(["congress-trade"]);
    await persistExternalUsageEvents([
      {
        idempotencyKey: "canonical-project-oldest",
        sourceApp: "congress-trade",
        provider: "openai",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 4,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(resolved.get("congress-trade")).toBe(first.id);
    expect(status.projects.find((project) => project.id === first.id)?.directUsd).toBe(4);
    expect(status.projects.find((project) => project.id === duplicate.id)?.directUsd).toBe(0);
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

  it("adds project metadata and attribution when replaying a legacy event", async () => {
    const event = {
      idempotencyKey: "legacy-project-backfill",
      sourceApp: "socratic-trade",
      provider: "openai",
      projectId: null,
      billingMode: "actual",
      metricType: "cost",
      costUsd: 3,
      occurredAt,
      metadata: { lane: "rag" },
    };
    await persistExternalUsageEvents([event]);
    const project = await prisma.project.create({ data: { name: "Socratic Trade" } });

    await expect(
      persistExternalUsageEvents([
        {
          ...event,
          projectId: project.id,
          metadata: { ...event.metadata, project: "Socratic Trade" },
        },
      ])
    ).resolves.toBeDefined();

    expect(
      await prisma.externalUsageEvent.findUniqueOrThrow({
        where: { idempotencyKey: event.idempotencyKey },
        select: { projectId: true, metadata: true },
      })
    ).toEqual({
      projectId: project.id,
      metadata: { lane: "rag", project: "Socratic Trade" },
    });
  });

  it("rejects replay attribution to a different raw project name", async () => {
    const event = {
      idempotencyKey: "raw-project-name-collision",
      sourceApp: "socratic-trade",
      provider: "openai",
      projectId: null,
      billingMode: "actual",
      metricType: "cost",
      costUsd: 3,
      occurredAt,
      metadata: { project: "Socratic Trade" },
    };
    await persistExternalUsageEvents([event]);

    await expect(
      persistExternalUsageEvents([
        { ...event, metadata: { project: "Congress Trade" } },
      ])
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
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

  it("merges richer project attribution for duplicates in the same batch", async () => {
    const project = await prisma.project.create({ data: { name: "SocraticTrade.com" } });
    const base = {
      idempotencyKey: "same-batch-project-backfill",
      sourceApp: "socratic-trade",
      provider: "openai",
      projectId: null,
      billingMode: "actual",
      metricType: "cost",
      costUsd: 2,
      occurredAt,
      metadata: { lane: "rag" },
    };

    await persistExternalUsageEvents([
      base,
      {
        ...base,
        projectId: project.id,
        metadata: { ...base.metadata, project: "socratic-trade" },
      },
    ]);

    expect(
      await prisma.externalUsageEvent.findUniqueOrThrow({
        where: { idempotencyKey: base.idempotencyKey },
        select: { projectId: true, metadata: true },
      })
    ).toEqual({
      projectId: project.id,
      metadata: { lane: "rag", project: "socratic-trade" },
    });
  });

  it("rejects conflicting project attribution inside one batch", async () => {
    const first = await prisma.project.create({ data: { name: "First Project" } });
    const second = await prisma.project.create({ data: { name: "Second Project" } });
    const base = {
      idempotencyKey: "same-batch-project-collision",
      sourceApp: "socratic-trade",
      provider: "openai",
      billingMode: "actual",
      metricType: "cost",
      costUsd: 2,
      occurredAt,
    };

    await expect(
      persistExternalUsageEvents([
        { ...base, projectId: first.id, metadata: { project: "First Project" } },
        { ...base, projectId: second.id, metadata: { project: "Second Project" } },
      ])
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
    expect(await prisma.externalUsageEvent.count()).toBe(0);
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

  it("does not extrapolate receipt-backed direct or allocated project spend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "push",
        refreshIntervalMin: 60,
      },
    });
    const directProject = await prisma.project.create({
      data: { name: "Direct Project", monthlyBudgetUsd: 100 },
    });
    const allocatedProject = await prisma.project.create({
      data: { name: "Allocated Project", monthlyBudgetUsd: 100 },
    });
    await prisma.providerProjectAllocation.create({
      data: {
        providerId: provider.id,
        projectId: allocatedProject.id,
        percentage: 100,
      },
    });
    const digest = "f".repeat(64);
    await persistExternalUsageEvents([
      {
        idempotencyKey: "receipt-covered-direct-usage",
        sourceApp: "producer",
        provider: "anthropic",
        projectId: directProject.id,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 30,
        occurredAt,
      },
      {
        idempotencyKey: `billing-receipt:v1:${digest}`,
        sourceApp: "billing-receipt-import",
        provider: "anthropic",
        service: "api-prepaid-funding",
        label: "receipt_cash_paid",
        keyRef: `provider:${provider.id}:billing-receipt:${digest}`,
        billingMode: "actual",
        metricType: "cost",
        unit: "usd",
        confidence: "actual",
        costUsd: 47.25,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.projects.find((row) => row.id === directProject.id)).toMatchObject({
      directUsd: 30,
      allocatedUsd: 0,
      spentUsd: 30,
      projectedEomUsd: 30,
    });
    // Prepaid receipts are funding, not residual consumption — residual
    // allocation after direct-tagged usage is zero (Wave A money trust).
    expect(status.projects.find((row) => row.id === allocatedProject.id)).toMatchObject({
      directUsd: 0,
      allocatedUsd: 0,
      spentUsd: 0,
      projectedEomUsd: 0,
    });
  });

  it("uses identical duplicate-provider priority for spend and attribution", async () => {
    await prisma.provider.create({
      data: {
        id: "a-provider-without-plan",
        name: "duplicate-provider",
        displayName: "Duplicate without plan",
        type: "builtin",
      },
    });
    const planned = await prisma.provider.create({
      data: {
        id: "z-provider-with-plan",
        name: "duplicate-provider",
        displayName: "Duplicate with plan",
        type: "builtin",
        plan: { create: { billingMode: "manual" } },
      },
    });
    const project = await prisma.project.create({
      data: { name: "Priority Project", monthlyBudgetUsd: 100 },
    });
    await prisma.providerProjectAllocation.create({
      data: { providerId: planned.id, projectId: project.id, percentage: 100 },
    });
    await persistExternalUsageEvents([
      {
        idempotencyKey: "duplicate-provider-priority",
        sourceApp: "producer",
        provider: "duplicate-provider",
        projectId: project.id,
        billingMode: "actual",
        metricType: "cost",
        costUsd: 10,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.providers.find((provider) => provider.id === planned.id)?.spentUsd).toBe(10);
    expect(status.projects.find((row) => row.id === project.id)).toMatchObject({
      directUsd: 10,
      allocatedUsd: 0,
      spentUsd: 10,
    });
  });

  it("joins producer provider/project aliases without rewriting the raw event", async () => {
    const provider = await prisma.provider.create({
      data: { name: "google-ai", displayName: "Google AI", type: "builtin" },
    });
    const project = await prisma.project.create({
      data: { name: "SocraticTrade.com", monthlyBudgetUsd: 100 },
    });
    await persistExternalUsageEvents([
      {
        idempotencyKey: "legacy-gemini-project-alias",
        sourceApp: "socratic-trade",
        provider: "gemini",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 8,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.providers.find((row) => row.id === provider.id)).toMatchObject({
      pushedMonthToDateUsd: 8,
      pushedCostCoverage: "complete",
      // The pushed stream is internally complete, but without a ready Google
      // billing export it cannot prove whole-account cash coverage.
      spendCoverage: "partial",
    });
    expect(status.projects.find((row) => row.id === project.id)).toMatchObject({
      directUsd: 8,
      spentUsd: 8,
    });
    expect(
      await prisma.externalUsageEvent.findUniqueOrThrow({
        where: { idempotencyKey: "legacy-gemini-project-alias" },
        select: { provider: true, sourceApp: true },
      })
    ).toEqual({ provider: "gemini", sourceApp: "socratic-trade" });
  });

  it("routes an exact custom provider name before a built-in alias", async () => {
    const custom = await prisma.provider.create({
      data: { name: "gemini", displayName: "Custom Gemini", type: "custom" },
    });
    const builtin = await prisma.provider.create({
      data: { name: "google-ai", displayName: "Google AI", type: "builtin" },
    });
    await persistExternalUsageEvents([
      {
        idempotencyKey: "exact-provider-before-alias",
        sourceApp: "producer",
        provider: "gemini",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 7,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.providers.find((row) => row.id === custom.id)?.pushedMonthToDateUsd).toBe(7);
    expect(status.providers.find((row) => row.id === builtin.id)?.pushedMonthToDateUsd).toBe(0);
  });

  it("reports omitted pushed cost as unknown instead of authoritative zero", async () => {
    const provider = await prisma.provider.create({
      data: { name: "google-ai", displayName: "Google AI", type: "builtin" },
    });
    const project = await prisma.project.create({
      data: { name: "Congress.Trade", monthlyBudgetUsd: 100 },
    });
    await persistExternalUsageEvents([
      {
        idempotencyKey: "gemini-unpriced-request",
        sourceApp: "congress-trade",
        provider: "gemini",
        billingMode: "estimated",
        metricType: "request",
        requests: 1,
        occurredAt,
      },
    ]);

    const status = await computeProjectBudgetStatus(NOW);
    expect(status.providers.find((row) => row.id === provider.id)).toMatchObject({
      spentUsd: 0,
      pushedPricedEventCount: 0,
      pushedUnpricedEventCount: 1,
      pushedCostCoverage: "unknown",
      spendCoverage: "unknown",
    });
    expect(status.projects.find((row) => row.id === project.id)).toMatchObject({
      spentUsd: 0,
      spendCoverage: "unknown",
      pricedEventCount: 0,
      unpricedEventCount: 1,
      unclassifiedCostEventCount: 0,
    });
  });
});
