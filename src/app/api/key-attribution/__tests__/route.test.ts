import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken } from "@/lib/auth";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;
let PATCH: typeof import("../route").PATCH;
let prisma: typeof import("@/lib/prisma").prisma;
let testDir: string;

function request(
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  extraHeaders: Record<string, string> = {}
) {
  return new NextRequest("https://usage.jays.services/api/key-attribution", {
    method,
    headers: {
      ...(body == null ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
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
  process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "test-attribution-key-material-longer-than-32-characters";
  delete process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS;
  await prisma.providerKeyBinding.deleteMany();
  await prisma.providerKeyIdentity.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.project.deleteMany();
  await prisma.provider.deleteMany();
});

describe("provider key attribution API", () => {
  it("requires a production-shaped dashboard session and marks GET private no-store", async () => {
    const originalVitest = process.env.VITEST;
    const originalSessionSecret = process.env.SESSION_SECRET;
    process.env.VITEST = "false";
    process.env.SESSION_SECRET = "production-shaped-attribution-session-secret";
    try {
      expect((await GET(request("GET"))).status).toBe(401);
      const response = await GET(request("GET", undefined, {
        cookie: `dashboard_session=${createSessionToken()}`,
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      if (originalVitest == null) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
      if (originalSessionSecret == null) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSessionSecret;
    }
  });

  it("rejects duplicate provider identities across an HMAC key rotation", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const rawProviderKeyId = "stable-provider-key-id";
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "old-attribution-key-material-longer-than-32-characters";
    expect((await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Original",
      providerReportedKeyId: rawProviderKeyId,
    }))).status).toBe(201);

    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "new-attribution-key-material-longer-than-32-characters";
    process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS = "old-attribution-key-material-longer-than-32-characters";
    expect((await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Duplicate after rotation",
      providerReportedKeyId: rawProviderKeyId,
    }))).status).toBe(409);
    expect(await prisma.providerKeyIdentity.count()).toBe(1);
  });

  it("stores only an HMAC identity and reports exact matched vs unattributed pushed-v2 cost", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const eventTime = new Date(Math.max(monthStart.getTime() + 60_000, now.getTime() - 60_000));
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const project = await prisma.project.create({ data: { name: "Congress.Trade" } });
    const rawProviderKeyId = "provider-opaque-key-id-do-not-store";
    const adminProducerKeyRef = "admin-openai-key-a";

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
    const directEventTime = new Date();
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
    expect((await POST(request("POST", {
      action: "create_binding",
      identityId: storedIdentity.id,
      producerId: "admin-usage-poller",
      producerKeyRef: adminProducerKeyRef,
      effectiveFrom: storedIdentity.createdAt.toISOString(),
    }))).status).toBe(201);

    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: "event-a",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 3,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageScope: "api_key",
            _providerConnectionRef: "openai-org-primary",
            _billingAccountRef: "openai-billing-primary",
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "event-b",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "unknown-key",
          costUsd: 2,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageScope: "api_key",
            _coverageMode: "window",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "event-c",
          sourceApp: "admin-usage-poller",
          provider: "openai",
          keyRef: adminProducerKeyRef,
          costUsd: 4,
          occurredAt: directEventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageScope: "api_key",
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "event-d",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 100,
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageScope: "billing_account",
            _providerConnectionRef: "openai-org-primary",
            _billingAccountRef: "openai-billing-primary",
            _coverageMode: "cumulative",
            _coverageRelationship: "supersedes",
          },
        },
        {
          idempotencyKey: "event-e",
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
      totalEventCount: 3,
      identityMatchedEventCount: 2,
      identityUnattributedEventCount: 1,
      unclassifiedCostEventCount: 1,
      excludedNonKeyScopeEventCount: 1,
    });
    expect(body.coverage.reasons.no_effective_binding).toEqual({ costUsd: 2, eventCount: 1 });
    expect(body.coverage.byIdentity[storedIdentity.id]).toEqual({
      costUsd: 7,
      eventCount: 2,
    });
    expect(JSON.stringify(body)).not.toContain(rawProviderKeyId);
    await prisma.project.delete({ where: { id: project.id } });
    const afterProjectDelete = await (await GET(request("GET"))).json();
    expect(afterProjectDelete.coverage.projectAttributedCostUsd).toBe(3);
    expect(afterProjectDelete.identities[0].bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: null, projectName: "Congress.Trade" }),
      ])
    );

    const storedBinding = await prisma.providerKeyBinding.findFirstOrThrow({
      where: { producerId: "congress-trade" },
    });
    const bindingEnd = new Date();
    expect((await PATCH(request("PATCH", {
      action: "close_binding",
      bindingId: storedBinding.id,
      effectiveTo: bindingEnd.toISOString(),
    }))).status).toBe(200);
    expect((await PATCH(request("PATCH", {
      action: "close_binding",
      bindingId: storedBinding.id,
      effectiveTo: new Date(bindingEnd.getTime() + 1_000).toISOString(),
    }))).status).toBe(409);

    const identityEnd = new Date();
    const retireResponse = await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: storedIdentity.id,
      effectiveTo: identityEnd.toISOString(),
    }));
    expect(retireResponse.status).toBe(200);
    expect((await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: storedIdentity.id,
      effectiveTo: new Date(identityEnd.getTime() + 1_000).toISOString(),
    }))).status).toBe(409);
    expect((await prisma.providerKeyIdentity.findUniqueOrThrow({
      where: { id: storedIdentity.id },
    })).retiredAt).toEqual(identityEnd);
    const afterRetirement = await (await GET(request("GET"))).json();
    expect(afterRetirement.coverage.identityMatchedCostUsd).toBe(7);
    expect(afterRetirement.identities[0].status).toBe("retired");
  });

  it("does not extend an exact producer binding past identity retirement", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const retiredAt = new Date(Math.max(monthStart.getTime() + 120_000, now.getTime() - 120_000));
    const beforeRetirement = new Date(retiredAt.getTime() - 1_000);
    const afterRetirement = new Date(retiredAt.getTime() + 1_000);
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const producerKeyRef = "retired-local-key-ref";
    const identityResponse = await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Retired key",
    }));
    expect(identityResponse.status).toBe(201);
    const identity = await prisma.providerKeyIdentity.findFirstOrThrow();
    await prisma.providerKeyIdentity.update({
      where: { id: identity.id },
      data: { createdAt: monthStart },
    });
    await prisma.providerKeyBinding.create({
      data: {
        identityId: identity.id,
        producerId: "admin-usage-poller",
        producerKeyRef,
        effectiveFrom: monthStart,
      },
    });
    expect((await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: identity.id,
      effectiveTo: retiredAt.toISOString(),
    }))).status).toBe(200);

    await prisma.externalUsageEvent.createMany({
      data: [beforeRetirement, afterRetirement].map((occurredAt, index) => ({
        idempotencyKey: `event-${index}`,
        sourceApp: "admin-usage-poller",
        provider: "openai",
        keyRef: producerKeyRef,
        costUsd: 1,
        occurredAt,
        metadata: {
          _usageTelemetrySchemaVersion: 2,
          _coverageScope: "api_key",
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

  it("rejects a non-atomic overlap and atomically reassigns only the same producer reference", async () => {
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

    const firstBinding = await prisma.providerKeyBinding.findFirstOrThrow();
    const mismatched = await POST(request("POST", {
      action: "create_binding",
      identityId: second.id,
      producerId: "socratic-trade",
      producerKeyRef: "openai-primary",
      replaceBindingId: firstBinding.id,
      effectiveFrom: "2026-07-15T00:00:00.000Z",
    }));
    expect(mismatched.status).toBe(409);
    expect((await prisma.providerKeyBinding.findUniqueOrThrow({
      where: { id: firstBinding.id },
    })).effectiveTo).toBeNull();

    const reassigned = await POST(request("POST", {
      action: "create_binding",
      identityId: second.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      replaceBindingId: firstBinding.id,
      effectiveFrom: "2026-07-15T00:00:00.000Z",
    }));
    expect(reassigned.status).toBe(201);
    expect((await prisma.providerKeyBinding.findUniqueOrThrow({
      where: { id: firstBinding.id },
    })).effectiveTo?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect((await prisma.providerKeyBinding.findMany({ orderBy: { effectiveFrom: "asc" } }))[1]).toMatchObject({
      identityId: second.id,
      effectiveFrom: new Date("2026-07-15T00:00:00.000Z"),
    });
  });
});
