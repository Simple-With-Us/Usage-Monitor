import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { encrypt } from "../crypto";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let buildWorkspaceExport: typeof import("../workspace-copy").buildWorkspaceExport;
let importWorkspacePayload: typeof import("../workspace-copy").importWorkspacePayload;

const ENC = "42".repeat(32);

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-copy-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = ENC;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ buildWorkspaceExport, importWorkspacePayload } = await import(
    "../workspace-copy"
  ));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.providerProjectAllocation.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.project.deleteMany();
});

describe("workspace copy", () => {
  it("exports projects and provider shells without secrets", async () => {
    const project = await prisma.project.create({
      data: { name: "DealDex", nameKey: "dealdex" },
    });
    await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI org",
        type: "builtin",
        apiKey: encrypt("sk-live-must-not-leak"),
        secretConfig: "encrypted-envelope",
        config: { orgId: "org_public", adminApiKey: "sk-admin-secret" },
        isActive: true,
      },
    });

    const payload = await buildWorkspaceExport();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("sk-live-must-not-leak");
    expect(serialized).not.toContain("sk-admin-secret");
    expect(serialized).not.toContain("encrypted-envelope");
    expect(payload.format).toBe("usage-monitor-local-export");
    expect(payload.copyInstructions).toMatch(/Import Package/);
    expect(payload.copyInstructions).toMatch(/no bundle key/i);
    expect(payload.note).toMatch(/no bundle key/i);
    expect(payload.projects[0]).toMatchObject({
      id: project.id,
      name: "DealDex",
    });
    expect(payload.providers[0]).toMatchObject({
      name: "openai",
      displayName: "OpenAI org",
      isActive: false,
      hasKeychainCredential: true,
      publicConfig: { orgId: "org_public" },
    });
    expect(payload.providers[0].publicConfig).not.toHaveProperty("adminApiKey");
  });

  it("imports a Local-compatible package without activating keys", async () => {
    const payload = {
      format: "usage-monitor-local-export",
      formatVersion: 1,
      projects: [
        { id: "proj-1", name: "Congress.Trade", monthlyBudgetUsd: 50 },
      ],
      providers: [
        {
          id: "prov-1",
          name: "openrouter",
          displayName: "OpenRouter",
          type: "builtin",
          adapterKind: "openrouter",
          isActive: true,
          publicConfig: { note: "public-only" },
        },
      ],
      plans: [
        {
          providerId: "prov-1",
          billingMode: "manual",
          monthlyBudgetUsd: 20,
        },
      ],
      subscriptions: [],
      charges: [],
      snapshots: [],
      allocations: [],
    };

    const result = await importWorkspacePayload(payload, "merge");
    expect(result.projects).toBe(1);
    expect(result.providers).toBe(1);
    expect(result.plans).toBe(1);

    const provider = await prisma.provider.findUnique({ where: { id: "prov-1" } });
    expect(provider?.isActive).toBe(false);
    expect(provider?.apiKey).toBeNull();
    expect(provider?.secretConfig).toBeNull();
    expect(provider?.config).toEqual({ note: "public-only" });

    const again = await importWorkspacePayload(payload, "merge");
    expect(again.projects).toBe(0);
    expect(again.providers).toBe(0);
    expect(again.plans).toBe(0);
  });

  it("does not clobber live plans or attach local extras onto existing providers", async () => {
    const liveCiphertext = encrypt("sk-live-must-stay");
    const provider = await prisma.provider.create({
      data: {
        id: "prov-live",
        name: "openai",
        displayName: "OpenAI org",
        type: "builtin",
        isActive: true,
        apiKey: liveCiphertext,
      },
    });
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        monthlyBudgetUsd: 250,
        notes: "production budget",
      },
    });
    await prisma.usageSnapshot.create({
      data: {
        id: "snap-live",
        providerId: provider.id,
        fetchedAt: new Date("2026-08-22T09:00:00.000Z"),
        totalCost: 42,
      },
    });
    await prisma.subscription.create({
      data: {
        id: "sub-live",
        providerId: provider.id,
        name: "ChatGPT Plus",
        costUsd: 20,
        interval: "monthly",
        status: "active",
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        nextRenewalAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    // iOS Local export of the same format omits null plan fields (stripNils)
    // and may carry phone-local snapshot/subscription ids.
    const iosLocalExport = {
      format: "usage-monitor-local-export",
      formatVersion: 1,
      projects: [],
      providers: [
        {
          id: "prov-live",
          name: "openai",
          displayName: "OpenAI org",
          type: "builtin",
        },
      ],
      plans: [
        {
          providerId: "prov-live",
          billingMode: "manual",
        },
      ],
      subscriptions: [
        {
          id: "sub-phone",
          providerId: "prov-live",
          name: "Local test seat",
          costUsd: 200,
          interval: "monthly",
          status: "active",
          currentPeriodStart: "2026-08-22T00:00:00.000Z",
          nextRenewalAt: "2026-09-22T00:00:00.000Z",
        },
      ],
      charges: [],
      snapshots: [
        {
          id: "snap-phone",
          providerId: "prov-live",
          fetchedAt: "2026-08-22T10:00:00.000Z",
          totalCost: 0,
        },
      ],
      allocations: [],
    };

    const result = await importWorkspacePayload(iosLocalExport, "merge");
    expect(result.plans).toBe(0);
    expect(result.subscriptions).toBe(0);
    expect(result.snapshots).toBe(0);

    const plan = await prisma.providerPlan.findUnique({
      where: { providerId: provider.id },
    });
    expect(plan).toMatchObject({
      billingMode: "actual",
      monthlyBudgetUsd: 250,
      notes: "production budget",
    });
    expect(await prisma.provider.findUnique({ where: { id: provider.id } })).toMatchObject({
      isActive: true,
      apiKey: liveCiphertext,
    });
    expect(await prisma.subscription.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await prisma.usageSnapshot.count({ where: { providerId: provider.id } })).toBe(1);
    const latest = await prisma.usageSnapshot.findFirst({
      where: { providerId: provider.id },
      orderBy: { fetchedAt: "desc" },
    });
    expect(latest).toMatchObject({ id: "snap-live", totalCost: 42 });
  });
});
