import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, isAllowedPineconeIndexHost, pineconeHeaders } from "../pinecone";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installPineconeMock(options?: {
  indexes?: unknown[];
  backupStatus?: number;
  paginated?: boolean;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/indexes") {
      return jsonResponse({ indexes: options?.indexes ?? [] });
    }
    if (url.pathname === "/backups") {
      if (options?.backupStatus) return jsonResponse({}, options.backupStatus);
      const token = url.searchParams.get("paginationToken");
      if (options?.paginated && !token) {
        return jsonResponse({
          data: [
            {
              backup_id: "backup-1",
              name: "nightly-one",
              source_index_name: "docs",
              status: "Ready",
              size_bytes: 100,
            },
          ],
          pagination: { next: "backup/next" },
        });
      }
      return jsonResponse({
        data: options?.paginated
          ? [
              {
                backup_id: "backup-2",
                name: "nightly-two",
                source_index_name: "docs",
                status: "Ready",
                size_bytes: 200,
              },
            ]
          : [],
        pagination: null,
      });
    }
    if (url.pathname === "/collections") {
      return jsonResponse({
        collections: options?.paginated
          ? [
              {
                name: "legacy-snapshot",
                status: "Ready",
                environment: "us-east-1-aws",
                size: 300,
                vector_count: 5,
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/assistant/assistants") {
      const token = url.searchParams.get("pagination_token");
      if (options?.paginated && !token) {
        return jsonResponse({
          assistants: [{ name: "research", status: "Ready" }],
          pagination: { next: "assistant next" },
        });
      }
      return jsonResponse({
        assistants: options?.paginated ? [{ name: "support", status: "Ready" }] : [],
        pagination: null,
      });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Pinecone inventory and discovered-host security", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows only Pinecone-controlled service hosts", () => {
    expect(isAllowedPineconeIndexHost("idx-project.svc.us-east-1-aws.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("idx-project.svc.aped-1234.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("pinecone.io.attacker.example")).toBe(false);
    expect(isAllowedPineconeIndexHost("127.0.0.1")).toBe(false);
  });

  it("uses the documented API version on every request", () => {
    expect(pineconeHeaders("secret-key")).toMatchObject({
      "Api-Key": "secret-key",
      "X-Pinecone-Api-Version": "2026-04",
    });
  });

  it("does not forward the API key to an untrusted discovered host", async () => {
    const fetchMock = installPineconeMock({
      indexes: [{ name: "bad", host: "metadata.google.internal" }],
    });

    const result = await fetchUsage("secret-key");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("metadata"))).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({
        "Api-Key": "secret-key",
        "X-Pinecone-Api-Version": "2026-04",
      }),
    });
    expect(JSON.stringify(result.rawData)).toContain("outside the allowed");
    expect(result.rawData).toEqual(
      expect.objectContaining({
        totalVectorCount: null,
        capabilities: expect.objectContaining({ vectorCountsComplete: false }),
      })
    );
    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "bad",
      usageQuantity: null,
      rollupRole: "metadata",
    });
  });

  it("paginates backups and assistants and inventories collections without inventing cost", async () => {
    const fetchMock = installPineconeMock({
      indexes: [
        {
          name: "docs",
          status: { ready: true, state: "Ready" },
          spec: { serverless: { cloud: "aws", region: "us-east-1" } },
        },
      ],
      paginated: true,
    });

    const result = await fetchUsage("key");

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "pinecone-index-inventory",
      authoritative: true,
    });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "pinecone-backup-inventory",
      "pinecone-collection-inventory",
      "pinecone-assistant-inventory",
    ]);
    expect(
      result.externalBillingSyncs
        ?.flatMap((sync) => sync.records)
        .every((record) => record.amountUsd == null && record.rollupRole === "metadata")
    ).toBe(true);
    expect(
      result.externalBillingSyncs?.find((sync) => sync.source === "pinecone-backup-inventory")
        ?.records
    ).toHaveLength(2);
    expect(
      result.externalBillingSyncs?.find((sync) => sync.source === "pinecone-assistant-inventory")
        ?.records
    ).toHaveLength(2);
    expect(result.rawData).toEqual(
      expect.objectContaining({
        totalVectorCount: null,
        backups: expect.arrayContaining([
          expect.objectContaining({ id: "backup-1", sizeBytes: 100 }),
          expect.objectContaining({ id: "backup-2", sizeBytes: 200 }),
        ]),
        collections: [expect.objectContaining({ name: "legacy-snapshot", sizeBytes: 300 })],
        assistants: expect.arrayContaining([
          expect.objectContaining({ name: "research" }),
          expect.objectContaining({ name: "support" }),
        ]),
      })
    );

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      "https://api.pinecone.io/backups?limit=100&paginationToken=backup%2Fnext"
    );
    expect(urls).toContain(
      "https://api.pinecone.io/assistant/assistants?limit=100&pagination_token=assistant+next"
    );
    expect(urls.filter((url) => url.includes("/collections"))).toHaveLength(1);
  });

  it("preserves a previously synced optional inventory when its endpoint is unavailable", async () => {
    installPineconeMock({ backupStatus: 403 });

    const result = await fetchUsage("key");

    expect(result.externalBilling).toMatchObject({ authoritative: true });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).not.toContain(
      "pinecone-backup-inventory"
    );
    expect(result.rawData).toEqual(
      expect.objectContaining({
        inventoryErrors: { backups: "HTTP 403" },
        capabilities: expect.objectContaining({ backupInventory: false }),
      })
    );
  });
});
