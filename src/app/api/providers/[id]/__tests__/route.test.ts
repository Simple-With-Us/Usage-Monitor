import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let testDir: string;
let PUT: typeof import("../route").PUT;
let GET: typeof import("../route").GET;
let DELETE: typeof import("../route").DELETE;
let GET_COLLECTION: typeof import("../../route").GET;
let POST_COLLECTION: typeof import("../../route").POST;
let POST_FETCH: typeof import("../fetch/route").POST;
let prisma: typeof import("@/lib/prisma").prisma;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let decryptJson: typeof import("@/lib/crypto").decryptJson;
let encrypt: typeof import("@/lib/crypto").encrypt;
let geminiApiKeyFingerprint: typeof import("@/lib/gemini-key-status").geminiApiKeyFingerprint;
let geminiBillingConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiBillingConfigFingerprint;
let geminiMonitoringConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiMonitoringConfigFingerprint;
let deactivateDecommissionedBuiltInProviders: typeof import("@/lib/provider-retirement").deactivateDecommissionedBuiltInProviders;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "33".repeat(32);
  setupPrismaSqliteTestDb(dbPath);

  ({ GET, PUT, DELETE } = await import("../route"));
  ({ GET: GET_COLLECTION, POST: POST_COLLECTION } = await import("../../route"));
  ({ POST: POST_FETCH } = await import("../fetch/route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ encrypt, encryptJson, decryptJson } = await import("@/lib/crypto"));
  ({
    geminiApiKeyFingerprint,
    geminiBillingConfigFingerprint,
    geminiMonitoringConfigFingerprint,
  } = await import("@/lib/gemini-key-status"));
  ({ deactivateDecommissionedBuiltInProviders } = await import("@/lib/provider-retirement"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
});

beforeEach(async () => {
  await prisma.providerKeyBinding.deleteMany();
  await prisma.providerKeyIdentity.deleteMany();
  await prisma.provider.deleteMany();
});

describe("DELETE /api/providers/:id attribution history", () => {
  it("requires deactivation instead of deleting a provider with key identity history", async () => {
    const provider = await prisma.provider.create({
      data: { name: "openai", displayName: "OpenAI", type: "builtin" },
    });
    await prisma.providerKeyIdentity.create({
      data: { providerId: provider.id, alias: "Historical key" },
    });

    const response = await DELETE(
      new NextRequest(`https://usage.jays.services/api/providers/${provider.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(409);
    expect(await prisma.provider.count({ where: { id: provider.id } })).toBe(1);
    expect(await prisma.providerKeyIdentity.count({ where: { providerId: provider.id } })).toBe(1);
  });
});

describe("retired built-in provider boundaries", () => {
  it("rejects new dormant/retired built-ins and does not create a row", async () => {
    for (const name of ["tradier", "intrinio", "alpaca", "robinhood", "vercel", "firecrawl"]) {
      const response = await POST_COLLECTION(
        new NextRequest("https://usage.jays.services/api/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, displayName: name, type: "builtin" }),
        })
      );
      expect(response.status, name).toBe(409);
    }
    const customAlias = await POST_COLLECTION(
      new NextRequest("https://usage.jays.services/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Vercel", displayName: "Custom Vercel", type: "custom" }),
      })
    );
    expect(customAlias.status).toBe(409);
    expect(await prisma.provider.count()).toBe(0);
  });

  it("deactivates legacy rows without deleting their snapshots", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "InTrInIo",
        displayName: "Intrinio (legacy)",
        type: "builtin",
        snapshots: { create: { fetchedAt: new Date(), totalCost: 12.34 } },
      },
    });

    expect(await deactivateDecommissionedBuiltInProviders()).toBe(1);
    expect(await deactivateDecommissionedBuiltInProviders()).toBe(0);
    expect(await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } }))
      .toMatchObject({ isActive: false });
    expect(await prisma.usageSnapshot.count({ where: { providerId: provider.id } })).toBe(1);
  });

  it("never permits a retired canonical name to be reactivated through a custom type", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "vercel",
        displayName: "Vercel (legacy)",
        type: "custom",
        isActive: false,
      },
    });

    const response = await PUT(updateRequest(provider.id, { isActive: true }), {
      params: Promise.resolve({ id: provider.id }),
    });
    expect(response.status).toBe(409);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })).isActive)
      .toBe(false);
  });
});

function updateRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`https://usage.jays.services/api/providers/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function managedBinding() {
  return {
    scope: "st-primary",
    source: "st-primary",
    providerName: "google-ai",
    sequence: 17,
    status: "active",
    fingerprint: createHash("sha256").update("managed-key").digest("hex"),
  };
}

describe("Infisical-managed provider API boundaries", () => {
  it("returns only safe ownership metadata and redacts key/binding details", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "SocraticTrade.com · Primary account",
        apiKey: encrypt("managed-key"),
        secretConfig: encryptJson({ infisicalCredential: managedBinding() }),
      },
    });

    const response = await GET(new NextRequest("https://usage.jays.services"), {
      params: Promise.resolve({ id: provider.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.keyPreview).toBe("manage...-key");
    expect(body.credentialManagement).toEqual({
      source: "infisical",
      scope: "st-primary",
      label: "SocraticTrade.com · Primary account",
      status: "active",
      alias: false,
      readOnlyFields: ["apiKey", "isActive", "label"],
    });
    expect(body.secretConfigMeta.fields).not.toContain("infisicalCredential.sequence");
    expect(JSON.stringify(body)).not.toContain("managed-key");
    expect(JSON.stringify(body)).not.toContain(managedBinding().fingerprint);
    expect(JSON.stringify(body)).not.toContain("sequence");
  });

  it("blocks managed-field edits and deletion while allowing unrelated config", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "SocraticTrade.com · Primary account",
        apiKey: encrypt("managed-key"),
        secretConfig: encryptJson({ infisicalCredential: managedBinding() }),
      },
    });

    for (const body of [
      { apiKey: "replacement" },
      { isActive: false },
      { label: "manual" },
      { config: null },
    ]) {
      const response = await PUT(updateRequest(provider.id, body), {
        params: Promise.resolve({ id: provider.id }),
      });
      expect(response.status).toBe(409);
    }
    const unrelated = await PUT(
      updateRequest(provider.id, { config: { googleProjectId: "billing-project" } }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(unrelated.status).toBe(200);
    expect(decryptJson((await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    })).secretConfig!)).toMatchObject({ infisicalCredential: managedBinding() });

    const deleted = await DELETE(
      new NextRequest(`https://usage.jays.services/api/providers/${provider.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(deleted.status).toBe(409);
    expect(await prisma.provider.count({ where: { id: provider.id } })).toBe(1);
  });

  it("rejects browser claims to management metadata on create and update", async () => {
    const create = await POST_COLLECTION(
      new NextRequest("https://usage.jays.services/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "google-ai",
          displayName: "Injected",
          type: "builtin",
          config: { Infisical_Credential: managedBinding() },
        }),
      })
    );
    expect(create.status).toBe(400);

    const ordinary = await prisma.provider.create({
      data: { name: "deepseek", displayName: "DeepSeek", type: "builtin" },
    });
    const update = await PUT(
      updateRequest(ordinary.id, {
        config: { nested: { infisicalCredential: managedBinding() } },
      }),
      { params: Promise.resolve({ id: ordinary.id }) }
    );
    expect(update.status).toBe(400);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: ordinary.id } })).secretConfig)
      .toBeNull();
  });

  it("blocks a manual fetch for an inactive identical-credential alias", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "SocraticTrade.com · Primary account",
        isActive: false,
        apiKey: encrypt("managed-key"),
        secretConfig: encryptJson({
          infisicalCredential: {
            ...managedBinding(),
            aliasOfProviderId: "existing-identical-provider",
          },
        }),
      },
    });

    const response = await POST_FETCH(
      new NextRequest(`https://usage.jays.services/api/providers/${provider.id}/fetch`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(response.status).toBe(409);
    expect(await prisma.usageSnapshot.count({ where: { providerId: provider.id } }))
      .toBe(0);
  });

  it("fails closed for malformed bindings and unreadable managed-label envelopes", async () => {
    const malformed = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Malformed managed",
        type: "builtin",
        label: "unexpected-label",
        apiKey: encrypt("must-stay-redacted"),
        secretConfig: encryptJson({
          infisicalCredential: {
            ...managedBinding(),
            sequence: "not-an-integer",
          },
        }),
      },
    });
    const malformedGet = await GET(
      new NextRequest("https://usage.jays.services"),
      { params: Promise.resolve({ id: malformed.id }) }
    );
    const malformedBody = await malformedGet.json();
    expect(malformedBody.credentialManagement).toBeNull();
    expect(malformedBody.keyPreview).toBeNull();
    expect(JSON.stringify(malformedBody)).not.toContain("must-stay-redacted");
    expect((await PUT(updateRequest(malformed.id, { apiKey: "replacement" }), {
      params: Promise.resolve({ id: malformed.id }),
    })).status).toBe(409);
    expect((await DELETE(
      new NextRequest(`https://usage.jays.services/api/providers/${malformed.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: malformed.id }) }
    )).status).toBe(409);

    const unreadable = await prisma.provider.create({
      data: {
        name: "deepseek",
        displayName: "Unreadable managed",
        type: "builtin",
        label: "SocraticTrade.com · Primary account",
        apiKey: encrypt("also-must-stay-redacted"),
        secretConfig: "not-an-encrypted-envelope",
      },
    });
    const unreadableGet = await GET(
      new NextRequest("https://usage.jays.services"),
      { params: Promise.resolve({ id: unreadable.id }) }
    );
    const unreadableBody = await unreadableGet.json();
    expect(unreadableBody.credentialManagement).toBeNull();
    expect(unreadableBody.keyPreview).toBeNull();
    expect(unreadableBody.secretConfigMeta.readable).toBe(false);
    expect(JSON.stringify(unreadableBody)).not.toContain("also-must-stay-redacted");
    expect((await PUT(updateRequest(unreadable.id, { isActive: false }), {
      params: Promise.resolve({ id: unreadable.id }),
    })).status).toBe(409);
    expect((await DELETE(
      new NextRequest(`https://usage.jays.services/api/providers/${unreadable.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: unreadable.id }) }
    )).status).toBe(409);
  });
});

describe("PUT /api/providers/:id secret config operations", () => {
  it("disconnects Google billing while preserving unrelated public and secret config", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        refreshIntervalMin: 60,
        config: {
          billingDataset: "billing-project.billing_export",
          googleProjectId: "gemini-production",
          billingTable: "gcp_billing_export_v1_ABC",
          statusKeyRef: "gemini-primary",
        },
        secretConfig: encryptJson({
          serviceAccountJson: "service-account-secret",
          adminApiKey: "unrelated-admin-secret",
          nested: { password: "unrelated-nested-secret" },
        }),
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        config: { statusKeyRef: "gemini-primary" },
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: {
        config: true,
        secretConfig: true,
        alertConfigGeneration: true,
      },
    });
    expect(stored.config).toEqual({ statusKeyRef: "gemini-primary" });
    expect(decryptJson(stored.secretConfig!)).toEqual({
      adminApiKey: "unrelated-admin-secret",
      nested: { password: "unrelated-nested-secret" },
    });
    expect(stored.alertConfigGeneration).toBe(1);
  });

  it("can clear the service account without replacing public config", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        refreshIntervalMin: 60,
        config: { billingDataset: "billing-project.billing_export" },
        secretConfig: encryptJson({
          serviceAccountJson: "service-account-secret",
          apiToken: "keep-token",
        }),
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: {
        config: true,
        secretConfig: true,
        alertConfigGeneration: true,
      },
    });
    expect(stored.config).toEqual({
      billingDataset: "billing-project.billing_export",
    });
    expect(decryptJson(stored.secretConfig!)).toEqual({ apiToken: "keep-token" });
    expect(stored.alertConfigGeneration).toBe(1);
  });

  it("increments the alert revision for API-key and config capability edits", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });

    const apiKeyResponse = await PUT(
      updateRequest(provider.id, { apiKey: "sk-ant-admin01-primary-test" }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(apiKeyResponse.status).toBe(200);
    expect(
      await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })
    ).toMatchObject({ alertConfigGeneration: 1 });

    const configResponse = await PUT(
      updateRequest(provider.id, {
        config: { adminApiKey: "sk-ant-admin01-secondary-test" },
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(configResponse.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: { alertConfigGeneration: true, secretConfig: true },
    });
    expect(stored.alertConfigGeneration).toBe(2);
    expect(decryptJson(stored.secretConfig!)).toEqual({
      adminApiKey: "sk-ant-admin01-secondary-test",
    });
  });

  it("increments the alert revision atomically with alert-affecting provider edits", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "alert-revision",
        displayName: "Alert Revision",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { lowBalanceUsd: 10 } },
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        isActive: false,
        refreshIntervalMin: 120,
        plan: { lowBalanceUsd: 5 },
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      include: { plan: true },
    });
    expect(stored).toMatchObject({
      isActive: false,
      refreshIntervalMin: 120,
      alertConfigGeneration: 1,
      plan: { lowBalanceUsd: 5 },
    });
  });
});

describe("GET /api/providers/:id Gemini key status", () => {
  it("returns sanitized current-key health without exposing snapshot raw data", async () => {
    const apiKey = "test-current-google-cloud-console-key";
    const billingConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      serviceAccountJson: "test-service-account-json",
    };
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        apiKey: encrypt(apiKey),
        config: {
          billingDataset: billingConfig.billingDataset,
          googleProjectId: billingConfig.googleProjectId,
        },
        secretConfig: encryptJson({
          serviceAccountJson: billingConfig.serviceAccountJson,
        }),
        refreshIntervalMin: 60,
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-14T23:00:00.000Z"),
            rawData: {
              keyValidation: {
                ok: true,
                status: 200,
                availableModelCount: 50,
                credentialFingerprint: geminiApiKeyFingerprint(apiKey),
                upstreamBody: "must-not-be-returned",
              },
              billing: {
                configured: true,
                status: "pending",
                configFingerprint:
                  geminiBillingConfigFingerprint(billingConfig),
                privateBillingPayload: "must-not-be-returned",
              },
              monitoring: {
                configured: true,
                status: "permission_denied",
                projectId: "gemini-production",
                configFingerprint:
                  geminiMonitoringConfigFingerprint(billingConfig),
                requests: {
                  status: "error",
                  errorCode: "HTTP_ERROR",
                  httpStatus: 403,
                  retryable: false,
                  upstreamBody: "must-not-be-returned",
                },
              },
            },
          },
        },
        externalBilling: {
          create: [
            {
              source: "google-cloud-billing-export",
              externalId: "gemini-mtd:prior-config",
              kind: "billing_period",
              serviceName: "Gemini API",
              status: "active",
              amountUsd: 91.25,
              currency: "USD",
              syncedAt: new Date("2026-07-14T22:00:00.000Z"),
            },
            {
              source: "google-gemini-rate-limits",
              externalId: "gemini-api-key",
              kind: "account",
              planName: "Gemini API quota",
              status: "active",
              requestLimit: 100,
              syncedAt: new Date("2026-07-14T22:00:00.000Z"),
            },
          ],
        },
      },
    });
    // Pushed quota/credit status creates a newer snapshot without adapter
    // rawData; it must remain the latest chart row without erasing the last
    // credential/billing check.
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-14T23:05:00.000Z"),
        totalRequests: 123,
      },
    });

    const response = await GET(
      new NextRequest(
        `https://usage.jays.services/api/providers/${provider.id}`
      ),
      { params: Promise.resolve({ id: provider.id }) }
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.geminiKeyStatus).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 50,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.geminiBillingStatus).toEqual({
      state: "pending",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.geminiMonitoringStatus).toEqual({
      state: "permission_denied",
      projectId: "gemini-production",
      errorCode: "HTTP_ERROR",
      httpStatus: 403,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.latestSnapshot.fetchedAt).toBe("2026-07-14T23:05:00.000Z");
    expect(body.latestSnapshot.totalRequests).toBe(123);
    expect(body.latestSnapshot).not.toHaveProperty("rawData");
    expect(body.externalBilling).toEqual([
      expect.objectContaining({
        source: "google-gemini-rate-limits",
        externalId: "gemini-api-key",
      }),
    ]);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("must-not-be-returned");
    expect(serialized).not.toContain(geminiApiKeyFingerprint(apiKey));
    expect(serialized).not.toContain(
      geminiMonitoringConfigFingerprint(billingConfig)
    );

    const collectionResponse = await GET_COLLECTION(
      new NextRequest("http://localhost/api/providers")
    );
    const collectionBody = await collectionResponse.json();
    const collectionSerialized = JSON.stringify(collectionBody);
    const collectionProvider = collectionBody.find(
      (entry: { id?: unknown }) => entry.id === provider.id
    );
    expect(collectionResponse.status).toBe(200);
    expect(collectionSerialized).not.toContain(
      geminiMonitoringConfigFingerprint(billingConfig)
    );
    expect(collectionProvider.externalBilling).toEqual([
      expect.objectContaining({
        source: "google-gemini-rate-limits",
        externalId: "gemini-api-key",
      }),
    ]);
  });
});

describe("provider billing account identity API boundaries", () => {
  it("stores only a keyed identity, matches explicit accounts, and never returns the digest", async () => {
    const billingAccountId = "org_owner_confirmed_exact_123";
    const create = async (displayName: string, apiKey: string) => {
      const response = await POST_COLLECTION(
        new NextRequest("https://usage.jays.services/api/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "openai",
            displayName,
            type: "builtin",
            apiKey,
            billingAccountId,
          }),
        })
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain(billingAccountId);
      expect(JSON.stringify(body)).not.toMatch(/hmac-sha256:[0-9a-f]{64}/);
      return body as { id: string };
    };

    const first = await create("OpenAI A", "sk-project-a");
    const second = await create("OpenAI B", "sk-project-b");
    const stored = await prisma.provider.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { billingAccountIdentity: true },
    });
    expect(stored).toHaveLength(2);
    expect(stored[0].billingAccountIdentity).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(stored[0].billingAccountIdentity).toBe(
      stored[1].billingAccountIdentity
    );
    expect(stored[0].billingAccountIdentity).not.toContain(billingAccountId);

    const collectionResponse = await GET_COLLECTION(
      new NextRequest("https://usage.jays.services/api/providers")
    );
    const collection = await collectionResponse.json();
    const byId = new Map(
      collection.map((row: { id: string }) => [row.id, row])
    );
    const firstPublic = byId.get(first.id) as {
      billingAccount: { matchKey: string; evidence: string };
      billingAccountIdentityConfigured: boolean;
    };
    const secondPublic = byId.get(second.id) as typeof firstPublic;
    expect(firstPublic.billingAccount).toEqual(secondPublic.billingAccount);
    expect(firstPublic.billingAccount.evidence).toBe("explicit_account");
    expect(firstPublic.billingAccountIdentityConfigured).toBe(true);
    const serialized = JSON.stringify(collection);
    expect(serialized).not.toContain(billingAccountId);
    expect(serialized).not.toMatch(/hmac-sha256:[0-9a-f]{64}/);
  });

  it("clears an explicit identity without returning its prior keyed value", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        apiKey: encrypt("sk-project-a"),
        billingAccountIdentity: `hmac-sha256:${"ab".repeat(32)}`,
      },
    });
    const response = await PUT(
      updateRequest(provider.id, { billingAccountId: null }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(
      /hmac-sha256:[0-9a-f]{64}/
    );
    expect(
      (await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } }))
        .billingAccountIdentity
    ).toBeNull();
  });
});

describe("GET /api/providers alert visibility", () => {
  it("keeps budget alerts visible without snapshot noise for blind providers", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "fmp",
        displayName: "FMP",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            billingMode: "actual",
            fixedMonthlyCostUsd: 15,
            monthlyBudgetUsd: 10,
          },
        },
      },
    });

    const detailResponse = await GET(
      new NextRequest(
        `https://usage.jays.services/api/providers/${provider.id}`
      ),
      { params: Promise.resolve({ id: provider.id }) }
    );
    const detailBody = await detailResponse.json();

    expect(detailResponse.status).toBe(200);
    expect(detailBody.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "budget_exceeded" }),
      ])
    );
    expect(detailBody.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );

    const collectionResponse = await GET_COLLECTION(
      new NextRequest("http://localhost/api/providers")
    );
    const collectionBody = await collectionResponse.json();
    const collectionProvider = collectionBody.find(
      (entry: { id?: unknown }) => entry.id === provider.id
    );

    expect(collectionResponse.status).toBe(200);
    expect(collectionProvider.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "budget_exceeded" }),
      ])
    );
    expect(collectionProvider.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );
  });
});
