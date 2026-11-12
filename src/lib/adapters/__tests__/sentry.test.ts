import { afterEach, describe, expect, it, vi } from "vitest";
import { redactProviderRawData } from "../../data-privacy";
import { fetchUsage } from "../sentry";

const ORG_SLUG = "simple-with-us";
const PROJECTS_PATH = `/api/0/organizations/${ORG_SLUG}/projects/`;

function jsonResponse(
  body: unknown,
  options: { status?: number; link?: string } = {}
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.link) headers.set("link", options.link);
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

function projectPage(
  projects: unknown[],
  nextCursor: string | null = null
): Response {
  const previousUrl = `https://sentry.io${PROJECTS_PATH}?per_page=100&cursor=previous`;
  const nextUrl = `https://sentry.io${PROJECTS_PATH}?per_page=100&cursor=${encodeURIComponent(nextCursor ?? "end")}`;
  return jsonResponse(projects, {
    link: [
      `<${previousUrl}>; rel="previous"; results="false"`,
      `<${nextUrl}>; rel="next"; results="${nextCursor == null ? "false" : "true"}"`,
    ].join(", "),
  });
}

function statsResponse(groups: unknown[]): Response {
  return jsonResponse({ groups });
}

function mockSentryFetch(options: {
  projectResponses: Response[];
  statsByProject: Record<string, unknown[]>;
  statsSummary?: Response;
}) {
  const projectResponses = [...options.projectResponses];
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === PROJECTS_PATH) {
      return projectResponses.shift() ?? projectPage([]);
    }
    if (url.pathname === `/api/0/organizations/${ORG_SLUG}/stats_v2/`) {
      const projectId = url.searchParams.get("project") ?? "";
      return statsResponse(options.statsByProject[projectId] ?? []);
    }
    if (url.pathname === `/api/0/organizations/${ORG_SLUG}/stats-summary/`) {
      return (
        options.statsSummary ??
        jsonResponse({ detail: "not found" }, { status: 404 })
      );
    }
    return jsonResponse({ detail: "unexpected" }, { status: 500 });
  });
}

describe("sentry adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("discovers projects and reports exact UTC MTD per-project stats without mixing units", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:16:17.000Z"));
    const fetchMock = mockSentryFetch({
      projectResponses: [projectPage([{ id: "101" }, { id: 202 }])],
      statsByProject: {
        "101": [
          {
            by: { category: "error", outcome: "accepted" },
            totals: { "sum(quantity)": 12 },
          },
          {
            by: { category: "error", outcome: "rate_limited" },
            totals: { "sum(quantity)": 3 },
          },
          {
            by: { category: "attachment", outcome: "accepted" },
            totals: { "sum(quantity)": "2048" },
          },
        ],
        "202": [
          {
            by: { category: "profile_duration", outcome: "accepted" },
            totals: { "sum(quantity)": 3500 },
          },
          {
            by: { category: "transaction", outcome: "accepted" },
            totals: { "sum(quantity)": 8 },
          },
          {
            by: { category: "replay", outcome: "accepted" },
            totals: { "sum(quantity)": 2 },
          },
          {
            by: { category: "monitor", outcome: "accepted" },
            totals: { "sum(quantity)": 4 },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });

    expect(result.balance).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.totalRequests).toBe(29);
    expect(result.rawData).toMatchObject({
      categories: {
        byCategory: [
          {
            category: "error",
            label: "Errors",
            family: "Errors",
            unit: "events",
            accepted: 12,
            rateLimited: 3,
            total: 15,
          },
          {
            category: "transaction",
            label: "Transactions",
            family: "Transactions",
            unit: "events",
            accepted: 8,
            rateLimited: 0,
            total: 8,
          },
          {
            category: "replay",
            label: "Replays",
            family: "Replays",
            unit: "events",
            accepted: 2,
            rateLimited: 0,
            total: 2,
          },
          {
            category: "attachment",
            label: "Attachments",
            family: "Attachments",
            unit: "bytes",
            accepted: 2048,
            rateLimited: 0,
            total: 2048,
          },
          {
            category: "profile_duration",
            label: "Profiles",
            family: "Profiles",
            unit: "milliseconds",
            accepted: 3500,
            rateLimited: 0,
            total: 3500,
          },
          {
            category: "monitor",
            label: "Monitors",
            family: "Monitors",
            unit: "events",
            accepted: 4,
            rateLimited: 0,
            total: 4,
          },
        ],
        blocked: {
          prepaidBalance: false,
          reservedQuotaRemaining: false,
          paygInvoice: false,
          spans: false,
          logs: false,
        },
      },
      stats: {
        groupedBy: ["category", "outcome", "project"],
        queryStrategy: "per_project",
        projectDiscovery: { accessibleProjects: 2, pages: 1 },
        totals: { events: 29, bytes: 2048, milliseconds: 3500 },
        capabilities: {
          usageByCategoryOutcomeProject: true,
          billingCost: false,
          prepaidBalance: false,
        },
        statsSummary: { available: false, status: 404 },
      },
    });
    expect(result.externalBilling).toMatchObject({
      source: "sentry-stats-v2",
      authoritative: true,
      records: [
        {
          serviceName: "Project 101: Errors (Accepted)",
          usageQuantity: 12,
          usageUnit: "events",
        },
        {
          serviceName: "Project 101: Errors (Rate Limited)",
          usageQuantity: 3,
          usageUnit: "events",
        },
        {
          serviceName: "Project 101: Attachments (Accepted)",
          usageQuantity: 2048,
          usageUnit: "bytes",
        },
        {
          serviceName: "Project 202: Profiles (Accepted)",
          usageQuantity: 3500,
          usageUnit: "milliseconds",
        },
        {
          serviceName: "Project 202: Transactions (Accepted)",
          usageQuantity: 8,
          usageUnit: "events",
        },
        {
          serviceName: "Project 202: Replays (Accepted)",
          usageQuantity: 2,
          usageUnit: "events",
        },
        {
          serviceName: "Project 202: Monitors (Accepted)",
          usageQuantity: 4,
          usageUnit: "events",
        },
      ],
    });
    for (const record of result.externalBilling?.records ?? []) {
      expect(record.amountUsd).toBeUndefined();
      expect(record.requestLimit).toBeUndefined();
      expect(record.planName).toBeUndefined();
      expect(record.nextRenewalAt).toBeUndefined();
    }

    const statsUrls = fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname.endsWith("/stats_v2/"));
    expect(statsUrls.map((url) => url.searchParams.get("project"))).toEqual([
      "101",
      "202",
    ]);
    for (const url of statsUrls) {
      expect(url.searchParams.get("field")).toBe("sum(quantity)");
      expect(url.searchParams.getAll("groupBy")).toEqual([
        "category",
        "outcome",
      ]);
      expect(url.searchParams.get("start")).toBe("2026-07-01T00:00:00.000Z");
      expect(url.searchParams.get("end")).toBe("2026-07-13T15:16:17.000Z");
    }
    const summaryUrl = fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .find((url) => url.pathname.endsWith("/stats-summary/"));
    expect(summaryUrl?.searchParams.get("field")).toBe("sum(quantity)");
  });

  it("keeps balance, credits, and billingCost null/false after rawData redaction", async () => {
    const fetchMock = mockSentryFetch({
      projectResponses: [projectPage([{ id: "101" }])],
      statsByProject: {
        "101": [
          {
            by: { category: "error", outcome: "accepted" },
            totals: { "sum(quantity)": 5 },
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });
    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.totalCost).toBeNull();

    const redacted = redactProviderRawData(
      "builtin",
      "sentry",
      result.rawData
    ) as Record<string, unknown>;
    expect(redacted.categories).toMatchObject({
      byCategory: [
        expect.objectContaining({
          label: "Errors",
          accepted: 5,
          rateLimited: 0,
        }),
      ],
    });
    expect(redacted.stats).toMatchObject({
      capabilities: { billingCost: false, prepaidBalance: false },
    });
    expect(redacted).not.toHaveProperty("groups");
    expect(redacted).not.toHaveProperty("balance");
    expect(redacted).not.toHaveProperty("credits");
  });

  it("stores optional stats-summary totals without treating them as cash", async () => {
    const fetchMock = mockSentryFetch({
      projectResponses: [projectPage([{ id: "101" }])],
      statsByProject: {
        "101": [
          {
            by: { category: "error", outcome: "accepted" },
            totals: { "sum(quantity)": 5 },
          },
        ],
      },
      statsSummary: jsonResponse({
        projects: [
          {
            id: "101",
            stats: [
              {
                category: "error",
                outcomes: {
                  accepted: 5,
                  filtered: 0,
                  rate_limited: 1,
                  invalid: 0,
                  abuse: 0,
                  client_discard: 0,
                  cardinality_limited: 0,
                },
              },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });
    expect(result.balance).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      stats: {
        capabilities: { billingCost: false },
        statsSummary: {
          available: true,
          status: 200,
          byCategory: [
            expect.objectContaining({
              category: "error",
              label: "Errors",
              accepted: 5,
              rateLimited: 1,
            }),
          ],
        },
      },
    });
  });

  it("does not fail the sync when stats-summary is unavailable", async () => {
    const fetchMock = mockSentryFetch({
      projectResponses: [projectPage([{ id: "101" }])],
      statsByProject: { "101": [] },
      statsSummary: jsonResponse({ detail: "forbidden" }, { status: 403 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });
    expect(result.rawData).toMatchObject({
      stats: { statsSummary: { available: false, status: 403 } },
      categories: { byCategory: [] },
    });
  });

  it("follows every project discovery page before querying project usage", async () => {
    const fetchMock = mockSentryFetch({
      projectResponses: [
        projectPage([{ id: "101" }], "cursor:one"),
        projectPage([{ id: "202" }]),
      ],
      statsByProject: { "101": [], "202": [] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });

    expect(result.rawData).toMatchObject({
      stats: { projectDiscovery: { accessibleProjects: 2, pages: 2 } },
    });
    expect(result.externalBilling).toMatchObject({
      authoritative: true,
      records: [],
    });
    const secondPageUrl = fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname === PROJECTS_PATH)[1];
    expect(secondPageUrl.searchParams.get("cursor")).toBe("cursor:one");
  });

  it("fails the whole sync when any project stats query fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(projectPage([{ id: "101" }, { id: "202" }]))
      .mockResolvedValueOnce(statsResponse([]))
      .mockResolvedValueOnce(jsonResponse({ detail: "forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed project discovery payloads before authoritative reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ projects: [{ id: "101" }] }, {
          link: `<https://sentry.io${PROJECTS_PATH}?cursor=end>; rel="next"; results="false"`,
        })
      )
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects malformed per-project stats payloads before authoritative reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(projectPage([{ id: "101" }]))
        .mockResolvedValueOnce(jsonResponse({ groups: "not-an-array" }))
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects missing project pagination metadata instead of assuming the first page is complete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "101" }])));

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects quantities that cannot be stored without changing their unit or precision", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(projectPage([{ id: "101" }]))
        .mockResolvedValueOnce(
          statsResponse([
            {
              by: { category: "error", outcome: "accepted" },
              totals: { "sum(quantity)": 1.5 },
            },
          ])
        )
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
