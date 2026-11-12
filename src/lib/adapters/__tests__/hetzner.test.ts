import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../hetzner";

function listResponse(
  collection: string,
  rows: unknown[],
  page = 1,
  nextPage: number | null = null,
  lastPage = page,
  totalEntries = rows.length
): Response {
  return new Response(
    JSON.stringify({
      [collection]: rows,
      meta: {
        pagination: {
          page,
          per_page: 50,
          previous_page: page === 1 ? null : page - 1,
          next_page: nextPage,
          last_page: lastPage,
          total_entries: totalEntries,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const completePricing = {
  currency: "EUR",
  vat_rate: "19.00",
  server_backup: { percentage: "20" },
  server_types: [
    {
      name: "cx11",
      prices: [{ location: "fsn1", price_monthly: { net: "3.50" } }],
    },
  ],
  volume: { price_per_gb_month: { net: "0.04" } },
  floating_ips: [
    {
      type: "ipv4",
      prices: [{ location: "fsn1", price_monthly: { net: "1.00" } }],
    },
  ],
  primary_ips: [
    {
      type: "ipv4",
      prices: [{ location: "fsn1", price_monthly: { net: "0.50" } }],
    },
    {
      type: "ipv6",
      prices: [{ location: "fsn1", price_monthly: { net: "0" } }],
    },
  ],
  load_balancer_types: [
    {
      name: "lb11",
      prices: [{ location: "fsn1", price_monthly: { net: "5.00" } }],
    },
  ],
  image: { price_per_gb_month: { net: "0.01" } },
};

function installHetznerMock(options?: {
  pricing?: Record<string, unknown>;
  mockExchangeRate?: number;
  override?: (url: URL) => Response | undefined;
}) {
  const rows: Record<string, unknown[]> = {
    servers: [
      {
        id: 1,
        name: "server1",
        status: "running",
        outgoing_traffic: 1000,
        backup_window: "22-02",
        location: { name: "fsn1" },
        server_type: { name: "cx11" },
      },
    ],
    volumes: [
      {
        id: 2,
        name: "data",
        status: "available",
        server: 1,
        size: 10,
        location: { name: "fsn1" },
      },
    ],
    floating_ips: [
      {
        id: 3,
        name: "egress",
        type: "ipv4",
        server: 1,
        home_location: { name: "fsn1" },
      },
    ],
    primary_ips: [
      {
        id: 4,
        name: "public-v4",
        type: "ipv4",
        assignee_id: 1,
        assignee_type: "server",
        location: { name: "fsn1" },
      },
      {
        id: 5,
        name: "public-v6",
        type: "ipv6",
        assignee_id: 1,
        assignee_type: "server",
        location: { name: "fsn1" },
      },
    ],
    load_balancers: [
      {
        id: 6,
        name: "frontend",
        location: { name: "fsn1" },
        load_balancer_type: { name: "lb11" },
        outgoing_traffic: 500,
        ingoing_traffic: 750,
      },
    ],
    images: [
      {
        id: 7,
        name: "release-snapshot",
        type: "snapshot",
        status: "available",
        image_size: 2,
        disk_size: 20,
        created_from: { id: 1, name: "server1" },
      },
      {
        id: 8,
        name: "automatic-backup",
        type: "backup",
        status: "available",
        image_size: 2,
        disk_size: 20,
        created_from: { id: 1, name: "server1" },
      },
    ],
  };
  const pathToCollection: Record<string, string> = {
    "/v1/servers": "servers",
    "/v1/volumes": "volumes",
    "/v1/floating_ips": "floating_ips",
    "/v1/primary_ips": "primary_ips",
    "/v1/load_balancers": "load_balancers",
    "/v1/images": "images",
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const override = options?.override?.(url);
    if (override) return override;
    if (url.hostname === "open.er-api.com") {
      return new Response(
        JSON.stringify({
          result: "success",
          rates: { USD: options?.mockExchangeRate ?? 1.09 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.pathname === "/v1/pricing") {
      return new Response(
        JSON.stringify({ pricing: options?.pricing ?? completePricing }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const collection = pathToCollection[url.pathname];
    if (!collection) return new Response("Not found", { status: 404 });
    return listResponse(collection, rows[collection]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("hetzner adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("discovers priced resources and stamps pro-rated catalog estimate as MTD spend", async () => {
    const fetchMock = installHetznerMock();

    const result = await fetchUsage("fake-key");

    expect(result.totalCost).not.toBeNull();
    expect(result.totalCost!).toBeGreaterThan(0);
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(result.costCoverageCaveat?.code).toBe("hetzner_catalog_runrate_prorated");
    expect(result.totalRequests).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "hetzner-cloud-server-plans",
      authoritative: true,
    });
    expect(result.externalBilling?.records.map((record) => record.externalId)).toEqual(
      expect.arrayContaining([
        "1",
        "server-backup:1",
        "volume:2",
        "floating-ip:3",
        "primary-ip:4",
        "load-balancer:6",
        "snapshot:7",
      ])
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "primary-ip:5"
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "snapshot:8"
    );
    expect(
      result.externalBilling?.records.map((record) => ({
        externalId: record.externalId,
        amountUsd: record.amountUsd,
        currency: record.currency,
      }))
    ).toEqual(
      expect.arrayContaining([
        { externalId: "1", amountUsd: 3.815, currency: "USD" },
        { externalId: "server-backup:1", amountUsd: 0.763, currency: "USD" },
        { externalId: "volume:2", amountUsd: 0.436, currency: "USD" },
        { externalId: "floating-ip:3", amountUsd: 1.09, currency: "USD" },
        { externalId: "primary-ip:4", amountUsd: 0.545, currency: "USD" },
        { externalId: "load-balancer:6", amountUsd: 5.45, currency: "USD" },
        { externalId: "snapshot:7", amountUsd: 0.0218, currency: "USD" },
      ])
    );


    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.totalBandwidthBytes).toBe(1500);
    expect(rawData.monthlyRunRate).toMatchObject({
      amount: 12.1208,
      currency: "USD",
      basis: "current_resource_catalog_net_monthly_maximum",
      byResource: {
        servers: 3.815,
        serverBackups: 0.763,
        volumes: 0.436,
        floatingIps: 1.09,
        primaryIps: 0.545,
        loadBalancers: 5.45,
        snapshots: 0.0218,
      },
    });
    const monthlyRunRate = rawData.monthlyRunRate as {
      estimatedMtdUsd?: number;
      monthFraction?: number;
    };
    expect(monthlyRunRate.estimatedMtdUsd).toBeCloseTo(result.totalCost ?? 0, 5);
    expect(monthlyRunRate.monthFraction).toBeGreaterThan(0);
    expect(monthlyRunRate.monthFraction).toBeLessThanOrEqual(1);
    expect(rawData.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 8,
          type: "backup",
          monthlyCatalogPrice: null,
          priceIncludedInServerBackup: true,
        }),
      ])
    );

    const imageRequest = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === "/v1/images");
    expect(imageRequest?.searchParams.getAll("type")).toEqual(["snapshot", "backup"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer fake-key" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("paginates each resource class before reconciling", async () => {
    const first = {
      id: 11,
      name: "one",
      status: "running",
      backup_window: null,
      location: { name: "fsn1" },
      server_type: { name: "cx11" },
    };
    const second = { ...first, id: 12, name: "two" };
    const fetchMock = installHetznerMock({
      override: (url) => {
        if (url.pathname !== "/v1/servers") return undefined;
        const page = Number(url.searchParams.get("page"));
        return page === 1
          ? listResponse("servers", [first], 1, 2, 2, 2)
          : listResponse("servers", [second], 2, null, 2, 2);
      },
    });

    const result = await fetchUsage("key");

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "https://api.hetzner.cloud/v1/servers?per_page=50&page=2"
    );
    expect(result.externalBilling?.records.map((record) => record.serviceName)).toEqual(
      expect.arrayContaining(["one", "two"])
    );
  });

  it("preserves the previous authoritative inventory when catalog pricing is incomplete", async () => {
    installHetznerMock({
      pricing: {
        ...completePricing,
        server_types: [
          {
            name: "cx11",
            prices: [{ location: "hel1", price_monthly: { net: "3.50" } }],
          },
        ],
      },
    });

    const result = await fetchUsage("key");

    expect(result.externalBilling).toBeUndefined();
    expect((result.rawData as { monthlyRunRate: unknown }).monthlyRunRate).toBeNull();
  });

  it("fails the poll when any resource class is unauthorized", async () => {
    installHetznerMock({
      override: (url) =>
        url.pathname === "/v1/volumes"
          ? new Response("Unauthorized", { status: 401 })
          : undefined,
    });

    await expect(fetchUsage("bad-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });

  it.each([
    [
      "zero next page",
      (rows: unknown[]) => listResponse("servers", rows, 1, 0, 1, rows.length),
    ],
    [
      "truncated total",
      (rows: unknown[]) => listResponse("servers", rows, 1, null, 1, rows.length + 1),
    ],
    [
      "premature terminal page",
      (rows: unknown[]) => listResponse("servers", rows, 1, null, 2, rows.length),
    ],
  ])("rejects inconsistent pagination metadata: %s", async (_case, responseFor) => {
    installHetznerMock({
      override: (url) =>
        url.pathname === "/v1/servers"
          ? responseFor([
              {
                id: 1,
                backup_window: null,
                location: { name: "fsn1" },
                server_type: { name: "cx11" },
              },
            ])
          : undefined,
    });

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects an absent required server backup_window instead of treating it as disabled", async () => {
    installHetznerMock({
      override: (url) =>
        url.pathname === "/v1/servers"
          ? listResponse("servers", [
              {
                id: 1,
                location: { name: "fsn1" },
                server_type: { name: "cx11" },
              },
            ])
          : undefined,
    });

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a missing or unknown image type instead of pricing it as a free backup", async () => {
    installHetznerMock({
      override: (url) =>
        url.pathname === "/v1/images"
          ? listResponse("images", [
              { id: 7, status: "available", image_size: 2 },
            ])
          : undefined,
    });

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("converts Euros to USD using a custom exchange rate when HETZNER_EUR_USD_RATE is configured", async () => {
    vi.stubEnv("HETZNER_EUR_USD_RATE", "1.15");
    installHetznerMock({ mockExchangeRate: 1.09 });

    const result = await fetchUsage("fake-key");

    expect(
      result.externalBilling?.records.find((r) => r.externalId === "1")
    ).toMatchObject({
      amountUsd: 4.025, // 3.50 * 1.15
      currency: "USD",
    });
  });

  it("converts Euros to USD using the dynamic exchange rate returned by open.er-api.com", async () => {
    installHetznerMock({ mockExchangeRate: 1.12 });

    const result = await fetchUsage("fake-key");

    expect(
      result.externalBilling?.records.find((r) => r.externalId === "1")
    ).toMatchObject({
      amountUsd: 3.92, // 3.50 * 1.12
      currency: "USD",
    });
  });

  it("falls back to the default rate when the exchange rate API fails", async () => {
    installHetznerMock({
      override: (url) => {
        if (url.hostname === "open.er-api.com") {
          return new Response("Internal Server Error", { status: 500 });
        }
        return undefined;
      },
    });

    const result = await fetchUsage("fake-key");

    expect(
      result.externalBilling?.records.find((r) => r.externalId === "1")
    ).toMatchObject({
      amountUsd: 3.815, // 3.50 * 1.09
      currency: "USD",
    });
  });

  it("does not apply conversion when the API currency is USD", async () => {
    installHetznerMock({
      pricing: {
        ...completePricing,
        currency: "USD",
      },
    });

    const result = await fetchUsage("fake-key");

    expect(
      result.externalBilling?.records.find((r) => r.externalId === "1")
    ).toMatchObject({
      amountUsd: 3.50,
      currency: "USD",
    });
    expect((result.rawData as any).capabilities.currencyConversionApplied).toBe(false);
  });
});
