import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleCloudMonitoring } from "../google-cloud-monitoring";

const REQUEST_COUNT = "serviceruntime.googleapis.com/api/request_count";
const TOKEN_USAGE =
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_2_input_token_count/usage";
const TOKEN_LIMIT =
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_2_input_token_count/limit";
const REQUEST_USAGE =
  "generativelanguage.googleapis.com/quota/generate_requests_per_model/usage";
const REQUEST_LIMIT =
  "generativelanguage.googleapis.com/quota/generate_requests_per_model/limit";
const LOCATION_RESOURCE = "generativelanguage.googleapis.com/Location";
const PROJECT_ID = "gemini-production";
const SERVICE = "generativelanguage.googleapis.com";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function config() {
  return {
    googleProjectId: PROJECT_ID,
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "billing-query-project",
      private_key_id: "test-key-id",
      private_key: privateKey,
      client_email:
        "usage-monitor@billing-query-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function point(value: number, endTime = "2026-07-13T20:00:00Z") {
  return {
    interval: { endTime },
    value: { int64Value: String(value) },
  };
}

function series(input: {
  metricType: string;
  resourceType: "consumed_api" | typeof LOCATION_RESOURCE;
  metricLabels?: Record<string, string>;
  resourceLabels?: Record<string, string>;
  omitProjectLabel?: boolean;
  points: Array<ReturnType<typeof point>>;
}) {
  const native = input.resourceType === LOCATION_RESOURCE;
  return {
    metric: { type: input.metricType, labels: input.metricLabels ?? {} },
    resource: {
      type: input.resourceType,
      labels: {
        ...(!input.omitProjectLabel
          ? native
            ? { resource_container: PROJECT_ID }
            : { project_id: PROJECT_ID }
          : {}),
        ...(native ? {} : { service: SERVICE }),
        location: "global",
        ...input.resourceLabels,
      },
    },
    points: input.points,
  };
}

function descriptor(
  type: string,
  metricKind: "DELTA" | "GAUGE",
  displayName = "Gemini quota"
) {
  return {
    type,
    metricKind,
    valueType: "INT64",
    displayName,
    monitoredResourceTypes: [LOCATION_RESOURCE],
    labels: [{ key: "limit_name" }, { key: "model" }],
  };
}

const CURRENT_DESCRIPTORS = [
  descriptor(TOKEN_USAGE, "DELTA", "Paid tier 2 input token quota usage"),
  descriptor(TOKEN_LIMIT, "GAUGE", "Paid tier 2 input token quota limit"),
  descriptor(REQUEST_USAGE, "DELTA", "Requests per model quota usage"),
  descriptor(REQUEST_LIMIT, "GAUGE", "Requests per model quota limit"),
];

function decodeJwtClaims(body: unknown): Record<string, unknown> {
  const assertion = new URLSearchParams(String(body)).get("assertion");
  expect(assertion).toBeTruthy();
  return JSON.parse(
    Buffer.from(assertion!.split(".")[1], "base64url").toString("utf8")
  );
}

function metricFromUrl(url: URL): string {
  const filter = url.searchParams.get("filter") ?? "";
  const match = filter.match(/metric\.type = "([^"]+)"/);
  if (!match) throw new Error(`Missing exact metric filter: ${filter}`);
  return match[1];
}

interface StubOptions {
  descriptors?: unknown[];
  descriptorResponder?: (url: URL) => Response | Promise<Response>;
  timeSeriesResponder?: (
    metric: string,
    url: URL
  ) => Response | Promise<Response>;
}

function stubMonitoring(options: StubOptions = {}) {
  const fetchMock = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const value = String(input);
      if (value === "https://oauth2.googleapis.com/token") {
        expect(init?.method).toBe("POST");
        const claims = decodeJwtClaims(init?.body);
        expect(claims.scope).toBe(
          "https://www.googleapis.com/auth/monitoring.read"
        );
        expect(String(init?.body)).not.toContain("PRIVATE KEY");
        return Promise.resolve(jsonResponse({ access_token: "monitoring-token" }));
      }
      const url = new URL(value);
      expect(url.origin).toBe("https://monitoring.googleapis.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer monitoring-token"
      );
      if (url.pathname.endsWith("/metricDescriptors")) {
        expect(url.pathname).toBe(
          `/v3/projects/${PROJECT_ID}/metricDescriptors`
        );
        expect(url.searchParams.get("filter")).toBe(
          'metric.type = starts_with("generativelanguage.googleapis.com/quota/")'
        );
        expect(url.searchParams.get("activeOnly")).toBe("true");
        expect(url.searchParams.get("pageSize")).toBe("1000");
        return Promise.resolve(
          options.descriptorResponder?.(url) ??
            jsonResponse({
              metricDescriptors: options.descriptors ?? CURRENT_DESCRIPTORS,
            })
        );
      }
      expect(url.pathname).toBe(`/v3/projects/${PROJECT_ID}/timeSeries`);
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.searchParams.get("view")).toBe("FULL");
      const filter = url.searchParams.get("filter") ?? "";
      expect(filter).toContain(`project = "${PROJECT_ID}"`);
      const metric = metricFromUrl(url);
      if (metric === REQUEST_COUNT) {
        expect(filter).toContain(`resource.labels.service = "${SERVICE}"`);
      } else {
        expect(filter).toContain(`resource.type = "${LOCATION_RESOURCE}"`);
        expect(filter).not.toContain("resource.labels.service");
      }
      return Promise.resolve(
        options.timeSeriesResponder?.(metric, url) ??
          jsonResponse({ timeSeries: [] })
      );
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google Cloud Monitoring Gemini enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:30:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads current native model/tier/location quotas and keeps request_count as aggregate fallback", async () => {
    const fetchMock = stubMonitoring({
      timeSeriesResponder: (metric, url) => {
        if (metric === REQUEST_COUNT) {
          expect(url.searchParams.get("aggregation.perSeriesAligner")).toBe(
            "ALIGN_SUM"
          );
          expect(url.searchParams.get("aggregation.crossSeriesReducer")).toBe(
            "REDUCE_SUM"
          );
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_COUNT,
                resourceType: "consumed_api",
                // Reducers can remove project_id; the explicit project
                // selector remains the authoritative scope.
                omitProjectLabel: true,
                resourceLabels: {
                  credential_id: "must-not-be-retained",
                  method: "GenerateContent",
                },
                points: [point(10), point(5, "2026-07-12T20:00:00Z")],
              }),
            ],
          });
        }
        if (metric === TOKEN_USAGE) {
          expect(url.searchParams.get("interval.startTime")).toBe(
            "2026-07-01T00:00:00.000Z"
          );
          expect(url.searchParams.get("aggregation.perSeriesAligner")).toBe(
            "ALIGN_SUM"
          );
          return jsonResponse({
            timeSeries: [
              series({
                metricType: TOKEN_USAGE,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "InputTokensPerMinute",
                  method: "GenerateContent",
                  model: "gemini-2.5-pro",
                },
                points: [point(100), point(50, "2026-07-12T20:00:00Z")],
              }),
              series({
                metricType: TOKEN_USAGE,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "InputTokensPerMinute",
                  model: "gemini-2.5-flash",
                },
                resourceLabels: { location: "us-central1" },
                points: [point(75)],
              }),
            ],
          });
        }
        if (metric === TOKEN_LIMIT) {
          expect(url.searchParams.get("aggregation.perSeriesAligner")).toBeNull();
          expect(url.searchParams.get("interval.startTime")).toBe(
            "2026-07-13T20:15:00.000Z"
          );
          return jsonResponse({
            timeSeries: [
              series({
                metricType: TOKEN_LIMIT,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "InputTokensPerMinute",
                  model: "gemini-2.5-pro",
                },
                points: [
                  point(2_000_000),
                  point(1_000_000, "2026-07-12T20:00:00Z"),
                ],
              }),
            ],
          });
        }
        if (metric === REQUEST_USAGE) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_USAGE,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "RequestsPerMinute",
                  model: "gemini-2.5-flash",
                },
                points: [point(3)],
              }),
            ],
          });
        }
        if (metric === REQUEST_LIMIT) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_LIMIT,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "RequestsPerMinute",
                  model: "gemini-2.5-flash",
                },
                points: [point(60)],
              }),
            ],
          });
        }
        return jsonResponse({ timeSeries: [] });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result).toMatchObject({
      status: "ready",
      projectId: PROJECT_ID,
      totalRequests: 15,
      descriptorDiscovery: {
        status: "ready",
        availableCount: 4,
        selectedCount: 4,
        truncated: false,
      },
      requests: {
        status: "ready",
        source: "aggregate_service_runtime_fallback",
        total: 15,
      },
      quotaUsage: {
        status: "ready",
        availableCount: 3,
        retainedCount: 3,
      },
      quotaLimits: {
        status: "ready",
        availableCount: 2,
        retainedCount: 2,
      },
    });
    expect(result.quotaUsage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricType: TOKEN_USAGE,
          model: "gemini-2.5-pro",
          tier: "paid tier 2",
          location: "global",
          unit: "tokens",
          value: 150,
        }),
        expect.objectContaining({
          model: "gemini-2.5-flash",
          tier: "paid tier 2",
          location: "us-central1",
          value: 75,
        }),
      ])
    );
    expect(result.quotaLimits.items[0]).toMatchObject({
      metricType: TOKEN_LIMIT,
      model: "gemini-2.5-pro",
      tier: "paid tier 2",
      value: 2_000_000,
      reportThrough: "2026-07-13T20:00:00.000Z",
    });
    expect(result.quotaUsage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricType: REQUEST_USAGE,
          model: "gemini-2.5-flash",
          tier: "paid tier",
          unit: "requests",
          value: 3,
        }),
      ])
    );
    expect(result.externalBillingSyncs.map((sync) => sync.source)).toEqual([
      "google-cloud-monitoring-requests",
      "google-cloud-monitoring-native-quota-usage",
      "google-cloud-monitoring-native-quota-limits",
    ]);
    expect(result.externalBillingSyncs[0]).toMatchObject({
      authoritative: true,
      records: [
        expect.objectContaining({
          externalId: "gemini-requests-mtd",
          usageQuantity: 15,
        }),
      ],
    });
    expect(result.externalBillingSyncs[2].records[0]).toMatchObject({
      requestLimit: 2_000_000,
      usageUnit: "tokens",
      rollupRole: "metadata",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
    expect(JSON.stringify(result)).not.toContain("GenerateContent\"");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("rejects a returned cross-project series even though every query has an exact project selector", async () => {
    stubMonitoring({
      descriptors: [descriptor(TOKEN_USAGE, "DELTA")],
      timeSeriesResponder: (metric) =>
        metric === TOKEN_USAGE
          ? jsonResponse({
              timeSeries: [
                series({
                  metricType: TOKEN_USAGE,
                  resourceType: LOCATION_RESOURCE,
                  metricLabels: { model: "gemini-2.5-pro" },
                  resourceLabels: { resource_container: "another-project" },
                  points: [point(10)],
                }),
              ],
            })
          : jsonResponse({ timeSeries: [] }),
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.quotaUsage).toMatchObject({
      status: "partial",
      queryFailureCount: 1,
      errorCode: "INVALID_RESPONSE",
    });
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-native-quota-usage"
      )
    ).toMatchObject({ authoritative: false, records: [] });
  });

  it("does not falsely clear native history when active descriptor discovery is empty", async () => {
    stubMonitoring({ descriptors: [] });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("empty");
    expect(result.totalRequests).toBeNull();
    expect(result.externalBillingSyncs).toEqual([
      {
        source: "google-cloud-monitoring-requests",
        authoritative: false,
        records: [],
      },
      {
        source: "google-cloud-monitoring-native-quota-usage",
        authoritative: false,
        records: [],
      },
      {
        source: "google-cloud-monitoring-native-quota-limits",
        authoritative: false,
        records: [],
      },
    ]);
  });

  it("preserves successful native siblings when one exact metric query is forbidden", async () => {
    stubMonitoring({
      descriptors: [
        descriptor(TOKEN_USAGE, "DELTA"),
        descriptor(REQUEST_USAGE, "DELTA"),
      ],
      timeSeriesResponder: (metric) => {
        if (metric === TOKEN_USAGE) {
          return jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403);
        }
        if (metric === REQUEST_USAGE) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_USAGE,
                resourceType: LOCATION_RESOURCE,
                metricLabels: {
                  limit_name: "RequestsPerMinute",
                  model: "gemini-2.5-flash",
                },
                points: [point(8)],
              }),
            ],
          });
        }
        return jsonResponse({ timeSeries: [] });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.quotaUsage).toMatchObject({
      status: "partial",
      queryFailureCount: 1,
      availableCount: 1,
    });
    expect(result.quotaUsage.items[0]).toMatchObject({
      metricType: REQUEST_USAGE,
      model: "gemini-2.5-flash",
      tier: "paid tier",
      value: 8,
    });
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-native-quota-usage"
      )
    ).toMatchObject({ authoritative: false });
    expect(result.partialError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
    });
  });

  it("reports project permission denial without returning false zero or clear syncs", async () => {
    stubMonitoring({
      descriptorResponder: () =>
        jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403),
      timeSeriesResponder: () =>
        jsonResponse({ error: { status: "PERMISSION_DENIED" } }, 403),
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("permission_denied");
    expect(result.totalRequests).toBeNull();
    expect(result.externalBillingSyncs).toEqual([]);
    expect(result.partialError).toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });
  });

  it("bounds a production-cardinality GAUGE to a recent window and keeps its newest value", async () => {
    const hypotheticalMonthlyPoints = 13 * 24 * 60;
    expect(hypotheticalMonthlyPoints).toBeGreaterThan(5_000);
    const recentPoints = Array.from({ length: 16 }, (_, index) => {
      const timestamp = new Date(
        Date.parse("2026-07-13T20:15:00.000Z") + index * 60_000
      ).toISOString();
      return point(index === 15 ? 2_000_000 : 1_000_000 + index, timestamp);
    });
    stubMonitoring({
      descriptors: [descriptor(TOKEN_LIMIT, "GAUGE")],
      timeSeriesResponder: (metric, url) => {
        if (metric !== TOKEN_LIMIT) return jsonResponse({ timeSeries: [] });
        expect(url.searchParams.get("interval.startTime")).toBe(
          "2026-07-13T20:15:00.000Z"
        );
        expect(url.searchParams.get("interval.endTime")).toBe(
          "2026-07-13T20:30:00.000Z"
        );
        return jsonResponse({
          timeSeries: [
            series({
              metricType: TOKEN_LIMIT,
              resourceType: LOCATION_RESOURCE,
              metricLabels: {
                limit_name: "InputTokensPerMinute",
                model: "gemini-2.5-pro",
              },
              points: recentPoints,
            }),
          ],
        });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("ready");
    expect(result.quotaLimits).toMatchObject({
      status: "ready",
      emptyRecentGaugeCount: 0,
      availableCount: 1,
    });
    expect(result.quotaLimits.items[0]).toMatchObject({
      value: 2_000_000,
      reportThrough: "2026-07-13T20:30:00.000Z",
    });
  });

  it("treats an empty recent GAUGE window as partial unknown without clearing history", async () => {
    stubMonitoring({ descriptors: [descriptor(TOKEN_LIMIT, "GAUGE")] });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.totalRequests).toBeNull();
    expect(result.reportThrough).toBeNull();
    expect(result.quotaLimits).toMatchObject({
      status: "partial",
      descriptorCount: 1,
      emptyRecentGaugeCount: 1,
      availableCount: 0,
      items: [],
    });
    expect(result.partialError).toBeUndefined();
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-native-quota-limits"
      )
    ).toEqual({
      source: "google-cloud-monitoring-native-quota-limits",
      authoritative: false,
      records: [],
    });
  });

  it("accepts bounded empty metric-label dimensions emitted by native quota series", async () => {
    stubMonitoring({
      descriptors: [descriptor(TOKEN_USAGE, "DELTA")],
      timeSeriesResponder: (metric) =>
        metric === TOKEN_USAGE
          ? jsonResponse({
              timeSeries: [
                series({
                  metricType: TOKEN_USAGE,
                  resourceType: LOCATION_RESOURCE,
                  metricLabels: { limit_name: "", model: "" },
                  resourceLabels: { location: "" },
                  points: [point(125)],
                }),
              ],
            })
          : jsonResponse({ timeSeries: [] }),
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("ready");
    expect(result.quotaUsage.items).toEqual([
      expect.objectContaining({
        model: "all models",
        limitName: null,
        location: "global",
        value: 125,
      }),
    ]);
    expect(result.partialError).toBeUndefined();
  });

  it("keeps valid aggregate requests and sibling limits when a native GAUGE value is unsafe", async () => {
    stubMonitoring({
      descriptors: [descriptor(TOKEN_LIMIT, "GAUGE")],
      timeSeriesResponder: (metric) => {
        if (metric === REQUEST_COUNT) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_COUNT,
                resourceType: "consumed_api",
                points: [point(11)],
              }),
            ],
          });
        }
        return jsonResponse({
          timeSeries: [
            series({
              metricType: TOKEN_LIMIT,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: "gemini-unsafe" },
              points: [point(Number.MAX_SAFE_INTEGER + 1)],
            }),
            series({
              metricType: TOKEN_LIMIT,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: "gemini-valid" },
              points: [point(100)],
            }),
          ],
        });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result).toMatchObject({
      status: "partial",
      totalRequests: 11,
      quotaLimits: {
        status: "partial",
        queryFailureCount: 1,
        availableCount: 1,
        errorCode: "INVALID_RESPONSE",
        items: [expect.objectContaining({ model: "gemini-valid", value: 100 })],
      },
      partialError: { code: "INVALID_RESPONSE" },
    });
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-requests"
      )
    ).toMatchObject({
      authoritative: true,
      records: [expect.objectContaining({ usageQuantity: 11 })],
    });
  });

  it("drops an overflowing grouped DELTA without losing valid requests or sibling usage", async () => {
    stubMonitoring({
      descriptors: [descriptor(TOKEN_USAGE, "DELTA")],
      timeSeriesResponder: (metric) => {
        if (metric === REQUEST_COUNT) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_COUNT,
                resourceType: "consumed_api",
                points: [point(9)],
              }),
            ],
          });
        }
        return jsonResponse({
          timeSeries: [
            series({
              metricType: TOKEN_USAGE,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: "gemini-overflow" },
              points: [point(Number.MAX_SAFE_INTEGER)],
            }),
            series({
              metricType: TOKEN_USAGE,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: "gemini-overflow" },
              points: [point(1)],
            }),
            series({
              metricType: TOKEN_USAGE,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: "gemini-valid" },
              points: [point(5)],
            }),
          ],
        });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result).toMatchObject({
      status: "partial",
      totalRequests: 9,
      quotaUsage: {
        status: "partial",
        queryFailureCount: 1,
        availableCount: 1,
        errorCode: "INVALID_RESPONSE",
        items: [expect.objectContaining({ model: "gemini-valid", value: 5 })],
      },
      partialError: { code: "INVALID_RESPONSE" },
    });
    expect(result.quotaUsage.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "gemini-overflow" }),
      ])
    );
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-requests"
      )
    ).toMatchObject({
      authoritative: true,
      records: [expect.objectContaining({ usageQuantity: 9 })],
    });
  });

  it("keeps valid aggregate requests when a native label is non-string", async () => {
    stubMonitoring({
      descriptors: [descriptor(TOKEN_USAGE, "DELTA")],
      timeSeriesResponder: (metric) => {
        if (metric === REQUEST_COUNT) {
          return jsonResponse({
            timeSeries: [
              series({
                metricType: REQUEST_COUNT,
                resourceType: "consumed_api",
                points: [point(7)],
              }),
            ],
          });
        }
        return jsonResponse({
          timeSeries: [
            series({
              metricType: TOKEN_USAGE,
              resourceType: LOCATION_RESOURCE,
              metricLabels: { model: 42 as unknown as string },
              points: [point(125)],
            }),
          ],
        });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result).toMatchObject({
      status: "partial",
      totalRequests: 7,
      quotaUsage: {
        status: "partial",
        queryFailureCount: 1,
        errorCode: "INVALID_RESPONSE",
      },
      partialError: { code: "INVALID_RESPONSE" },
    });
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-requests"
      )
    ).toMatchObject({
      authoritative: true,
      records: [expect.objectContaining({ usageQuantity: 7 })],
    });
  });

  it("bounds dynamic native queries and marks a truncated catalog non-authoritative", async () => {
    const descriptors = Array.from({ length: 60 }, (_, index) =>
      descriptor(
        `generativelanguage.googleapis.com/quota/custom_request_quota_${String(index).padStart(2, "0")}/usage`,
        "DELTA"
      )
    );
    const fetchMock = stubMonitoring({ descriptors });

    const result = await fetchGoogleCloudMonitoring(config());

    const monitoringCalls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => new URL(url).hostname === "monitoring.googleapis.com");
    const timeSeriesCalls = monitoringCalls.filter((url) =>
      url.includes("/timeSeries?")
    );
    expect(timeSeriesCalls).toHaveLength(41);
    expect(result).toMatchObject({
      status: "partial",
      descriptorDiscovery: {
        availableCount: 60,
        selectedCount: 40,
        truncated: true,
      },
      quotaUsage: { status: "partial", truncated: true },
    });
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-native-quota-usage"
      )
    ).toMatchObject({ authoritative: false });
  });

  it("bounds descriptor pagination and preserves the aggregate request sibling", async () => {
    let descriptorPage = 0;
    stubMonitoring({
      descriptorResponder: (url) => {
        descriptorPage += 1;
        if (descriptorPage === 1) {
          expect(url.searchParams.get("pageToken")).toBeNull();
          return jsonResponse({ metricDescriptors: [], nextPageToken: "repeat" });
        }
        expect(url.searchParams.get("pageToken")).toBe("repeat");
        return jsonResponse({ metricDescriptors: [], nextPageToken: "repeat" });
      },
      timeSeriesResponder: (metric) =>
        metric === REQUEST_COUNT
          ? jsonResponse({
              timeSeries: [
                series({
                  metricType: REQUEST_COUNT,
                  resourceType: "consumed_api",
                  points: [point(4)],
                }),
              ],
            })
          : jsonResponse({ timeSeries: [] }),
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(result.status).toBe("partial");
    expect(result.totalRequests).toBe(4);
    expect(result.descriptorDiscovery).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
    expect(result.externalBillingSyncs.map((sync) => sync.source)).toEqual([
      "google-cloud-monitoring-requests",
    ]);
  });

  it("uses bounded descriptor pages as non-authoritative partial discovery", async () => {
    let descriptorPage = 0;
    const fetchMock = stubMonitoring({
      descriptorResponder: () => {
        descriptorPage += 1;
        return jsonResponse({
          metricDescriptors: [
            descriptor(
              descriptorPage === 1 ? TOKEN_USAGE : REQUEST_USAGE,
              "DELTA"
            ),
          ],
          nextPageToken: `page-${descriptorPage + 1}`,
        });
      },
    });

    const result = await fetchGoogleCloudMonitoring(config());

    expect(descriptorPage).toBe(2);
    expect(result).toMatchObject({
      status: "partial",
      descriptorDiscovery: {
        status: "ready",
        availableCount: 2,
        selectedCount: 2,
        truncated: true,
      },
    });
    const timeSeriesCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/timeSeries?")
    );
    expect(timeSeriesCalls).toHaveLength(3);
    expect(
      result.externalBillingSyncs.find(
        (sync) => sync.source === "google-cloud-monitoring-native-quota-usage"
      )
    ).toMatchObject({ authoritative: false });
  });
});
