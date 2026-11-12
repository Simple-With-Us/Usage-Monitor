import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// GET /api/providers is the dashboard's (and Settings/Connections') primary
// data source, polled on mount and on an interval. It previously selected
// each provider's latest snapshot WITH the full adapter rawData JSON blob
// (39 providers x large per-provider raw API payloads), plus ran the exact
// same full-provider-with-rawData query a SECOND time inside
// computeBudgetStatus(), plus a THIRD, differently-scoped rawData read via
// budget-status.ts's latestCostSnapshots - all under the app's
// connection_limit=1 single SQLite connection. That DB read/JSON-parse volume
// is what OOM-crashed the 512MB Render instance. These tests guard the fix:
// the response must keep every field the client reads, no full rawData blob
// may flow through the query/response pipeline for every provider, AND the
// Gemini rawData reads must stay bounded to the latest snapshot per Gemini
// provider (never re-widening to read every retained blob).
let GET: typeof import("../route").GET;
let prisma: typeof import("@/lib/prisma").prisma;
let encrypt: typeof import("@/lib/crypto").encrypt;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let managedApiKeyFingerprint: typeof import("@/lib/crypto").managedApiKeyFingerprint;
let geminiApiKeyFingerprint: typeof import("@/lib/gemini-key-status").geminiApiKeyFingerprint;
let geminiBillingConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiBillingConfigFingerprint;
let geminiMonitoringConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiMonitoringConfigFingerprint;

let testDir: string;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-list-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  setupPrismaSqliteTestDb(dbPath);

  ({ GET } = await import("../route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ encrypt, encryptJson, managedApiKeyFingerprint } = await import("@/lib/crypto"));
  ({
    geminiApiKeyFingerprint,
    geminiBillingConfigFingerprint,
    geminiMonitoringConfigFingerprint,
  } = await import("@/lib/gemini-key-status"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
});

beforeEach(async () => {
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/providers - rawData exclusion and cost-coverage caveat", () => {
  it("matches distinct OpenAI operational keys only when their authoritative Admin billing key matches", async () => {
    const sharedAdminKey = "sk-admin-shared-organization";
    const first = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI (Socratic Trade)",
        type: "builtin",
        apiKey: encrypt("sk-project-socratic"),
        secretConfig: encryptJson({ adminApiKey: sharedAdminKey }),
        groupId: "openai",
      },
    });
    const second = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI (Congress.Trade)",
        type: "builtin",
        apiKey: encrypt("sk-project-congress"),
        secretConfig: encryptJson({ adminApiKey: sharedAdminKey }),
        groupId: "openai",
      },
    });
    const distinct = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI (Other org)",
        type: "builtin",
        apiKey: encrypt("sk-project-other"),
        secretConfig: encryptJson({ adminApiKey: "sk-admin-other-org" }),
        groupId: "openai",
      },
    });
    const sameOperationalDifferentAdmin = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI (Same project key, other org)",
        type: "builtin",
        apiKey: encrypt("sk-project-socratic"),
        secretConfig: encryptJson({ adminApiKey: "sk-admin-third-org" }),
        groupId: "openai",
      },
    });
    const unreadable = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI (Unreadable config)",
        type: "builtin",
        apiKey: encrypt("sk-project-socratic"),
        secretConfig: "not-an-encrypted-envelope",
        groupId: "openai",
      },
    });

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const byId = new Map(body.map((entry: { id: string }) => [entry.id, entry]));
    const firstMatch = (byId.get(first.id) as { billingAccount: unknown }).billingAccount;
    const secondMatch = (byId.get(second.id) as { billingAccount: unknown }).billingAccount;
    const distinctMatch = (byId.get(distinct.id) as { billingAccount: unknown }).billingAccount;
    const sameOperationalDifferentAdminMatch = (
      byId.get(sameOperationalDifferentAdmin.id) as { billingAccount: unknown }
    ).billingAccount;
    const unreadableMatch = (
      byId.get(unreadable.id) as { billingAccount: unknown }
    ).billingAccount;
    const serialized = JSON.stringify(body);

    expect(firstMatch).toEqual(secondMatch);
    expect(firstMatch).toEqual(
      expect.objectContaining({ evidence: "shared_credential" })
    );
    expect(distinctMatch).not.toEqual(firstMatch);
    expect(sameOperationalDifferentAdminMatch).not.toEqual(firstMatch);
    expect(unreadableMatch).toBeNull();
    expect(serialized).not.toContain(sharedAdminKey);
    expect(serialized).not.toContain("sk-project-");
    expect(serialized).not.toMatch(/hmac-sha256:[0-9a-f]{64}/);

    const secondResponse = await GET(
      new NextRequest("http://localhost/api/providers")
    );
    const secondBody = await secondResponse.json();
    const secondById = new Map(
      secondBody.map((entry: { id: string }) => [entry.id, entry])
    );
    expect(
      (secondById.get(first.id) as { billingAccount: { matchKey: string } })
        .billingAccount.matchKey
    ).not.toBe((firstMatch as { matchKey: string }).matchKey);
  });

  it("omits zero and unused component rows only from the compact dashboard view", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "twilio",
        displayName: "Twilio",
        type: "builtin",
        refreshIntervalMin: 60,
        externalBilling: {
          create: [
            {
              source: "twilio-usage-records",
              externalId: "zero-component",
              kind: "billing_period",
              amountUsd: 0,
              usageQuantity: 0,
              currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
              currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
              rollupRole: "component",
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
            {
              source: "twilio-usage-records",
              externalId: "charged-component",
              kind: "billing_period",
              amountUsd: 1.5,
              usageQuantity: 1,
              rollupRole: "component",
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
            {
              source: "twilio-usage-records",
              externalId: "canonical-total",
              kind: "billing_period",
              amountUsd: 0,
              rollupRole: "canonical",
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
            {
              source: "twilio-usage-records",
              externalId: "depleted-quota",
              kind: "account",
              remainingQuantity: 0,
              rollupRole: "metadata",
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
            {
              source: "provider-account",
              externalId: "active-plan",
              kind: "plan",
              planName: "Pro",
              status: "active",
              rollupRole: "metadata",
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
            {
              source: "legacy-detail",
              externalId: "legacy-zero",
              kind: "billing_period",
              amountUsd: 0,
              usageQuantity: 0,
              rollupRole: null,
              syncedAt: new Date("2026-07-18T00:00:00.000Z"),
            },
          ],
        },
      },
    });

    const compactResponse = await GET(
      new NextRequest("https://usage.jays.services/api/providers?view=dashboard")
    );
    const compactBody = await compactResponse.json();
    const compact = compactBody.find((entry: { id: string }) => entry.id === provider.id);

    expect(compact.externalBilling.map((record: { externalId: string }) => record.externalId)).toEqual([
      "active-plan",
      "canonical-total",
      "charged-component",
      "depleted-quota",
    ]);
    expect(compact.externalBillingHiddenCount).toBe(2);

    const fullResponse = await GET(
      new NextRequest("http://localhost/api/providers")
    );
    const fullBody = await fullResponse.json();
    const full = fullBody.find((entry: { id: string }) => entry.id === provider.id);
    expect(full.externalBilling).toHaveLength(6);
    expect(full.externalBillingHiddenCount).toBe(0);
  });

  it("never ships the rawData blob but still surfaces the derived costCoverageCaveat", async () => {
    // A ~60KB filler blob stands in for a real adapter's raw API response
    // (the thing that made this endpoint's DB read/response heavy at 39
    // providers). It must never reach the client.
    const secretMarker = "must-not-leave-the-server-boundary";
    const bigFiller = secretMarker.repeat(2000);

    const flagged = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-16T12:00:00.000Z"),
            totalCost: 12.5,
            rawData: {
              filler: bigFiller,
              __apiUsageMonitor: {
                version: 1,
                costCoverageCaveat: {
                  code: "cloudflare_paygo_usage_unavailable",
                  message: "PayGo usage could not be reached; totalCost may be understated.",
                },
              },
            },
          },
        },
      },
    });

    const plain = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        refreshIntervalMin: 60,
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-16T12:05:00.000Z"),
            totalCost: 4,
            totalRequests: 10,
            credits: null,
            balance: 7.5,
          },
        },
      },
    });

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    // The marker (and thus the whole rawData blob it's embedded in) must
    // never appear in the response body.
    expect(serialized).not.toContain(secretMarker);
    // A sanity ceiling: two providers' worth of real response fields should
    // be a couple KB at most - nowhere near the 60KB+ the raw blob alone
    // would add if it leaked through.
    expect(serialized.length).toBeLessThan(20_000);

    const flaggedEntry = body.find((p: { id: string }) => p.id === flagged.id);
    const plainEntry = body.find((p: { id: string }) => p.id === plain.id);

    expect(flaggedEntry.costCoverageCaveat).toEqual({
      code: "cloudflare_paygo_usage_unavailable",
      message: "PayGo usage could not be reached; totalCost may be understated.",
    });
    expect(flaggedEntry.latestSnapshot).not.toHaveProperty("rawData");
    expect(flaggedEntry.latestSnapshot.totalCost).toBe(12.5);

    // No caveat metadata on this snapshot -> null, not a thrown error or a
    // leaked raw value.
    expect(plainEntry.costCoverageCaveat).toBeNull();
    expect(plainEntry.latestSnapshot).toMatchObject({
      balance: 7.5,
      totalCost: 4,
      totalRequests: 10,
      credits: null,
      fetchedAt: "2026-07-16T12:05:00.000Z",
    });
    expect(plainEntry.latestSnapshot).not.toHaveProperty("rawData");
    expect(plainEntry.latestSnapshot).not.toHaveProperty("id");
  });

  it("returns null costCoverageCaveat for a provider with no snapshot at all", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    expect(entry.costCoverageCaveat).toBeNull();
    expect(entry.latestSnapshot).toBeNull();
  });
});

describe("GET /api/providers - managed key previews", () => {
  it("uses each managed row's own key for a masked preview without exposing the key or binding", async () => {
    const firstKey = "alpha-managed-one1";
    const secondKey = "bravo-managed-two2";
    const binding = (fingerprint: string) => ({
      scope: "ct",
      source: "ct",
      providerName: "llamaindex",
      keyFingerprint: fingerprint,
    });
    const [first, second] = await Promise.all(
      [firstKey, secondKey].map((apiKey) =>
        prisma.provider.create({
          data: {
            name: "llamaindex",
            displayName: "LlamaIndex",
            type: "builtin",
            apiKey: encrypt(apiKey),
            secretConfig: encryptJson({
              infisicalCredential: binding(managedApiKeyFingerprint(apiKey)),
            }),
          },
        })
      )
    );

    const response = await GET(
      new NextRequest("https://usage.jays.services/api/providers")
    );
    const body = await response.json();
    const firstEntry = body.find((entry: { id: string }) => entry.id === first.id);
    const secondEntry = body.find((entry: { id: string }) => entry.id === second.id);
    const serialized = JSON.stringify(body);

    expect(firstEntry.keyPreview).toBe("alpha-...one1");
    expect(secondEntry.keyPreview).toBe("bravo-...two2");
    // The preview comes from its own encrypted row; neither full key nor the
    // stable server-only fingerprint reaches clients.
    expect(serialized).not.toContain(firstKey);
    expect(serialized).not.toContain(secondKey);
    expect(serialized).not.toContain("keyFingerprint");
  });
});

describe("GET /api/providers - batched Gemini status (no per-provider N+1)", () => {
  it("derives Gemini key/billing/monitoring status from the LATEST snapshot per provider, sanitized", async () => {
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
          create: [
            // Older snapshot with a DIFFERENT (stale) key fingerprint - the
            // batched query must not accidentally pick this one.
            {
              fetchedAt: new Date("2026-07-14T20:00:00.000Z"),
              rawData: {
                keyValidation: {
                  ok: true,
                  status: 200,
                  availableModelCount: 1,
                  credentialFingerprint: "0".repeat(64),
                  upstreamBody: "must-not-be-returned",
                },
              },
            },
            // Latest snapshot with rawData - this is the one that must win.
            {
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
                  configFingerprint: geminiBillingConfigFingerprint(billingConfig),
                  privateBillingPayload: "must-not-be-returned",
                },
                monitoring: {
                  configured: true,
                  status: "permission_denied",
                  projectId: "gemini-production",
                  configFingerprint: geminiMonitoringConfigFingerprint(billingConfig),
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
            // Newest snapshot of all, but with no rawData (e.g. a
            // quota/credit-only push) - must not erase the last real check.
            {
              fetchedAt: new Date("2026-07-14T23:05:00.000Z"),
              totalRequests: 123,
            },
          ],
        },
      },
    });

    // A second, unrelated non-Gemini provider makes sure the batched query's
    // providerId filter/dedup doesn't cross-contaminate between providers.
    await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "builtin", refreshIntervalMin: 60 },
    });

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const serialized = JSON.stringify(body);
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    expect(entry.geminiKeyStatus).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 50,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.geminiBillingStatus).toEqual({
      state: "pending",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.geminiMonitoringStatus).toEqual({
      state: "permission_denied",
      projectId: "gemini-production",
      errorCode: "HTTP_ERROR",
      httpStatus: 403,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.latestSnapshot.fetchedAt).toBe("2026-07-14T23:05:00.000Z");
    expect(entry.latestSnapshot.totalRequests).toBe(123);
    expect(serialized).not.toContain("must-not-be-returned");
    expect(serialized).not.toContain(apiKey);
  });
});

describe("GET /api/providers - budget-status Gemini cost-identity quarantine (scoped rawData)", () => {
  it("quarantines a cost snapshot from a stale billing config, using only that snapshot's own rawData", async () => {
    // computeBudgetStatus() (called from this route) picks the "latest
    // snapshot with non-null rawData" for geminiBillingStatus and,
    // SEPARATELY, the "latest snapshot with a cost this month" for
    // geminiCostIdentityStatus - these can legitimately be two different
    // rows. budget-status.ts now fetches rawData for only that second,
    // cost-specific snapshot id (scoped to Gemini providers) instead of
    // selecting it for every provider's cost snapshot; this test proves
    // that scoping still finds and evaluates the RIGHT row.
    const currentConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-current-project",
      serviceAccountJson: "current-service-account-json",
    };
    const staleConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-old-project",
      serviceAccountJson: "old-service-account-json",
    };

    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        config: {
          billingDataset: currentConfig.billingDataset,
          googleProjectId: currentConfig.googleProjectId,
        },
        secretConfig: encryptJson({
          serviceAccountJson: currentConfig.serviceAccountJson,
        }),
        refreshIntervalMin: 60,
        snapshots: {
          create: [
            // The only cost-bearing snapshot this month - written under the
            // OLD billing configuration. This is what latestCostByProviderId
            // will pick for this provider.
            {
              fetchedAt: new Date("2026-07-10T00:00:00.000Z"),
              totalCost: 50,
              rawData: {
                billing: {
                  configured: true,
                  status: "ready",
                  configFingerprint: geminiBillingConfigFingerprint(staleConfig),
                },
              },
            },
            // A newer, non-cost-bearing snapshot under the CURRENT
            // configuration - this is what geminiStatusSnapshots (the
            // separate "latest any-rawData snapshot" query) will pick.
            {
              fetchedAt: new Date("2026-07-12T00:00:00.000Z"),
              rawData: {
                billing: {
                  configured: true,
                  status: "ready",
                  configFingerprint: geminiBillingConfigFingerprint(currentConfig),
                },
              },
            },
          ],
        },
      },
    });

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    // The $50 from the stale-config snapshot must be quarantined out of
    // spend, not silently charged to the current configuration - proving
    // geminiCostIdentityStatus still correctly reads the SPECIFIC
    // cost-snapshot's rawData (fetched via the new scoped
    // geminiCostRawDataById lookup in budget-status.ts) rather than the
    // general "latest any-rawData snapshot" used for geminiBillingStatus
    // (which is left "ready" here on purpose, to isolate the two).
    expect(entry.snapshotCostUsd).toBeNull();
    expect(entry.spentUsd).toBe(0);
    expect(entry.spendCoverage).not.toBe("complete");
  });
});

describe("GET /api/providers - Gemini rawData reads stay bounded (no re-unbounding)", () => {
  it("materializes at most one rawData blob per Gemini provider even with many retained snapshots", async () => {
    // Regression guard for the OOM class this PR kills. A single Gemini
    // provider accumulates many retained non-null-rawData snapshots (45-day
    // retention x 15-min polling). The CORRECT implementation reads only the
    // latest snapshot's rawData per Gemini provider (bounded findFirst =
    // LIMIT 1); a regression to an unbounded `findMany(where providerId in
    // gemini)` would materialize and JSON-parse ALL of them. Both the route
    // itself AND computeBudgetStatus() (invoked by the route) read Gemini
    // rawData, so a single GET() exercises - and this test guards - both.
    const apiKey = "gemini-bounded-key";
    const billingConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      serviceAccountJson: "bounded-service-account-json",
    };
    const RETAINED = 12;
    // Distinct large filler per snapshot so an unbounded read is unambiguously
    // heavier; the marker also lets us assert no raw blob leaks to the client.
    const olderSnapshots = Array.from({ length: RETAINED }, (_, i) => ({
      fetchedAt: new Date(Date.UTC(2026, 5, i + 1)),
      totalCost: i,
      rawData: {
        filler: `retained-blob-${i}-`.repeat(400),
        keyValidation: {
          ok: true,
          status: 200,
          availableModelCount: 1,
          // Stale fingerprint - only the LATEST snapshot carries the current
          // one, so "reads the latest" is also asserted behaviorally below.
          credentialFingerprint: "0".repeat(64),
        },
      },
    }));
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
          create: [
            ...olderSnapshots,
            {
              fetchedAt: new Date("2026-07-14T23:00:00.000Z"),
              totalCost: 999,
              rawData: {
                keyValidation: {
                  ok: true,
                  status: 200,
                  availableModelCount: 77,
                  credentialFingerprint: geminiApiKeyFingerprint(apiKey),
                },
              },
            },
          ],
        },
      },
    });

    const findManySpy = vi.spyOn(prisma.usageSnapshot, "findMany");
    const findFirstSpy = vi.spyOn(prisma.usageSnapshot, "findFirst");

    const response = await GET(new NextRequest("http://localhost/api/providers"));
    const body = await response.json();
    const serialized = JSON.stringify(body);
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    // Count how many rawData-bearing rows every UsageSnapshot query actually
    // returned across the whole request. Bounded reads keep this at O(Gemini
    // providers); an unbounded providerId findMany would return all RETAINED.
    const countRawRows = async (
      spy: ReturnType<typeof vi.spyOn>
    ): Promise<number> => {
      let total = 0;
      for (let i = 0; i < spy.mock.calls.length; i++) {
        const args = spy.mock.calls[i][0] as
          | { select?: { rawData?: unknown } }
          | undefined;
        if (!args?.select?.rawData) continue;
        const value = await spy.mock.results[i].value;
        total += Array.isArray(value) ? value.length : value ? 1 : 0;
      }
      return total;
    };
    const rawRowsRead =
      (await countRawRows(findManySpy)) + (await countRawRows(findFirstSpy));

    expect(response.status).toBe(200);
    // 1 Gemini provider. Expected bounded rawData reads: route.ts status
    // findFirst (1) + budget-status.ts status findFirst (1) + budget-status.ts
    // geminiCostRawData findMany by snapshot id (<=1) = at most 3, regardless
    // of the 13 retained snapshots. The threshold sits far below RETAINED so
    // any re-unbounding (which would read >=12) fails loudly.
    expect(rawRowsRead).toBeLessThanOrEqual(3);
    expect(rawRowsRead).toBeLessThan(RETAINED);

    // Behavioral proof it read the LATEST snapshot (current fingerprint),
    // not an arbitrary/all-of-them result.
    expect(entry.geminiKeyStatus).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 77,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    // And no retained raw blob leaked into the response.
    expect(serialized).not.toContain("retained-blob-");
  });
});
