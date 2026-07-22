import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let PATCH: typeof import("../route").PATCH;
let prisma: typeof import("@/lib/prisma").prisma;
let testDir: string;

function request(method: "GET" | "POST" | "PATCH", body?: unknown) {
  return new NextRequest("https://usage.jays.services/api/key-attribution", {
    method,
    headers: body == null ? undefined : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "key-attribution-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "test-attribution-key-material-longer-than-32-characters";
  setupPrismaSqliteTestDb(dbPath);
  ({ GET, POST, PATCH } = await import("../route"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ATTRIBUTION_IDENTITY_HMAC_KEY;
});

beforeEach(async () => {
  await prisma.providerKeyBinding.deleteMany();
  await prisma.providerKeyIdentity.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.project.deleteMany();
  await prisma.provider.deleteMany();
});

describe("provider key attribution API", () => {
  it("stores only an HMAC identity and reports exact matched vs unattributed pushed-v2 cost", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const eventTime = new Date(Math.max(monthStart.getTime() + 60_000, now.getTime() - 60_000));
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const project = await prisma.project.create({ data: { name: "Congress.Trade" } });
    const rawProviderKeyId = "provider-opaque-key-id-do-not-store";

    const identityResponse = await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Congress production",
      description: "Admin-confirmed provider key",
      providerReportedKeyId: rawProviderKeyId,
    }));
    expect(identityResponse.status).toBe(201);
    expect(JSON.stringify(await identityResponse.json())).not.toContain(rawProviderKeyId);
    const storedIdentity = await prisma.providerKeyIdentity.findFirstOrThrow();
    expect(storedIdentity.providerReportedKeyIdFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(storedIdentity)).not.toContain(rawProviderKeyId);

    const bindingResponse = await POST(request("POST", {
      action: "create_binding",
      identityId: storedIdentity.id,
      producerId: "congress-trade",
      producerKeyRef: "configured-openai-primary",
      providerConnectionRef: "openai-org-primary",
      billingAccountRef: "openai-billing-primary",
      projectId: project.id,
      effectiveFrom: monthStart.toISOString(),
    }));
    expect(bindingResponse.status).toBe(201);

    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: "matched-v2-cost",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 3,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _providerConnectionRef: "openai-org-primary",
            _billingAccountRef: "openai-billing-primary",
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "unmatched-v2-cost",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "unknown-key",
          costUsd: 2,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageMode: "window",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "provider-id-direct-match",
          sourceApp: "admin-usage-poller",
          provider: "openai",
          keyRef: rawProviderKeyId,
          costUsd: 4,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "cumulative-cost-not-additive",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 100,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _providerConnectionRef: "openai-org-primary",
            _billingAccountRef: "openai-billing-primary",
            _coverageMode: "cumulative",
            _coverageRelationship: "supersedes",
          },
        },
        {
          idempotencyKey: "legacy-cost-not-in-v2-coverage",
          sourceApp: "legacy",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 50,
          occurredAt: eventTime,
        },
      ],
    });

    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.coverage).toMatchObject({
      scope: "pushed_v2_cost_events",
      aggregation: "proven_disjoint_point_or_window_event_sum",
      totalCostUsd: 9,
      identityMatchedCostUsd: 7,
      identityUnattributedCostUsd: 2,
      projectAttributedCostUsd: 3,
      projectUnattributedCostUsd: 6,
      totalEventCount: 4,
      identityMatchedEventCount: 3,
      identityUnattributedEventCount: 1,
      unclassifiedCostEventCount: 1,
    });
    expect(body.coverage.reasons.no_effective_binding).toEqual({ costUsd: 2, eventCount: 1 });
    expect(body.coverage.byIdentity[storedIdentity.id]).toEqual({
      costUsd: 7,
      eventCount: 3,
    });
    expect(JSON.stringify(body)).not.toContain(rawProviderKeyId);

    const retireResponse = await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: storedIdentity.id,
      effectiveTo: now.toISOString(),
    }));
    expect(retireResponse.status).toBe(200);
    const afterRetirement = await (await GET(request("GET"))).json();
    expect(afterRetirement.coverage.identityMatchedCostUsd).toBe(7);
    expect(afterRetirement.identities[0].status).toBe("retired");
  });

  it("does not extend a direct provider-ID match past identity retirement", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const retiredAt = new Date(Math.max(monthStart.getTime() + 120_000, now.getTime() - 120_000));
    const beforeRetirement = new Date(retiredAt.getTime() - 1_000);
    const afterRetirement = new Date(retiredAt.getTime() + 1_000);
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const providerKeyId = "retired-provider-key-id";
    const identityResponse = await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Retired key",
      providerReportedKeyId: providerKeyId,
    }));
    expect(identityResponse.status).toBe(201);
    const identity = await prisma.providerKeyIdentity.findFirstOrThrow();
    expect((await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: identity.id,
      effectiveTo: retiredAt.toISOString(),
    }))).status).toBe(200);

    await prisma.externalUsageEvent.createMany({
      data: [beforeRetirement, afterRetirement].map((occurredAt, index) => ({
        idempotencyKey: `retired-direct-key-${index}`,
        sourceApp: "admin-usage-poller",
        provider: "openai",
        keyRef: providerKeyId,
        costUsd: 1,
        occurredAt,
        metadata: {
          _usageTelemetrySchemaVersion: 2,
          _coverageMode: "point",
          _coverageRelationship: "disjoint",
        },
      })),
    });

    const body = await (await GET(request("GET"))).json();
    expect(body.coverage.identityMatchedCostUsd).toBe(1);
    expect(body.coverage.identityUnattributedCostUsd).toBe(1);
    expect(body.coverage.reasons.no_effective_binding).toEqual({ costUsd: 1, eventCount: 1 });
  });

  it("rejects an overlapping remap instead of guessing or rewriting history", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const first = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "First" },
    });
    const second = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Second" },
    });
    await prisma.providerKeyBinding.create({
      data: {
        identityId: first.id,
        producerId: "congress-trade",
        producerKeyRef: "openai-primary",
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const response = await POST(request("POST", {
      action: "create_binding",
      identityId: second.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      effectiveFrom: "2026-07-15T00:00:00.000Z",
    }));
    expect(response.status).toBe(409);
    expect(await prisma.providerKeyBinding.count()).toBe(1);
  });
});
