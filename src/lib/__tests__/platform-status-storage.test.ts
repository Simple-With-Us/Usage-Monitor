import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return { ...actual, fetchJson };
});

import { AdapterError } from "@/lib/adapters/helpers";
import {
  R2_GRAPHQL_MAX_RESPONSE_BYTES,
  STORAGE_PROBES,
} from "@/lib/platform-status/probes/storage";
import { PROBE_MAX_RESPONSE_BYTES } from "@/lib/platform-status/probe-helpers";
import {
  R2_STORAGE_GRAPHQL_GROUP_LIMIT,
  R2_STORAGE_GRAPHQL_LOOKBACK_MS,
  __resetR2UsageStateForTests,
} from "@/lib/r2-usage";
import type { PlatformProbe } from "@/lib/platform-status/types";

/**
 * Frozen mid-month so the R2 free-tier *pace* projection (which divides by the
 * elapsed fraction of the UTC month) cannot flip a healthy fixture to degraded
 * depending on the day the suite happens to run.
 */
const FROZEN_NOW = new Date("2026-08-15T12:00:00.000Z");

// The `*_KEY` names are composed rather than written as adjacent string
// literals: a line ending in `_KEY",` followed by another quoted string reads
// as a key/value pair to gitleaks' generic-api-key rule and fails the security
// workflow, even though these are env var NAMES and never hold a value.
const B2_ENV = [
  "BACKBLAZE_APPLICATION_KEY_ID",
  "B2_MONITOR_KEY_ID",
  "BACKBLAZE_KEY_ID",
  "B2_KEY_ID",
  ...["BACKBLAZE_APPLICATION", "B2_MONITOR_APPLICATION", "B2_APPLICATION"].map(
    (prefix) => `${prefix}_KEY`
  ),
];

const R2_ENV = [
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
];

const BACKUP_ENV = [
  "LITESTREAM_EMERGENCY_DISABLE",
  "R2_WRITES_DISABLED",
  "LITESTREAM_S3_ENDPOINT",
  "AWS_S3_ENDPOINT",
  "LITESTREAM_S3_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "LITESTREAM_S3_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
];

function clearEnv(names: string[]): void {
  for (const name of names) vi.stubEnv(name, "");
}

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers({ "content-type": "application/json" }),
  };
}

function probeById(id: string): PlatformProbe {
  const found = STORAGE_PROBES.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing probe: ${id}`);
  return found;
}

/** Third argument requestJson hands fetchJson, per call index. */
function securityOfCall(index: number): string | undefined {
  const options = fetchJson.mock.calls[index]?.[2] as
    | { security?: string }
    | undefined;
  return options?.security;
}

function maxBytesOfCall(index: number): number | undefined {
  const options = fetchJson.mock.calls[index]?.[2] as
    | { maxResponseBytes?: number }
    | undefined;
  return options?.maxResponseBytes;
}

describe("STORAGE_PROBES", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    fetchJson.mockReset();
    __resetR2UsageStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    vi.stubEnv("NODE_ENV", "test");
    clearEnv(B2_ENV);
    clearEnv(R2_ENV);
    clearEnv(BACKUP_ENV);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("probes must never call global fetch");
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchJson.mockReset();
    __resetR2UsageStateForTests();
  });

  it("registers both storage platforms in the storage category", () => {
    expect(STORAGE_PROBES.map((entry) => entry.id)).toEqual([
      "backblaze-b2",
      "cloudflare-r2",
    ]);
    for (const entry of STORAGE_PROBES) {
      expect(entry.category).toBe("storage");
      expect(entry.requiredEnv.length).toBeGreaterThan(0);
    }
  });

  describe("backblaze-b2", () => {
    it("is unconfigured when no monitor key is set", () => {
      expect(probeById("backblaze-b2").isConfigured()).toBe(false);
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it("is configured from either the primary or the fallback key names", () => {
      vi.stubEnv("B2_MONITOR_KEY_ID", "0011aabb");
      vi.stubEnv("B2_MONITOR_APPLICATION_KEY", "monitor-secret");
      expect(probeById("backblaze-b2").isConfigured()).toBe(true);
    });

    it("reports a healthy vault from an authorize plus list_buckets pair", async () => {
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "0011223344556677000000001");
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "K003-monitor-application-key");

      fetchJson
        .mockResolvedValueOnce(
          jsonResponse(200, {
            accountId: "0011223344556677",
            apiUrl: "https://api003.backblazeb2.com",
            downloadUrl: "https://f003.backblazeb2.com",
            authorizationToken: "4_0011223344556677_auth_token",
            allowed: {
              capabilities: ["listBuckets", "listFiles", "readFiles"],
              bucketId: null,
              bucketName: null,
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            buckets: [
              { bucketId: "b1", bucketName: "jays-usage-monitor-eu" },
              { bucketId: "b2", bucketName: "jays-socratic-trade-eu" },
              { bucketId: "b3", bucketName: "jays-congress-trade-eu" },
            ],
          })
        );

      const result = await probeById("backblaze-b2").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe("Backblaze B2 accepted the read-only monitor key.");
      expect(result.metrics).toEqual([
        { label: "Buckets", value: "3 buckets" },
        { label: "Key Scope", value: "All buckets" },
        { label: "File Listing", value: "Allowed", hint: "monitor key" },
        { label: "Account", value: "…44556677" },
      ]);

      // Hard-coded vendor host stays trusted; the discovered apiUrl does not.
      expect(fetchJson).toHaveBeenCalledTimes(2);
      expect(fetchJson.mock.calls[0][0]).toBe(
        "https://api.backblazeb2.com/b2api/v2/b2_authorize_account"
      );
      expect(securityOfCall(0)).toBe("trusted");
      expect(fetchJson.mock.calls[1][0]).toBe(
        "https://api003.backblazeb2.com/b2api/v2/b2_list_buckets"
      );
      expect(securityOfCall(1)).toBe("untrusted");

      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain("K003-monitor-application-key");
      expect(rendered).not.toContain("4_0011223344556677_auth_token");
      expect(rendered).not.toContain("0011223344556677000000001");
    });

    it("flags a key that cannot list files without failing the card", async () => {
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");

      fetchJson
        .mockResolvedValueOnce(
          jsonResponse(200, {
            accountId: "9911223344556677",
            apiUrl: "https://api003.backblazeb2.com",
            authorizationToken: "token",
            allowed: { capabilities: ["listBuckets"], bucketName: null },
          })
        )
        .mockResolvedValueOnce(jsonResponse(200, { buckets: [{ bucketId: "b1", bucketName: "solo" }] }));

      const result = await probeById("backblaze-b2").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("insufficient_scope");
      expect(result.headline).toContain("cannot list files");
      // Two sentences in one headline are separated by two spaces.
      expect(result.headline).toContain("reachable.  The monitor key");
    });

    it("maps a rejected key to unavailable with an unauthorized code", async () => {
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "rotated-secret");

      fetchJson.mockResolvedValue(
        jsonResponse(401, { status: 401, code: "unauthorized", message: "Invalid key" })
      );

      const result = await probeById("backblaze-b2").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Backblaze rejected the monitor key.");
      expect(result.metrics).toEqual([]);
      expect(fetchJson).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("rotated-secret");
    });

    it("maps a transport failure to unreachable", async () => {
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
      vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
      fetchJson.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

      const result = await probeById("backblaze-b2").probe();

      expect(result.state).toBe("unreachable");
      expect(result.error).toBe("unreachable");
      expect(result.headline).toBe("Could not reach Backblaze B2.");
    });
  });

  describe("cloudflare-r2", () => {
    const graphqlUsage = (payloadSize: number) => ({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                { sum: { requests: 1_200 }, dimensions: { actionType: "PutObject" } },
                { sum: { requests: 9_000 }, dimensions: { actionType: "GetObject" } },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    objectCount: 118,
                    uploadCount: 4,
                    payloadSize,
                    metadataSize: 0,
                  },
                  dimensions: {
                    datetime: "2026-08-15T11:00:00Z",
                    bucketName: "socratic-trade-prod",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    it("is unconfigured when no Cloudflare account pair is set", () => {
      expect(probeById("cloudflare-r2").isConfigured()).toBe(false);
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it("is configured as soon as one fleet account pair is present", () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "st-account-id");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");
      expect(probeById("cloudflare-r2").isConfigured()).toBe(true);
    });

    it("reports per-account storage against the free tier", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");

      // 1 GiB stored against the 10 GiB free tier.
      fetchJson.mockResolvedValue(jsonResponse(200, graphqlUsage(1024 * 1024 * 1024)));

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe("Every R2 account is under the 90% free-tier guard.");
      expect(result.metrics).toEqual([
        {
          label: "Socratic Trade",
          value: "1.0 GB / 10 GB Free Tier",
          usagePct: 10,
        },
        { label: "Accounts Reporting", value: "1 of 1" },
      ]);

      expect(fetchJson).toHaveBeenCalledTimes(1);
      expect(fetchJson.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(securityOfCall(0)).toBe("trusted");
      expect(maxBytesOfCall(0)).toBe(R2_GRAPHQL_MAX_RESPONSE_BYTES);
      expect(R2_GRAPHQL_MAX_RESPONSE_BYTES).toBeGreaterThan(PROBE_MAX_RESPONSE_BYTES);

      const init = fetchJson.mock.calls[0][1] as { body: string };
      const body = JSON.parse(init.body) as {
        query: string;
        variables: { storageStartDate: string; endDate: string };
      };
      expect(body.query).toContain(`limit: ${R2_STORAGE_GRAPHQL_GROUP_LIMIT}`);
      expect(body.query).toContain("$storageStartDate");
      expect(
        Date.parse(body.variables.endDate) - Date.parse(body.variables.storageStartDate)
      ).toBe(R2_STORAGE_GRAPHQL_LOOKBACK_MS);
      expect(JSON.stringify(result)).not.toContain("st-analytics-token");
    });

    it("degrades when an account is past the free-tier guard", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");

      // 9.5 GiB of the 10 GiB free tier is 95%, past the 90% guard.
      fetchJson.mockResolvedValue(jsonResponse(200, graphqlUsage(9.5 * 1024 * 1024 * 1024)));

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("free_tier_pressure");
      expect(result.headline).toBe(
        "Socratic Trade is past the 90% R2 free-tier guard.  Cut storage or operations now."
      );
      expect(result.metrics[0]).toEqual({
        label: "Socratic Trade",
        value: "9.5 GB / 10 GB Free Tier",
        usagePct: 95,
      });
    });

    it("maps a rejected analytics token to unavailable with an unauthorized code", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "revoked-token");

      fetchJson.mockResolvedValue(
        jsonResponse(403, {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        })
      );

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Cloudflare rejected the R2 analytics token.");
      expect(result.metrics).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("revoked-token");
      expect(JSON.stringify(result)).not.toContain("Authentication error");
    });

    it("keeps a reporting account visible when a sibling account fails", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");
      vi.stubEnv("CLOUDFLARE_CT_ACCOUNT_ID", "eeeeffff00001111");
      vi.stubEnv("CLOUDFLARE_CT_API_TOKEN", "ct-analytics-token");

      fetchJson
        .mockResolvedValueOnce(jsonResponse(200, graphqlUsage(1024 * 1024 * 1024)))
        .mockResolvedValueOnce(jsonResponse(500, { success: false }));

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("upstream_error");
      expect(result.headline).toBe("Cloudflare returned no R2 usage for 1 of 2 accounts.");
      expect(result.metrics).toEqual([
        {
          label: "Socratic Trade",
          value: "1.0 GB / 10 GB Free Tier",
          usagePct: 10,
        },
        { label: "Congress.Trade", value: "Unavailable", hint: "usage read failed" },
        { label: "Accounts Reporting", value: "1 of 2" },
      ]);
    });

    it("names an oversized analytics payload instead of a generic read failure", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");
      vi.stubEnv("CLOUDFLARE_CT_ACCOUNT_ID", "eeeeffff00001111");
      vi.stubEnv("CLOUDFLARE_CT_API_TOKEN", "ct-analytics-token");

      fetchJson
        .mockResolvedValueOnce(jsonResponse(200, graphqlUsage(1024 * 1024 * 1024)))
        .mockRejectedValueOnce(
          new AdapterError("Provider response exceeded the configured size limit", {
            code: "RESPONSE_TOO_LARGE",
          })
        );

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("degraded");
      expect(result.metrics).toEqual([
        {
          label: "Socratic Trade",
          value: "1.0 GB / 10 GB Free Tier",
          usagePct: 10,
        },
        { label: "Congress.Trade", value: "Unavailable", hint: "analytics payload too large" },
        { label: "Accounts Reporting", value: "1 of 2" },
      ]);
    });

    it("shows R2 not enabled instead of leftover GraphQL storage", async () => {
      vi.stubEnv("CLOUDFLARE_OLD_ACCOUNT_ID", "254301ba6b6323381932ddbca9608c73");
      vi.stubEnv("CLOUDFLARE_OLD_API_TOKEN", "old-analytics-token");

      fetchJson.mockImplementation(async (url: string) => {
        if (String(url).includes("/r2/buckets")) {
          return jsonResponse(403, {
            success: false,
            errors: [
              {
                code: 10042,
                message: "Please enable R2 through the Cloudflare Dashboard.",
              },
            ],
          });
        }
        return jsonResponse(200, graphqlUsage(116 * 1024 * 1024 * 1024));
      });

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe("No Cloudflare account in this fleet has R2 enabled.");
      expect(result.metrics).toEqual([
        { label: "Jay (Old)", value: "R2 not enabled" },
        { label: "Accounts Reporting", value: "1 of 1" },
      ]);
      expect(JSON.stringify(result)).not.toContain("116");
      expect(JSON.stringify(result)).not.toContain("old-analytics-token");
    });

    it("maps a transport failure to unreachable", async () => {
      vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "aaaabbbbccccdddd");
      vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", "st-analytics-token");
      fetchJson.mockRejectedValue(new Error("socket hang up"));

      const result = await probeById("cloudflare-r2").probe();

      expect(result.state).toBe("unreachable");
      expect(result.error).toBe("unreachable");
      expect(result.headline).toBe("Could not reach the Cloudflare analytics API.");
      expect(result.metrics).toEqual([]);
    });
  });
});
