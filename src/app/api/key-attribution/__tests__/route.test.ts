import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "test-attribution-key-material-longer-than-32-characters";
  delete process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS;
  await prisma.providerKeyBinding.deleteMany();
  await prisma.providerKeyIdentity.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.project.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
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
    let storedIdentity = await prisma.providerKeyIdentity.findFirstOrThrow();
    storedIdentity = await prisma.providerKeyIdentity.update({
      where: { id: storedIdentity.id },
      data: { createdAt: monthStart },
    });
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

    const { parseUsageTelemetryBatch } = await import("@/lib/usage-telemetry");
    const [spoofedV1] = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "openai",
      metricType: "cost",
      keyRef: "configured-openai-primary",
      costUsd: 200,
      occurredAt: eventTime.toISOString(),
      idempotencyKey: "event-f-spoofed-coverage-metadata",
      metadata: {
        _usageTelemetrySchemaVersion: 2,
        _coverageDeclared: true,
        _coverageScope: "api_key",
        _coverageMode: "point",
        _coverageRelationship: "disjoint",
      },
    });

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
            _coverageDeclared: true,
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
          // Boundsless window cost is not proven additive — stay unclassified.
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageDeclared: true,
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
          occurredAt: eventTime,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageDeclared: true,
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
            _coverageDeclared: true,
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
        {
          idempotencyKey: "event-f-spoofed-coverage-metadata",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "configured-openai-primary",
          costUsd: 200,
          occurredAt: eventTime,
          // A v1 producer attempted to forge both the v2 and coverage markers;
          // normalization strips all monitor-owned authority before persistence.
          metadata: spoofedV1.metadata,
        },
      ],
    });

    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.coverage).toMatchObject({
      scope: "pushed_v2_cost_events",
      aggregation: "proven_disjoint_point_or_window_event_sum",
      // event-b (boundsless window) and event-d (non-key scope) are unclassified.
      // Sanitized v1 event-f cannot enter the pushed-v2 coverage scan at all.
      totalCostUsd: 7,
      identityMatchedCostUsd: 7,
      identityUnattributedCostUsd: 0,
      projectAttributedCostUsd: 3,
      projectUnattributedCostUsd: 4,
      totalEventCount: 2,
      identityMatchedEventCount: 2,
      identityUnattributedEventCount: 0,
      unclassifiedCostEventCount: 2,
      excludedNonKeyScopeEventCount: 1,
    });
    expect(body.coverage.byIdentity[storedIdentity.id]).toEqual({
      costUsd: 7,
      eventCount: 2,
    });
    // Boundsless window still surfaces in discovery with zero additive cost.
    expect(body.coverage.unattributedBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producerKeyRef: "unknown-key",
          reason: "no_effective_binding",
          costUsd: 0,
          eventCount: 1,
          unclassifiedCostEventCount: 1,
        }),
      ])
    );
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

  it("rehashes an identity fingerprint through HMAC rotation so previous keys can be removed", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const rawProviderKeyId = "stable-provider-key-id-for-rehash";
    const oldKey = "old-attribution-key-material-longer-than-32-characters";
    const newKey = "new-attribution-key-material-longer-than-32-characters";
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = oldKey;
    expect((await POST(request("POST", {
      action: "create_identity",
      providerId: provider.id,
      alias: "Rotate me",
      providerReportedKeyId: rawProviderKeyId,
    }))).status).toBe(201);
    const identity = await prisma.providerKeyIdentity.findFirstOrThrow();
    await prisma.providerKeyIdentity.update({
      where: { id: identity.id },
      data: { createdAt: monthStart },
    });
    const oldFingerprint = identity.providerReportedKeyIdFingerprint;
    expect(oldFingerprint).toMatch(/^[a-f0-9]{64}$/);

    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = newKey;
    process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS = oldKey;
    const rehash = await POST(request("POST", {
      action: "rehash_identity",
      identityId: identity.id,
      providerReportedKeyId: rawProviderKeyId,
    }));
    expect(rehash.status).toBe(200);
    const rehashed = await prisma.providerKeyIdentity.findUniqueOrThrow({
      where: { id: identity.id },
    });
    expect(rehashed.providerReportedKeyIdFingerprint).not.toBe(oldFingerprint);
    expect(JSON.stringify(rehashed)).not.toContain(rawProviderKeyId);

    delete process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS;
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = newKey;
    // After previous keys are dropped, resolution still matches via the rehashed digest.
    const { resolveProviderKeyAttribution, fingerprintProviderReportedKeyId } = await import(
      "@/lib/provider-key-attribution"
    );
    expect(rehashed.providerReportedKeyIdFingerprint).toBe(
      fingerprintProviderReportedKeyId(provider.id, rawProviderKeyId)
    );
    expect(
      resolveProviderKeyAttribution(
        {
          providerName: "openai",
          producerId: "congress-trade",
          producerKeyRef: null,
          providerConnectionRef: null,
          billingAccountRef: null,
          providerReportedKeyId: rawProviderKeyId,
          occurredAt: new Date(),
        },
        [
          {
            id: rehashed.id,
            providerId: provider.id,
            providerName: "openai",
            status: rehashed.status,
            createdAt: rehashed.createdAt,
            retiredAt: rehashed.retiredAt,
            providerReportedKeyIdFingerprint: rehashed.providerReportedKeyIdFingerprint,
          },
        ],
        []
      )
    ).toMatchObject({ status: "matched", identityId: rehashed.id });

    expect((await POST(request("POST", {
      action: "rehash_identity",
      identityId: identity.id,
      providerReportedKeyId: "wrong-raw-id",
    }))).status).toBe(409);
  });

  it("rejects rehash collisions across every current and previous fingerprint path", async () => {
    const oldKey = "old-attribution-key-material-longer-than-32-characters";
    const newKey = "new-attribution-key-material-longer-than-32-characters";
    const rawProviderKeyId = "same-logical-provider-key";
    const { fingerprintProviderReportedKeyId } = await import("@/lib/provider-key-attribution");
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = oldKey;
    const providers = await Promise.all(
      ["openai", "anthropic", "mistral"].map((name) =>
        prisma.provider.create({
          data: { name, displayName: name, type: "builtin" },
        })
      )
    );
    const oldFingerprints = providers.map((provider) =>
      fingerprintProviderReportedKeyId(provider.id, rawProviderKeyId)
    );
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = newKey;
    process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS = oldKey;
    const currentFingerprints = providers.map((provider) =>
      fingerprintProviderReportedKeyId(provider.id, rawProviderKeyId)
    );

    const oldTarget = await prisma.providerKeyIdentity.create({
      data: {
        providerId: providers[0].id,
        alias: "Old target",
        providerReportedKeyIdFingerprint: oldFingerprints[0],
      },
    });
    await prisma.providerKeyIdentity.create({
      data: {
        providerId: providers[0].id,
        alias: "Current sibling",
        providerReportedKeyIdFingerprint: currentFingerprints[0],
      },
    });
    const currentTarget = await prisma.providerKeyIdentity.create({
      data: {
        providerId: providers[1].id,
        alias: "Current target",
        providerReportedKeyIdFingerprint: currentFingerprints[1],
      },
    });
    await prisma.providerKeyIdentity.create({
      data: {
        providerId: providers[1].id,
        alias: "Old sibling",
        providerReportedKeyIdFingerprint: oldFingerprints[1],
      },
    });
    const nullTarget = await prisma.providerKeyIdentity.create({
      data: { providerId: providers[2].id, alias: "Null target" },
    });
    await prisma.providerKeyIdentity.create({
      data: {
        providerId: providers[2].id,
        alias: "Old sibling for null",
        providerReportedKeyIdFingerprint: oldFingerprints[2],
      },
    });

    for (const target of [oldTarget, currentTarget, nullTarget]) {
      expect((await POST(request("POST", {
        action: "rehash_identity",
        identityId: target.id,
        providerReportedKeyId: rawProviderKeyId,
      }))).status).toBe(409);
    }
    expect((await prisma.providerKeyIdentity.findUniqueOrThrow({
      where: { id: oldTarget.id },
    })).providerReportedKeyIdFingerprint).toBe(oldFingerprints[0]);
    expect((await prisma.providerKeyIdentity.findUniqueOrThrow({
      where: { id: currentTarget.id },
    })).providerReportedKeyIdFingerprint).toBe(currentFingerprints[1]);
    expect((await prisma.providerKeyIdentity.findUniqueOrThrow({
      where: { id: nullTarget.id },
    })).providerReportedKeyIdFingerprint).toBeNull();
  });

  it("preserves never-started future bindings as canceled history without blocking replacements", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const retiredAt = new Date("2026-07-15T00:00:00.000Z");
    const futureStart = new Date("2026-08-01T00:00:00.000Z");
    const retiredIdentity = await prisma.providerKeyIdentity.create({
      data: {
        providerId: provider.id,
        alias: "Future mapping",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const replacementIdentity = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Replacement after retire" },
    });
    await prisma.providerKeyBinding.create({
      data: {
        identityId: retiredIdentity.id,
        producerId: "congress-trade",
        producerKeyRef: "openai-primary",
        effectiveFrom: futureStart,
      },
    });

    expect((await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: retiredIdentity.id,
      effectiveTo: retiredAt.toISOString(),
    }))).status).toBe(200);

    expect(await prisma.providerKeyBinding.count({
      where: { identityId: retiredIdentity.id },
    })).toBe(1);
    expect(await prisma.providerKeyBinding.findFirstOrThrow({
      where: { identityId: retiredIdentity.id },
    })).toMatchObject({ effectiveFrom: futureStart, effectiveTo: futureStart });

    const history = await (await GET(request("GET"))).json();
    expect(history.identities.find((candidate: { id: string }) => candidate.id === retiredIdentity.id)
      ?.bindings).toEqual([
        expect.objectContaining({
          effectiveFrom: futureStart.toISOString(),
          effectiveTo: futureStart.toISOString(),
        }),
      ]);

    const createResponse = await POST(request("POST", {
      action: "create_binding",
      identityId: replacementIdentity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      effectiveFrom: retiredAt.toISOString(),
    }));
    expect(createResponse.status).toBe(201);
  });

  it("keeps identity cost but fails project coverage closed on authority conflict", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const occurredAt = new Date(Math.max(monthStart.getTime() + 60_000, now.getTime() - 60_000));
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const [eventProject, bindingProject] = await Promise.all([
      prisma.project.create({ data: { name: "Event project" } }),
      prisma.project.create({ data: { name: "Binding project" } }),
    ]);
    const identity = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Conflicted project key", createdAt: monthStart },
    });
    await prisma.providerKeyBinding.create({
      data: {
        identityId: identity.id,
        projectId: bindingProject.id,
        projectName: bindingProject.name,
        producerId: "congress-trade",
        producerKeyRef: "openai-primary",
        effectiveFrom: monthStart,
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "project-authority-conflict",
        sourceApp: "congress-trade",
        provider: "openai",
        keyRef: "openai-primary",
        projectId: eventProject.id,
        costUsd: 4,
        occurredAt,
        metadata: {
          _usageTelemetrySchemaVersion: 2,
          _coverageDeclared: true,
          _coverageScope: "api_key",
          _coverageMode: "point",
          _coverageRelationship: "disjoint",
        },
      },
    });

    const body = await (await GET(request("GET"))).json();
    expect(body.coverage.identityMatchedCostUsd).toBe(4);
    expect(body.coverage.byIdentity[identity.id]).toEqual({ costUsd: 4, eventCount: 1 });
    expect(body.coverage.projectAttributedCostUsd).toBe(0);
    expect(body.coverage.projectUnattributedCostUsd).toBe(4);
    expect(body.coverage.projectAuthorityConflictCostUsd).toBe(4);
    expect(body.coverage.projectAuthorityConflictEventCount).toBe(1);
  });

  it("allows two exact context-constrained bindings on the same identity and effectiveFrom", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const identity = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Multi-context key" },
    });
    const effectiveFrom = "2026-07-01T00:00:00.000Z";
    const first = await POST(request("POST", {
      action: "create_binding",
      identityId: identity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      providerConnectionRef: "org-a",
      billingAccountRef: "bill-a",
      effectiveFrom,
    }));
    const second = await POST(request("POST", {
      action: "create_binding",
      identityId: identity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      providerConnectionRef: "org-b",
      billingAccountRef: "bill-b",
      effectiveFrom,
    }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.providerKeyBinding.count()).toBe(2);

    // Same context still collides.
    expect((await POST(request("POST", {
      action: "create_binding",
      identityId: identity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      providerConnectionRef: "org-a",
      billingAccountRef: "bill-a",
      effectiveFrom,
    }))).status).toBe(409);
  });

  it("leaves window cost unclassified when the window spans a binding reassignment", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const isEarlyInMonth = (now.getTime() - monthStart.getTime()) < 3 * 86_400_000;
    const reassignmentAt = isEarlyInMonth
      ? new Date(now.getTime() - 60_000)
      : new Date(now.getTime() - 3 * 86_400_000);
    const windowStart = new Date(reassignmentAt.getTime() - 120_000);
    const windowEnd = isEarlyInMonth
      ? new Date(now.getTime() - 10_000)
      : new Date(reassignmentAt.getTime() + 2 * 86_400_000);
    const eventTime = new Date(windowEnd.getTime() - 1_000);
    const pointControlTime = new Date(windowEnd.getTime() - 500);
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const first = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Before cutover", createdAt: monthStart },
    });
    const second = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "After cutover", createdAt: monthStart },
    });
    await prisma.providerKeyBinding.createMany({
      data: [
        {
          identityId: first.id,
          producerId: "congress-trade",
          producerKeyRef: "openai-primary",
          effectiveFrom: monthStart,
          effectiveTo: reassignmentAt,
        },
        {
          identityId: second.id,
          producerId: "congress-trade",
          producerKeyRef: "openai-primary",
          effectiveFrom: reassignmentAt,
        },
      ],
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "spanning-window",
        sourceApp: "congress-trade",
        provider: "openai",
        keyRef: "openai-primary",
        costUsd: 12,
        occurredAt: eventTime,
        windowStart,
        windowEnd,
        metadata: {
          _usageTelemetrySchemaVersion: 2,
          _coverageDeclared: true,
          _coverageScope: "api_key",
          _coverageMode: "window",
          _coverageRelationship: "disjoint",
        },
      },
    });
    // Non-spanning point control in the same period.
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "point-control",
        sourceApp: "congress-trade",
        provider: "openai",
        keyRef: "openai-primary",
        costUsd: 1,
        occurredAt: pointControlTime,
        metadata: {
          _usageTelemetrySchemaVersion: 2,
          _coverageDeclared: true,
          _coverageScope: "api_key",
          _coverageMode: "point",
          _coverageRelationship: "disjoint",
        },
      },
    });

    const body = await (await GET(request("GET"))).json();
    expect(body.coverage.totalCostUsd).toBe(1);
    expect(body.coverage.identityMatchedCostUsd).toBe(1);
    expect(body.coverage.unclassifiedCostEventCount).toBe(1);
    expect(body.coverage.byIdentity[second.id]).toEqual({ costUsd: 1, eventCount: 1 });
  });

  it("attributes point costs at each event timestamp across a binding reassignment", async () => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const isEarlyInMonth = (now.getTime() - monthStart.getTime()) < 2 * 86_400_000;
    const reassignmentAt = isEarlyInMonth
      ? new Date(now.getTime() - 60_000)
      : new Date(Math.max(monthStart.getTime() + 60_000, now.getTime() - 2 * 86_400_000));
    const before = new Date(reassignmentAt.getTime() - 30_000);
    const after = new Date(Math.min(reassignmentAt.getTime() + 30_000, now.getTime() - 1_000));
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const first = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Before cutover", createdAt: monthStart },
    });
    const second = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "After cutover", createdAt: monthStart },
    });
    await prisma.providerKeyBinding.createMany({
      data: [
        {
          identityId: first.id,
          producerId: "congress-trade",
          producerKeyRef: "openai-primary",
          effectiveFrom: monthStart,
          effectiveTo: reassignmentAt,
        },
        {
          identityId: second.id,
          producerId: "congress-trade",
          producerKeyRef: "openai-primary",
          effectiveFrom: reassignmentAt,
        },
      ],
    });
    await prisma.externalUsageEvent.createMany({
      data: [
        {
          idempotencyKey: "point-before-reassignment",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "openai-primary",
          costUsd: 2,
          occurredAt: before,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageDeclared: true,
            _coverageScope: "api_key",
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
        {
          idempotencyKey: "point-after-reassignment",
          sourceApp: "congress-trade",
          provider: "openai",
          keyRef: "openai-primary",
          costUsd: 3,
          occurredAt: after,
          metadata: {
            _usageTelemetrySchemaVersion: 2,
            _coverageDeclared: true,
            _coverageScope: "api_key",
            _coverageMode: "point",
            _coverageRelationship: "disjoint",
          },
        },
      ],
    });

    const body = await (await GET(request("GET"))).json();
    expect(body.coverage.totalCostUsd).toBe(5);
    expect(body.coverage.identityMatchedCostUsd).toBe(5);
    expect(body.coverage.byIdentity[first.id]).toEqual({ costUsd: 2, eventCount: 1 });
    expect(body.coverage.byIdentity[second.id]).toEqual({ costUsd: 3, eventCount: 1 });
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
          _coverageDeclared: true,
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

  it("clamps future-dated bindings when retiring an identity so replacements do not overlap", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    const effectiveFrom = new Date("2026-07-01T00:00:00.000Z");
    const scheduledEnd = new Date("2026-08-01T00:00:00.000Z");
    const retiredAt = new Date("2026-07-15T00:00:00.000Z");
    const retiredIdentity = await prisma.providerKeyIdentity.create({
      data: {
        providerId: provider.id,
        alias: "Soon retired",
        createdAt: effectiveFrom,
      },
    });
    const replacementIdentity = await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Replacement" },
    });
    await prisma.providerKeyBinding.create({
      data: {
        identityId: retiredIdentity.id,
        producerId: "congress-trade",
        producerKeyRef: "openai-primary",
        effectiveFrom,
        effectiveTo: scheduledEnd,
      },
    });

    expect((await PATCH(request("PATCH", {
      action: "retire_identity",
      identityId: retiredIdentity.id,
      effectiveTo: retiredAt.toISOString(),
    }))).status).toBe(200);

    const clamped = await prisma.providerKeyBinding.findFirstOrThrow({
      where: { identityId: retiredIdentity.id },
    });
    expect(clamped.effectiveTo).toEqual(retiredAt);

    const createResponse = await POST(request("POST", {
      action: "create_binding",
      identityId: replacementIdentity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      effectiveFrom: retiredAt.toISOString(),
    }));
    expect(createResponse.status).toBe(201);
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

    const otherProvider = await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "builtin" },
    });
    const otherProviderIdentity = await prisma.providerKeyIdentity.create({
      data: { providerId: otherProvider.id, alias: "Other provider key" },
    });
    const sameProducerRefOnOtherProvider = await POST(request("POST", {
      action: "create_binding",
      identityId: otherProviderIdentity.id,
      producerId: "congress-trade",
      producerKeyRef: "openai-primary",
      effectiveFrom: "2026-07-15T00:00:00.000Z",
    }));
    expect(sameProducerRefOnOtherProvider.status).toBe(201);
  });
});
