import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../vercel";

describe("vercel billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses FOCUS JSONL and sums billed USD cost", async () => {
    const body = [
      { BilledCost: "2.50", BillingCurrency: "USD", ServiceName: "Functions", ConsumedQuantity: "3", Tags: { ProjectName: "secret" } },
      { BilledCost: 1.25, BillingCurrency: "USD", ServiceName: "Bandwidth", ConsumedQuantity: 4 },
    ].map((value) => JSON.stringify(value)).join("\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { teamId: "team_123" });

    expect(result.totalCost).toBe(3.75);
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: 3.75,
      rollupRole: "canonical",
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceName: "Vercel", rollupRole: "canonical" }),
      ])
    );
    expect(JSON.stringify(result.rawData)).not.toContain("secret");
    expect(result.externalBillingSyncs).toEqual([
      expect.objectContaining({
        source: "vercel-focus-service-detail",
        records: expect.arrayContaining([
          expect.objectContaining({ serviceName: "Functions", rollupRole: "component" }),
          expect.objectContaining({ serviceName: "Bandwidth", rollupRole: "component" }),
        ]),
      }),
    ]);
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "incomplete" },
      projectAttribution: { complete: false },
    });
    expect(fetchMock.mock.calls[0][0]).toContain("teamId=team_123");
    expect(result.costIncludesUnknownFixed).toBe(true);
  });

  it("emits non-additive ProjectId-attributed FOCUS components without changing canonical spend", async () => {
    const body = [
      {
        BilledCost: "2.50",
        BillingCurrency: "USD",
        ServiceName: "Functions",
        ConsumedQuantity: "3",
        ConsumedUnit: "invocations",
        Tags: { ProjectId: "prj_congress", ProjectName: "Congress Trade" },
      },
      {
        BilledCost: "1.25",
        BillingCurrency: "USD",
        ServiceName: "Functions",
        ConsumedQuantity: "2",
        ConsumedUnit: "invocations",
        Tags: { ProjectId: "prj_congress", ProjectName: "Congress Trade" },
      },
      {
        BilledCost: "4.00",
        BillingCurrency: "USD",
        ServiceName: "Bandwidth",
        ConsumedQuantity: "1",
        Tags: { ProjectId: "prj_socratic", ProjectName: "Socratic Trade" },
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token", { teamId: "team_123" });

    expect(result.totalCost).toBe(7.75);
    expect(result.externalBilling?.records.filter((record) => record.rollupRole === "canonical"))
      .toEqual([expect.objectContaining({ amountUsd: 7.75, currency: "USD" })]);
    const projectRecords = result.externalBillingSyncs?.find(
      (sync) => sync.source === "vercel-focus-project-attribution"
    )?.records;
    expect(projectRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: expect.stringMatching(/^project:\d{4}-\d{2}:USD:[a-f0-9]{64}$/),
          serviceName: "Congress Trade",
          planName: "Vercel project · Functions",
          amountUsd: 3.75,
          usageQuantity: 5,
          rollupRole: "component",
        }),
        expect.objectContaining({
          externalId: expect.stringMatching(/^project:\d{4}-\d{2}:USD:[a-f0-9]{64}$/),
          serviceName: "Socratic Trade",
          planName: "Vercel project · Bandwidth",
          amountUsd: 4,
          rollupRole: "component",
        }),
      ])
    );
    expect(projectRecords?.every((record) => record.externalId.length <= 255)).toBe(true);
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "available" },
      projectAttribution: { taggedChargeCount: 3, componentCount: 2 },
    });
    expect(JSON.stringify(result.rawData)).not.toContain("Congress Trade");
    expect(JSON.stringify(result.rawData)).not.toContain("Socratic Trade");
  });

  it("fails closed for project-shaped Tags that omit the documented ProjectId", async () => {
    const body = [
      {
        BilledCost: "2.50",
        BillingCurrency: "USD",
        ServiceName: "Functions",
        Tags: { project_id: "prj_ambiguous" },
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(2.5);
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "vercel-focus-service-detail",
    ]);
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "incomplete" },
      projectAttribution: { complete: false, componentCount: 0 },
    });
  });

  it("ignores a malformed optional ProjectName without invalidating canonical FOCUS cost", async () => {
    const body = [
      {
        BilledCost: "7.75",
        BillingCurrency: "USD",
        ServiceName: "AI Gateway",
        Tags: { ProjectId: "prj_valid", ProjectName: { malformed: true } },
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(7.75);
    expect(
      result.externalBillingSyncs?.find(
        (sync) => sync.source === "vercel-focus-project-attribution"
      )?.records
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Vercel project prj_valid",
          planName: "Vercel project · AI Gateway",
          amountUsd: 7.75,
          rollupRole: "component",
        }),
      ])
    );
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "available" },
      projectAttribution: { taggedChargeCount: 1, componentCount: 1, complete: true },
    });
  });

  it("keeps canonical cash but emits no project sync when a documented Tags object is malformed", async () => {
    const body = [
      {
        BilledCost: "2.50",
        BillingCurrency: "USD",
        ServiceName: "Functions",
        Tags: { ProjectId: 42, ProjectName: "Not usable" },
      },
      {
        BilledCost: "1.25",
        BillingCurrency: "USD",
        ServiceName: "Bandwidth",
        Tags: ["not", "an", "object"],
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(3.75);
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ amountUsd: 3.75, rollupRole: "canonical" })])
    );
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "vercel-focus-service-detail",
    ]);
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "incomplete" },
      projectAttribution: { componentCount: 0, complete: false },
    });
  });

  it("suppresses all project components when the documented project dimension exceeds the bounded cardinality", async () => {
    const body = Array.from({ length: 251 }, (_, index) => JSON.stringify({
      BilledCost: "1",
      BillingCurrency: "USD",
      ServiceName: "Functions",
      Tags: { ProjectId: `prj_${index}`, ProjectName: `Project ${index}` },
    })).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(251);
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "vercel-focus-service-detail",
    ]);
    expect(result.rawData).toMatchObject({
      capabilities: { projectAttribution: "suppressed_cardinality_limit" },
      projectAttribution: {
        taggedChargeCount: 251,
        componentCount: 0,
        suppressedByCardinalityLimit: true,
      },
    });
  });

  it("suppresses unbounded service detail without changing the canonical total", async () => {
    const body = Array.from({ length: 251 }, (_, index) => JSON.stringify({
      BilledCost: "1",
      BillingCurrency: "USD",
      ServiceName: `Service ${index}`,
    })).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(251);
    expect(result.externalBilling?.records.filter((record) => record.rollupRole === "component"))
      .toEqual([]);
    expect(result.rawData).toMatchObject({
      capabilities: { serviceComponents: "suppressed_cardinality_limit" },
    });
  });

  it("uses fixed-width external identities for provider-supplied project and service dimensions", async () => {
    const body = JSON.stringify({
      BilledCost: "1",
      BillingCurrency: "USD",
      ServiceName: "s".repeat(1_000),
      ConsumedUnit: "u".repeat(1_000),
      Tags: { ProjectId: "p".repeat(256) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token", { teamId: "t".repeat(1_000) });
    const allRecords = [
      ...(result.externalBilling?.records ?? []),
      ...(result.externalBillingSyncs?.flatMap((sync) => sync.records) ?? []),
    ];

    expect(result.totalCost).toBe(1);
    expect(allRecords).toHaveLength(3);
    expect(allRecords.every((record) => record.externalId.length <= 255)).toBe(true);
    expect(allRecords.map((record) => record.externalId)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^canonical:\d{4}-\d{2}:USD$/),
        expect.stringMatching(/^service:\d{4}-\d{2}:USD:[a-f0-9]{64}$/),
        expect.stringMatching(/^project:\d{4}-\d{2}:USD:[a-f0-9]{64}$/),
      ])
    );
  });

  it("fails closed on a malformed successful FOCUS row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ServiceName: "Functions" }), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("preserves non-USD service spend without labeling it canonical USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            BilledCost: "4.25",
            BillingCurrency: "EUR",
            ServiceName: "Functions",
            ConsumedQuantity: "10",
            ConsumedUnit: "invocations",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchUsage("token");
    expect(result.totalCost).toBeNull();
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Vercel",
          amountUsd: 4.25,
          currency: "EUR",
          rollupRole: "canonical",
        }),
      ])
    );
    expect(
      result.externalBillingSyncs?.find(
        (sync) => sync.source === "vercel-focus-service-detail"
      )?.records
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Functions",
          amountUsd: 4.25,
          currency: "EUR",
          usageQuantity: 10,
          rollupRole: "component",
        }),
      ])
    );
  });

  it("treats an empty successful FOCUS response as authoritative zero spend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    );

    const result = await fetchUsage("token");

    expect(result.totalCost).toBe(0);
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({ amountUsd: 0, currency: "USD", rollupRole: "canonical" }),
    ]);
  });
});
