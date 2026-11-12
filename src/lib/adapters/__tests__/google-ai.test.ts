import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiMonitoringConfigFingerprint } from "../../gemini-key-status";
import { fetchUsage } from "../google-ai";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function serviceAccountJson(): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "billing-query-project",
    private_key_id: "test-key-id",
    private_key: privateKey,
    client_email: "usage-monitor@billing-query-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

function oauthScope(body: unknown): string | null {
  const assertion = new URLSearchParams(String(body)).get("assertion");
  if (!assertion) return null;
  const claims = JSON.parse(
    Buffer.from(assertion.split(".")[1], "base64url").toString("utf8")
  ) as { scope?: unknown };
  return typeof claims.scope === "string" ? claims.scope : null;
}

const fields = [
  "project_id",
  "project_number",
  "project_name",
  "sku_id",
  "sku_description",
  "usage_unit",
  "report_through",
  "invalid_rate_rows",
  "net_usd",
  "usage_quantity",
];

function billingRow(projectId: string, netUsd: string, skuId = "sku-1") {
  return {
    f: [
      { v: projectId },
      { v: "123456" },
      { v: "Gemini project" },
      { v: skuId },
      { v: "Gemini 2.5 input" },
      { v: "characters" },
      { v: "2026-07-13 20:00:00+00" },
      { v: "0" },
      { v: netUsd },
      { v: "1200" },
    ],
  };
}

function mockGoogle(options: {
  modelStatus?: number;
  rows?: ReturnType<typeof billingRow>[];
  queryStatus?: number;
  queryCompletesAsync?: boolean;
  tablePending?: boolean;
  includeRateLimitHeaders?: boolean;
  monitoringStatus?: number;
  monitoringRequestCount?: number;
} = {}) {
  const queryRows = options.rows ?? [billingRow("gemini-prod", "8.25")];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
      const suppliedKey = new Headers(init?.headers).get("x-goog-api-key");
      expect(suppliedKey).toBeTruthy();
      expect(url).not.toContain(String(suppliedKey));
      return Promise.resolve(
        jsonResponse(
          options.modelStatus && options.modelStatus !== 200
            ? { error: "invalid key" }
            : { models: [{ name: "gemini" }] },
          options.modelStatus ?? 200,
          options.includeRateLimitHeaders === false
            ? {}
            : { "x-ratelimit-remaining": "90", "x-ratelimit-limit": "100" }
        )
      );
    }
    if (url === "https://oauth2.googleapis.com/token") {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
      return Promise.resolve(jsonResponse({ access_token: "oauth-token" }));
    }
    if (url.startsWith("https://monitoring.googleapis.com/v3/")) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer oauth-token" });
      if (options.monitoringStatus && options.monitoringStatus !== 200) {
        return Promise.resolve(
          jsonResponse({ error: "monitoring forbidden" }, options.monitoringStatus)
        );
      }
      if (url.includes("/projects/gemini-prod/metricDescriptors")) {
        return Promise.resolve(jsonResponse({ metricDescriptors: [] }));
      }
      expect(url).toContain("/projects/gemini-prod/timeSeries");
      const filter = new URL(url).searchParams.get("filter") ?? "";
      if (filter.includes("serviceruntime.googleapis.com/api/request_count")) {
        return Promise.resolve(
          jsonResponse({
            timeSeries: [
              {
                metric: {
                  type: "serviceruntime.googleapis.com/api/request_count",
                  labels: {},
                },
                resource: {
                  type: "consumed_api",
                  labels: {
                    project_id: "gemini-prod",
                    service: "generativelanguage.googleapis.com",
                    location: "global",
                  },
                },
                points: [
                  {
                    interval: { endTime: "2026-07-13T20:00:00Z" },
                    value: {
                      int64Value: String(options.monitoringRequestCount ?? 14),
                    },
                  },
                ],
              },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({ timeSeries: [] }));
    }
    if (url.includes("/datasets/billing_export/tables")) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer oauth-token" });
      if (options.tablePending) {
        return Promise.resolve(jsonResponse({ tables: [] }));
      }
      return Promise.resolve(
        jsonResponse({
          tables: [
            { tableReference: { tableId: "gcp_billing_export_v1_ABCDEF_123456" } },
            { tableReference: { tableId: "gcp_billing_export_resource_v1_ABCDEF_123456" } },
          ],
        })
      );
    }
    if (url.endsWith("/projects/billing-query-project/queries")) {
      const body = JSON.parse(String(init?.body));
      expect(body.maximumBytesBilled).toBe("1073741824");
      expect(body.query).toContain("service.description = 'Gemini API'");
      expect(body.query).toContain("cost_type = 'regular'");
      expect(body.query).toContain("_PARTITIONTIME >= @window_start");
      expect(body.query).toContain("_PARTITIONTIME < @window_end");
      expect(body.query).toContain("ANY_VALUE(project.name)");
      expect(body.query).toContain("GROUP BY project.id, sku.id, usage.pricing_unit");
      expect(body.query).toContain("UNNEST(credits)");
      if (options.queryStatus && options.queryStatus !== 200) {
        return Promise.resolve(jsonResponse({ error: "forbidden" }, options.queryStatus));
      }
      if (options.queryCompletesAsync) {
        return Promise.resolve(
          jsonResponse({
            jobComplete: false,
            jobReference: {
              projectId: "billing-query-project",
              jobId: "job-1",
              location: "US",
            },
          })
        );
      }
      return Promise.resolve(
        jsonResponse({
          jobComplete: true,
          jobReference: {
            projectId: "billing-query-project",
            jobId: "job-1",
            location: "US",
          },
          schema: { fields: fields.map((name) => ({ name })) },
          rows: queryRows,
          totalRows: String(queryRows.length),
        })
      );
    }
    if (url.includes("/projects/billing-query-project/queries/job-1")) {
      expect(url).toContain("location=US");
      return Promise.resolve(
        jsonResponse({
          jobComplete: true,
          jobReference: {
            projectId: "billing-query-project",
            jobId: "job-1",
            location: "US",
          },
          schema: { fields: fields.map((name) => ({ name })) },
          rows: queryRows,
          totalRows: String(queryRows.length),
        })
      );
    }
    return Promise.reject(new Error(`Unexpected Google URL: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("google-ai billing adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:30:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps key-only validation non-billable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ models: [{ name: "gemini" }] }, 200, {
        "x-ratelimit-remaining": "90",
        "x-ratelimit-limit": "100",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("gemini-key");

    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { ok: true, availableModelCount: 1 },
      billing: { configured: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
      "gemini-key"
    );
    expect(String(url)).not.toContain("gemini-key");
  });

  it("persists an invalid key-only outcome before surfacing failure", async () => {
    mockGoogle({ modelStatus: 403 });

    const result = await fetchUsage("invalid-gemini-key");

    expect(result.totalCost).toBeNull();
    expect(result.postPersistError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });
    expect(result.credits).toBeNull();
    expect(result.externalBillingSyncs).toBeUndefined();
    expect(result.rawData).toMatchObject({
      keyValidation: {
        ok: false,
        outcome: "invalid",
        status: 403,
        retryable: false,
        availableModelCount: null,
      },
      billing: { configured: false },
      capabilities: {
        nonBillableKeyValidation: false,
        billingCost: false,
      },
    });
  });

  it("authoritatively clears old-key quota rows when a valid replacement returns no limit header", async () => {
    mockGoogle({ includeRateLimitHeaders: false });

    const result = await fetchUsage("replacement-gemini-key");

    expect(result.rawData).toMatchObject({
      keyValidation: { outcome: "valid", status: 200 },
      rateLimit: { remaining: null, limit: null, reset: null },
    });
    expect(result.externalBillingSyncs).toEqual([
      {
        source: "google-gemini-rate-limits",
        authoritative: true,
        records: [],
      },
    ]);
  });

  it("auto-discovers the standard export and returns exact calendar-month cost", async () => {
    const fetchMock = mockGoogle();

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(result.costScope).toBe("calendar_month_to_date");
    const tokenCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "https://oauth2.googleapis.com/token"
    );
    expect(oauthScope(tokenCall?.[1]?.body)).toBe(
      "https://www.googleapis.com/auth/bigquery.readonly"
    );
    expect(new Date(result.costWindowStart!).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Gemini API",
          amountUsd: 8.25,
          currency: "USD",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          planName: "Gemini 2.5 input",
          usageQuantity: 1200,
          rollupRole: "component",
        }),
      ])
    );
    expect(result.rawData).toMatchObject({
      billing: {
        configured: true,
        status: "ready",
        tableId: "gcp_billing_export_v1_ABCDEF_123456",
        observedProjectCount: 1,
        maximumBytesBilled: 1_073_741_824,
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("resource_v1"))).toBe(false);
  });

  it("adds project request/quota monitoring without changing BigQuery cash cost", async () => {
    mockGoogle({ monitoringRequestCount: 14 });

    const monitoringConfig = {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
      googleProjectId: "gemini-prod",
    };
    const result = await fetchUsage("gemini-key", monitoringConfig);

    expect(result.totalCost).toBe(8.25);
    expect(result.totalRequests).toBe(14);
    expect(result.externalBilling).toMatchObject({
      source: "google-cloud-billing-export:gemini-prod",
      authoritative: true,
    });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "google-gemini-rate-limits",
      "google-cloud-monitoring-requests",
      "google-cloud-monitoring-native-quota-usage",
      "google-cloud-monitoring-native-quota-limits",
    ]);
    expect(result.rawData).toMatchObject({
      billing: { status: "ready" },
      monitoring: {
        configured: true,
        status: "ready",
        projectId: "gemini-prod",
        configFingerprint:
          geminiMonitoringConfigFingerprint(monitoringConfig),
        requests: { status: "ready", total: 14 },
      },
      capabilities: { billingCost: true, monitoringUsage: true },
    });
    expect(result.postPersistError).toBeUndefined();
  });

  it("preserves exact cash cost when Monitoring permissions are denied", async () => {
    mockGoogle({ monitoringStatus: 403 });

    const monitoringConfig = {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
      googleProjectId: "gemini-prod",
    };
    const result = await fetchUsage("gemini-key", monitoringConfig);

    expect(result.totalCost).toBe(8.25);
    expect(result.totalRequests).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "google-cloud-billing-export:gemini-prod",
      authoritative: true,
    });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "google-gemini-rate-limits",
    ]);
    expect(result.rawData).toMatchObject({
      billing: { status: "ready" },
      monitoring: {
        configured: true,
        status: "permission_denied",
        configFingerprint:
          geminiMonitoringConfigFingerprint(monitoringConfig),
        requests: { status: "error", httpStatus: 403 },
      },
      capabilities: { billingCost: true, monitoringUsage: false },
    });
    expect(result.postPersistError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });
  });

  it("supports Monitoring with the shared credential when no billing export is configured", async () => {
    mockGoogle({ monitoringRequestCount: 9 });

    const result = await fetchUsage("gemini-key", {
      serviceAccountJson: serviceAccountJson(),
      googleProjectId: "gemini-prod",
    });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBe(9);
    expect(result.rawData).toMatchObject({
      billing: { configured: false },
      monitoring: { configured: true, status: "ready" },
    });
    expect(result.postPersistError).toBeUndefined();
  });

  it("reports incomplete optional Monitoring configuration without failing key or billing checks", async () => {
    mockGoogle();

    const result = await fetchUsage("gemini-key", {
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { outcome: "valid" },
      billing: { configured: false },
      monitoring: {
        configured: false,
        status: "project_required",
        projectId: null,
      },
    });
    expect(result.postPersistError).toBeUndefined();
  });

  it("keeps authoritative billing when model-list key validation is invalid", async () => {
    mockGoogle({ modelStatus: 401 });

    const result = await fetchUsage("stale-gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(result.postPersistError).toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
      retryable: false,
    });
    expect(result.externalBillingSyncs).toBeUndefined();
    expect(result.rawData).toMatchObject({
      keyValidation: {
        ok: false,
        outcome: "invalid",
        status: 401,
        retryable: false,
      },
      billing: { configured: true, status: "ready" },
    });
  });

  it("keeps billing data when a transient model-list check is unavailable", async () => {
    mockGoogle({ modelStatus: 500 });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(result.externalBilling?.records[0]).toMatchObject({ amountUsd: 8.25 });
    expect(result.rawData).toMatchObject({
      keyValidation: {
        ok: false,
        outcome: "unavailable",
        status: 500,
        retryable: true,
      },
      billing: { configured: true, status: "ready" },
    });
    expect(result.postPersistError).toMatchObject({
      code: "HTTP_ERROR",
      status: 500,
      retryable: true,
    });
  });

  it("keeps billing data when the stored Gemini key is unreadable", async () => {
    const fetchMock = mockGoogle();

    const result = await fetchUsage(
      "",
      {
        billingDataset: "billing-data-project.billing_export",
        serviceAccountJson: serviceAccountJson(),
      },
      {
        apiKeyConfigured: true,
        apiKeyReadable: false,
        secretConfigConfigured: true,
        secretConfigReadable: true,
      }
    );

    expect(result.totalCost).toBe(8.25);
    expect(result.externalBilling?.records[0]).toMatchObject({ amountUsd: 8.25 });
    expect(result.rawData).toMatchObject({
      keyValidation: {
        ok: false,
        outcome: "unreadable",
        credentialFingerprint: null,
      },
      billing: { configured: true, status: "ready" },
    });
    expect(result.postPersistError).toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("https://generativelanguage.googleapis.com/")
      )
    ).toBe(false);
  });

  it("keeps key validation when the stored billing secret is unreadable", async () => {
    const fetchMock = mockGoogle();

    const result = await fetchUsage(
      "gemini-key",
      { billingDataset: "billing-data-project.billing_export" },
      {
        apiKeyConfigured: true,
        apiKeyReadable: true,
        secretConfigConfigured: true,
        secretConfigReadable: false,
      }
    );

    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { ok: true, outcome: "valid", status: 200 },
      billing: {
        configured: true,
        status: "error",
        errorCode: "CONFIGURATION_ERROR",
      },
    });
    expect(result.postPersistError).toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        ["oauth2.googleapis.com", "bigquery.googleapis.com"].includes(
          new URL(String(input)).hostname
        )
      )
    ).toBe(false);
  });

  it("uses the result schema returned after an asynchronous query completes", async () => {
    const fetchMock = mockGoogle({ queryCompletesAsync: true });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/queries/job-1")
      )
    ).toBe(true);
  });

  it("keeps an empty billing export pending instead of inventing zero spend", async () => {
    mockGoogle({ rows: [] });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.costWindowEnd).toBeNull();
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        amountUsd: null,
        status: "pending",
        currentPeriodEnd: null,
        rollupRole: "canonical",
      }),
    ]);
    // The completed query is authoritative about the record inventory even
    // though an empty export cannot prove zero spend. This lets reconciliation
    // prune stale project-scoped placeholders without inventing $0.
    expect(result.externalBilling?.authoritative).toBe(true);
    expect(result.rawData).toMatchObject({
      billing: { configured: true, status: "pending" },
      capabilities: { billingCost: false },
    });
  });

  it("treats an enabled export whose first table is still provisioning as pending", async () => {
    const fetchMock = mockGoogle({ tablePending: true });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.costWindowEnd).toBeNull();
    expect(result.rawData).toMatchObject({
      billing: {
        configured: true,
        status: "pending",
        tableId: null,
        observedProjectCount: 0,
      },
      capabilities: { billingCost: false },
    });
    expect(result.externalBilling).toMatchObject({
      authoritative: false,
      records: [
        expect.objectContaining({
          status: "pending",
          amountUsd: null,
          currentPeriodEnd: null,
        }),
      ],
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/projects/billing-query-project/queries")
      )
    ).toBe(false);
  });

  it("preserves explicit zero when a priced export row nets to zero", async () => {
    mockGoogle({ rows: [billingRow("gemini-prod", "0")] });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(0);
    expect(result.costWindowEnd).toBe("2026-07-13T20:30:00.000Z");
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: 0,
      status: "active",
      rollupRole: "canonical",
    });
  });

  it("fails billing closed when an unscoped export spans multiple projects", async () => {
    mockGoogle({
      rows: [billingRow("gemini-prod", "8.25"), billingRow("gemini-lab", "2.50", "sku-2")],
    });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { outcome: "valid", status: 200 },
      billing: {
        configured: true,
        status: "error",
        errorCode: "CONFIGURATION_ERROR",
      },
    });
    expect(result.postPersistError).toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  });

  it("never converts a billing-query failure into zero cost", async () => {
    mockGoogle({ queryStatus: 403 });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toBeUndefined();
    expect(result.rawData).toMatchObject({
      keyValidation: {
        ok: true,
        outcome: "valid",
        status: 200,
      },
      billing: {
        configured: true,
        status: "error",
        errorCode: "HTTP_ERROR",
        httpStatus: 403,
      },
    });
    expect(result.postPersistError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
    });
  });

  it("surfaces a non-Google token endpoint after preserving key validation", async () => {
    const credential = JSON.parse(serviceAccountJson());
    credential.token_uri = "https://example.com/steal";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: "gemini" }] }))
    );

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: JSON.stringify(credential),
    });

    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { outcome: "valid", status: 200 },
      billing: {
        configured: true,
        status: "error",
        errorCode: "CONFIGURATION_ERROR",
      },
    });
    expect(result.postPersistError).toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  });
});
