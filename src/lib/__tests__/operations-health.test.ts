import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  congressFailedChecks,
  fetchCongressInfrastructureSummary,
  fetchCoolifyFleetSummary,
  fetchOperationsHealth,
  fetchReceiptInboxSummary,
  fetchSocraticInfrastructureSummary,
  isCongressLastResortCheck,
  resetOperationsHealthCacheForTests,
} from "../operations-health";

const ORIGINAL_ENV = { ...process.env };

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    checks: {
      release: {
        sha: "70a2a39df5df8202f3061245f24b7e41b3142728",
        processStartedAt: "2026-08-10T12:00:00.000Z",
        processUptimeSeconds: 7200,
      },
      db: "ok",
      schedulerAgeSeconds: 13,
      tradingLiveness: { activeAccounts: 3, degraded: 0, marketOpen: true },
      dependencies: { fmp: { ok: true }, "alpha-vantage": { ok: false } },
      pineconeConfigured: true,
      ragEmbedProvider: "openrouter",
      openrouterCredits: { ok: true, thresholdUsd: 3 },
      storage: {
        dbSizeBytes: 393469952,
        walSizeBytes: 105954072,
        freeBytes: 55895486464,
        totalBytes: 80290492416,
        litestreamStatus: "replicating",
        litestreamAgeSeconds: 0,
      },
      ...overrides,
    },
  };
}

describe("operations health", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RECEIPT_INBOX_READ_TOKEN;
    // Fleet R2 GraphQL must not fire during these unit tests.
    for (const key of [
      "R2_USAGE_ACCOUNT_ID",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_JAY_ACCOUNT_ID",
      "CLOUDFLARE_JAY_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_FLEET_API_TOKEN",
      "CLOUDFLARE_ST_ACCOUNT_ID",
      "CLOUDFLARE_ST_API_TOKEN",
      "CLOUDFLARE_CT_ACCOUNT_ID",
      "CLOUDFLARE_CT_API_TOKEN",
      "CLOUDFLARE_OLD_ACCOUNT_ID",
      "CLOUDFLARE_OLD_API_TOKEN",
      "LITESTREAM_S3_ENDPOINT",
      "AWS_S3_ENDPOINT",
      "LITESTREAM_S3_ACCESS_KEY_ID",
      "LITESTREAM_S3_SECRET_ACCESS_KEY",
      "LITESTREAM_S3_BUCKET",
      "COOLIFY_SERVER_STATS",
      "COOLIFY_API_TOKEN",
      "COOLIFY_AGENTS",
      "COOLIFY_HOST",
    ]) {
      delete process.env[key];
    }
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns a compact degraded Socratic summary without account or host identifiers", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(healthBody())
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result).toMatchObject({
      state: "degraded",
      database: "ok",
      schedulerAgeSeconds: 13,
      activeTradingAccounts: 3,
      degradedTradingAccounts: 0,
      failedDependencies: ["alpha-vantage"],
      dependencyCount: 2,
      litestreamState: "replicating",
      processUptimeSeconds: 7200,
      recentRestart: false,
      pineconeConfigured: true,
      ragEmbedProvider: "openrouter",
      openrouterCreditsOk: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("accountNumber");
    expect(serialized).not.toContain("135.181.192.190");
  });

  it("does not hard-degrade Peer App Health on a last-resort filingapi 401", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          tradingLiveness: { activeAccounts: 2, degraded: 2, marketOpen: false },
          dataProvidersDegraded: true,
          dependencies: {
            fmp: { ok: true },
            filingapi: { ok: false },
            "usage-monitor": { ok: true },
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.state).toBe("healthy");
    expect(result.failedDependencies).toEqual([]);
    expect(result.marketOpen).toBe(false);
  });

  it("treats congress.trade /api/health as liveness and ignores last-resort pipeline checks", async () => {
    expect(isCongressLastResortCheck("senate_relay")).toBe(true);
    expect(isCongressLastResortCheck("latency_probes")).toBe(true);
    expect(isCongressLastResortCheck("polling_executive")).toBe(true);
    expect(isCongressLastResortCheck("massive-history")).toBe(true);
    expect(isCongressLastResortCheck("ingestion_backlog")).toBe(false);
    expect(
      congressFailedChecks({
        checks: [
          { id: "senate_relay", status: "degraded" },
          { id: "latency_probes", status: "stalled" },
          { id: "polling_executive", status: "stalled" },
          { id: "ingestion_backlog", status: "degraded" },
        ],
      })
    ).toEqual(["ingestion_backlog"]);

    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        db: true,
        schema: true,
        status: "degraded",
        pipeline: {
          status: "degraded",
          checks: [
            { id: "senate_relay", status: "degraded" },
            { id: "latency_probes", status: "stalled" },
            { id: "ingestion_backlog", status: "ok" },
          ],
        },
        build: { sha: "abcdef1234567890", shortSha: "abcdef123456" },
      })
    );
    const result = await fetchCongressInfrastructureSummary();
    expect(result.state).toBe("healthy");
    expect(result.ok).toBe(true);
    expect(result.database).toBe("ok");
    expect(result.failedChecks).toEqual([]);
    expect(result.releaseSha).toBe("abcdef1234567890");
    expect(result.pipelineStatus).toBe("degraded");
  });

  it("paints Congress.Trade degraded only when readiness.ok is false", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, db: false, schema: false, status: "down", missing: ["filings"] }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );
    const result = await fetchCongressInfrastructureSummary();
    expect(result.state).toBe("degraded");
    expect(result.ok).toBe(false);
    expect(result.database).toBe("degraded");
  });

  it("preserves last-good Congress data as stale after an outage", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      Response.json({ ok: true, db: true, schema: true, status: "ok", build: { sha: "abc1234" } })
    );
    const fresh = await fetchCongressInfrastructureSummary();
    expect(fresh.state).toBe("healthy");
    fetchMock.mockRejectedValueOnce(new Error("ct down"));
    const stale = await fetchCongressInfrastructureSummary();
    expect(stale.state).toBe("stale");
    expect(stale.releaseSha).toBe(fresh.releaseSha);
    expect(stale.error).toBe("ct down");
  });

  it("does not hard-degrade Peer App Health on overnight VIX misses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          tradingLiveness: { activeAccounts: 2, degraded: 0, marketOpen: false },
          dataProvidersDegraded: true,
          dependencies: {
            fmp: { ok: true },
            "vix-cboe": { ok: false },
            "vix-yahoo": { ok: false },
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.state).toBe("healthy");
    expect(result.failedDependencies).toEqual([]);
    expect(result.dataProvidersDegraded).toBe(true);
    expect(result.marketOpen).toBe(false);
  });

  it("reads L0 age from tiers and degrades when compaction tiers are wedged", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          dependencies: {},
          storageDegraded: false,
          storage: {
            dbSizeBytes: 1,
            walSizeBytes: 1,
            freeBytes: 1,
            totalBytes: 1,
            litestreamStatus: "replicating",
            litestreamAgeSeconds: null,
            litestreamTiersDegraded: true,
            litestreamTiers: [
              {
                tier: "0",
                label: "Continuous Sync",
                ageSeconds: 2,
                degraded: false,
              },
              { tier: "2", label: "Deep Compaction", degraded: true },
            ],
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.litestreamAgeSeconds).toBe(2);
    expect(result.storageDegraded).toBe(true);
    expect(result.state).toBe("degraded");
  });

  it("preserves last-good Socratic data as explicitly stale after an outage", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce(Response.json(healthBody({ dependencies: {} })));
    const fresh = await fetchSocraticInfrastructureSummary();
    expect(fresh.state).toBe("healthy");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const stale = await fetchSocraticInfrastructureSummary();
    expect(stale.state).toBe("stale");
    expect(stale.releaseSha).toBe(fresh.releaseSha);
    expect(stale.error).toBe("network down");
  });

  it("flags recent process restarts as degraded even when ok is true", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json(
        healthBody({
          dependencies: {},
          release: {
            sha: "06d50e9950c27a9b918a322176f21f3dacb7e0e6",
            processStartedAt: "2026-08-10T23:47:25.801Z",
            processUptimeSeconds: 90,
          },
        })
      )
    );
    const result = await fetchSocraticInfrastructureSummary();
    expect(result.recentRestart).toBe(true);
    expect(result.state).toBe("degraded");
    expect(result.processUptimeSeconds).toBe(90);
  });

  it("lists Coolify applications and server resources when configured", async () => {
    process.env.COOLIFY_SERVER_STATS = "stats-token-with-enough-length";
    process.env.COOLIFY_HOST = "https://host.jays.services";
    process.env.COOLIFY_SERVER_UUID = "mock-coolify-server-uuid";
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/applications")) {
        return Response.json([
          {
            uuid: "mock-st-app-uuid",
            name: "socratic-app",
            status: "running:healthy",
            fqdn: "https://socratictrade.com",
          },
          {
            uuid: "mock-um-app-uuid",
            name: "usage-monitor",
            status: "running:healthy",
            fqdn: "https://usage.jays.services",
          },
        ]);
      }
      if (url.endsWith("/api/v1/servers")) {
        return Response.json([{ uuid: "mockcoolifyserveruuid", name: "fleet-hetzner" }]);
      }
      if (url.includes("/resources")) {
        return Response.json([
          { name: "socratic-app", type: "application", status: "running:healthy" },
          { name: "usage-monitor", type: "application", status: "running:healthy" },
          { name: "congress-trade", type: "application", status: "running:unknown" },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const result = await fetchCoolifyFleetSummary();
    expect(result.configured).toBe(true);
    expect(result.state).toBe("healthy");
    expect(result.applications).toHaveLength(2);
    expect(result.resources).toHaveLength(3);
    expect(result.appsUp).toBe(2);
    expect(result.resources.some((r) => r.name === "congress-trade")).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps Coolify fleet unconfigured without inventing services", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch");
    const result = await fetchCoolifyFleetSummary();
    expect(result.configured).toBe(false);
    expect(result.state).toBe("unconfigured");
    expect(result.applications).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

    it("keeps the receipt inbox visibly unconfigured and makes no receipt request", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async () =>
      Response.json(healthBody())
    );
    const result = await fetchOperationsHealth();
    expect(result.receiptInbox.state).toBe("unconfigured");
    expect(result.receiptInbox.configured).toBe(false);
    expect(result.coolifyFleet.configured).toBe(false);
    expect(result.r2Fleet?.configured).toBe(false);
    expect(result.r2Fleet?.accounts).toHaveLength(4);
    expect(result.fleetBackups).not.toBeNull();
    expect(result.fleetBackups?.apps.map((a) => a.id)).toEqual([
      "usage-monitor",
      "socratic-trade",
      "congress-trade",
    ]);
    // ST + CT peer health URLs plus any backup probe that reuses them.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("socratictrade.com/api/health"))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("congress.trade/api/health"))
    ).toBe(true);
    expect(result.congressInfrastructure.state).toBe("healthy");
  });

  it("single-flights and briefly caches dashboard refreshes across tabs", async () => {
    delete process.env.COOLIFY_SERVER_STATS;
    delete process.env.COOLIFY_API_TOKEN;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async () =>
      Response.json(healthBody({ dependencies: {} }))
    );
    const [first, second] = await Promise.all([fetchOperationsHealth(), fetchOperationsHealth()]);
    expect(first).toBe(second);
    const callsAfterPair = fetchMock.mock.calls.length;
    expect(callsAfterPair).toBeGreaterThanOrEqual(2);
    const third = await fetchOperationsHealth();
    expect(third).toBe(first);
    expect(fetchMock.mock.calls.length).toBe(callsAfterPair);
  });

  it("parses bounded receipt metadata and never returns private content fields", async () => {
    process.env.RECEIPT_INBOX_READ_TOKEN = "r".repeat(32);
    vi.spyOn(global, "fetch").mockResolvedValue(Response.json({
      configured: true,
      status: "receiving",
      needsReviewCount: 1,
      countIsLowerBound: false,
      latestReceivedAt: "2026-07-18T10:00:00.000Z",
      items: [{
        id: "a".repeat(64),
        receivedAt: "2026-07-18T10:00:00.000Z",
        senderDomain: "openai.com",
        senderAuthentication: "passed",
        rawSizeBytes: 1024,
        attachmentCount: 1,
        supportedAttachmentCount: 1,
        bodyEvidence: true,
        quarantineReason: "awaiting_review",
        subject: "Your receipt from OpenRouter $28.24",
        sender: "person@example.com",
        amountUsd: 28.24,
        service: "OpenRouter",
        kind: "usage",
      }],
    }));
    const result = await fetchReceiptInboxSummary();
    expect(result.state).toBe("receiving");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].subject).toBe("Your receipt from OpenRouter $28.24");
    expect(result.items[0].amountUsd).toBe(28.24);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
  });
});

describe("operationsHealthEgressDisabled (Playwright offline kill switch)", () => {
  beforeEach(() => {
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetOperationsHealthCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns unreachable Socratic + Congress summaries without calling fetch", async () => {
    process.env.OPERATIONS_HEALTH_OFFLINE = "true";
    process.env.E2E_TEST_PASSWORD = "visual-test-password";
    // Rejecting stub: if the offline guard ever regresses, the call fails
    // immediately instead of reaching the real Socratic/Congress endpoints.
    const spy = vi
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("fetch must not be called in offline mode"));
    const socratic = await fetchSocraticInfrastructureSummary();
    const congress = await fetchCongressInfrastructureSummary();
    expect(socratic.state).toBe("unreachable");
    expect(congress.state).toBe("unreachable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires the Playwright-only marker: the flag alone does not disable egress", async () => {
    process.env.OPERATIONS_HEALTH_OFFLINE = "true";
    delete process.env.E2E_TEST_PASSWORD;
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(Response.json(healthBody()));
    const result = await fetchSocraticInfrastructureSummary();
    expect(spy).toHaveBeenCalled();
    expect(result.state).not.toBe("unreachable");
  });

  it("skips the receipt inbox and Coolify egress too", async () => {
    process.env.OPERATIONS_HEALTH_OFFLINE = "true";
    process.env.E2E_TEST_PASSWORD = "visual-test-password";
    process.env.RECEIPT_INBOX_READ_TOKEN = "r".repeat(32);
    process.env.COOLIFY_API_TOKEN = "c".repeat(32);
    const spy = vi
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("fetch must not be called in offline mode"));
    const receiptInbox = await fetchReceiptInboxSummary();
    const coolify = await fetchCoolifyFleetSummary();
    expect(spy).not.toHaveBeenCalled();
    expect(receiptInbox.state).toBe("unconfigured");
    expect(receiptInbox.items).toEqual([]);
    expect(coolify.state).toBe("unconfigured");
    expect(coolify.applications).toEqual([]);
  });
});
