import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../helpers";
import { fetchUsage, resolveBackblazeCredentials } from "../backblaze";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installB2Mock(options?: {
  authorizeStatus?: number;
  buckets?: Array<{ bucketId: string; bucketName: string; bucketType?: string }>;
  filesByBucket?: Record<
    string,
    Array<{ fileId?: string; fileName?: string; contentLength?: number; action?: string }>
  >;
  listBucketsStatus?: number;
  listFilesStatus?: number;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("b2_authorize_account")) {
      if (options?.authorizeStatus) {
        return jsonResponse({ code: "unauthorized" }, options.authorizeStatus);
      }
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authHeader).toMatch(/^Basic /);
      return jsonResponse({
        accountId: "abc123438a07cb",
        apiUrl: "https://api003.backblazeb2.com",
        downloadUrl: "https://f003.backblazeb2.com",
        authorizationToken: "auth-token",
        allowed: {
          capabilities: ["listBuckets", "listFiles"],
          bucketId: null,
          bucketName: null,
        },
      });
    }
    if (url.includes("b2_list_buckets")) {
      if (options?.listBucketsStatus) {
        return jsonResponse({ code: "bad_auth" }, options.listBucketsStatus);
      }
      return jsonResponse({
        buckets: options?.buckets ?? [
          { bucketId: "b1", bucketName: "jays-socratic-trade-eu", bucketType: "allPrivate" },
          { bucketId: "b2", bucketName: "jays-usage-monitor-eu", bucketType: "allPrivate" },
        ],
      });
    }
    if (url.includes("b2_list_file_versions")) {
      if (options?.listFilesStatus) {
        return jsonResponse({ code: "bad_auth" }, options.listFilesStatus);
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const bucketId = body.bucketId as string;
      const files = options?.filesByBucket?.[bucketId] ?? [];
      return jsonResponse({ files, nextFileName: null });
    }
    return jsonResponse({ code: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolveBackblazeCredentials", () => {
  it("accepts combined keyId:applicationKey", () => {
    expect(resolveBackblazeCredentials("003abc:secretkey")).toEqual({
      applicationKeyId: "003abc",
      applicationKey: "secretkey",
    });
  });

  it("accepts separate config applicationKeyId", () => {
    expect(
      resolveBackblazeCredentials("secretkey", { applicationKeyId: "003abc" })
    ).toEqual({
      applicationKeyId: "003abc",
      applicationKey: "secretkey",
    });
  });

  it("requires key id when not combined", () => {
    expect(() => resolveBackblazeCredentials("secretonly")).toThrow(AdapterError);
  });
});

describe("backblaze adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("inventories buckets, reports storage MB, and estimates catalog MTD", async () => {
    installB2Mock({
      filesByBucket: {
        b1: [
          { fileId: "f1", fileName: "a.db", contentLength: 2 * 1024 * 1024 * 1024, action: "upload" },
          { fileId: "f2", fileName: "a.db", contentLength: 1 * 1024 * 1024 * 1024, action: "hide" },
        ],
        b2: [
          { fileId: "f3", fileName: "b.db", contentLength: 512 * 1024 * 1024, action: "upload" },
        ],
      },
    });

    // 2 + 1 + 0.5 = 3.5 GiB total; free 10 GB → billable 0 → MTD 0
    const emptyish = await fetchUsage("app-key", {
      applicationKeyId: "key-id",
      freeStorageGb: 10,
      storagePricePerGbMonth: 0.006,
    });
    expect(emptyish.totalCost).toBe(0);
    expect(emptyish.totalRequests).toBe(Math.round((3.5 * 1024 * 1024 * 1024) / (1024 * 1024)));
    expect(emptyish.costCoverageCaveat?.code).toBe("backblaze_storage_catalog_prorated");
    expect(emptyish.rawData).toMatchObject({
      resourceCounts: { buckets: 2, fileVersions: 3 },
    });

    // Force billable storage over free allowance
    const result = await fetchUsage("key-id:app-key", {
      freeStorageGb: 1,
      storagePricePerGbMonth: 1, // $1/GB-month for easy math
    });
    // billable = 3.5 - 1 = 2.5 GB × $1 = $2.5 monthly run-rate; MTD is pro-rated
    const monthly = (result.rawData as { monthlyRunRate: { amount: number } }).monthlyRunRate
      .amount;
    expect(monthly).toBeCloseTo(2.5, 5);
    expect(result.totalCost).not.toBeNull();
    expect(result.totalCost!).toBeGreaterThan(0);
    expect(result.totalCost!).toBeLessThanOrEqual(2.5 + 1e-9);
    expect(result.externalBilling?.source).toBe("backblaze-b2-bucket-storage");
    expect(result.externalBilling?.records).toHaveLength(2);
  });

  it("flags soft storage cap exceedance in rawData", async () => {
    installB2Mock({
      filesByBucket: {
        b1: [{ contentLength: 5 * 1024 * 1024 * 1024, action: "upload" }],
        b2: [],
      },
    });
    const result = await fetchUsage("id:secret", { storageCapGb: 1 });
    const storage = (result.rawData as { storage: { overSoftCap: boolean; totalGb: number } })
      .storage;
    expect(storage.overSoftCap).toBe(true);
    expect(storage.totalGb).toBeGreaterThan(1);
    expect(result.costCoverageCaveat?.message).toMatch(/Soft storage cap/i);
  });

  it("propagates authorize HTTP failures", async () => {
    installB2Mock({ authorizeStatus: 401 });
    await expect(fetchUsage("id:secret")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });

  it("skips the api-usage-monitor Litestream bucket by default", async () => {
    const fetchMock = installB2Mock({
      buckets: [
        { bucketId: "b1", bucketName: "jays-socratic-trade-eu", bucketType: "allPrivate" },
        { bucketId: "b2", bucketName: "api-usage-monitor", bucketType: "allPrivate" },
      ],
      filesByBucket: {
        b1: [{ contentLength: 1024, action: "upload" }],
        b2: [{ contentLength: 50 * 1024 * 1024 * 1024, action: "upload" }],
      },
    });
    const result = await fetchUsage("id:secret");
    expect(result.rawData).toMatchObject({
      resourceCounts: { buckets: 1, fileVersions: 1 },
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("b2_list_file_versions"))).toBe(
      true
    );
    const listFileBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes("b2_list_file_versions"))
      .map((c) => JSON.parse(String((c[1] as RequestInit)?.body)));
    expect(listFileBodies.map((b) => b.bucketId)).toEqual(["b1"]);
  });

  it("can include the api-usage-monitor bucket when explicitly opted in", async () => {
    const fetchMock = installB2Mock({
      buckets: [
        { bucketId: "b1", bucketName: "api-usage-monitor", bucketType: "allPrivate" },
      ],
      filesByBucket: {
        b1: [{ contentLength: 1024, action: "upload" }],
      },
    });
    const result = await fetchUsage("id:secret", { includeUsageMonitorBackupBucket: true });
    expect(result.rawData).toMatchObject({
      resourceCounts: { buckets: 1, fileVersions: 1 },
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("b2_list_file_versions"))).toBe(
      true
    );
  });

  it("works with empty buckets (zero storage)", async () => {
    installB2Mock({
      filesByBucket: { b1: [], b2: [] },
    });
    const result = await fetchUsage("id:secret");
    expect(result.totalRequests).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.credits).toBe(10);
  });
});
