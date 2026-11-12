import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The probe reaches the network only through `requestJson`, which wraps this
// one function.  Mocking it here means no test in this file can touch a socket.
const { fetchJsonMock } = vi.hoisted(() => ({ fetchJsonMock: vi.fn() }));
vi.mock("@/lib/adapters/helpers", () => ({ fetchJson: fetchJsonMock }));

import { EDGE_PROBES } from "../platform-status/probes/edge";

/** Every env var `loadR2FleetAccounts` reads, across all four fleet slots. */
const CLOUDFLARE_ENV_KEYS = [
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

const UM_TOKEN = "um-token-do-not-leak";
const ST_TOKEN = "st-token-do-not-leak";
const CT_TOKEN = "ct-token-do-not-leak";
const OLD_TOKEN = "old-token-do-not-leak";

function probeResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers({ "content-type": "application/json" }),
  };
}

/** Shape of a real GET /client/v4/user/tokens/verify success body. */
function verifyBody(expiresOn?: string) {
  return {
    result: {
      id: "ed17574386854bf78a67040be0a770b0",
      status: "active",
      not_before: "2026-01-01T00:00:00Z",
      ...(expiresOn ? { expires_on: expiresOn } : {}),
    },
    success: true,
    errors: [],
    messages: [
      { code: 10000, message: "This API Token is valid and active", type: null },
    ],
  };
}

/** Shape of a real GET /client/v4/zones?account.id=…&per_page=1 success body. */
function zonesBody(totalCount: number) {
  return {
    result: [
      {
        id: "023e105f4ecef8ad9ca31a8372d0c353",
        name: "example.com",
        status: "active",
      },
    ],
    success: true,
    errors: [],
    messages: [],
    result_info: {
      page: 1,
      per_page: 1,
      count: 1,
      total_count: totalCount,
      total_pages: totalCount,
    },
  };
}

function bearerToken(init: RequestInit | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return (headers.Authorization ?? "").replace(/^Bearer\s+/, "");
}

const probe = EDGE_PROBES.find((entry) => entry.id === "cloudflare")!;

describe("EDGE_PROBES — Cloudflare", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of CLOUDFLARE_ENV_KEYS) vi.stubEnv(key, "");
    fetchJsonMock.mockReset();
    fetchJsonMock.mockImplementation(async (url: string) => {
      throw new Error(`unexpected request to ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exposes exactly one edge probe with stable identity", () => {
    expect(EDGE_PROBES).toHaveLength(1);
    expect(probe).toMatchObject({
      id: "cloudflare",
      name: "Cloudflare",
      category: "edge",
      consoleUrl: "https://dash.cloudflare.com",
    });
    expect(probe.requiredEnv).toContain("CLOUDFLARE_API_TOKEN");
    expect(probe.requiredEnv).toContain("CLOUDFLARE_ST_ACCOUNT_ID");
    expect(probe.requiredEnv).toContain("CLOUDFLARE_CT_API_TOKEN");
    expect(probe.requiredEnv).toContain("CLOUDFLARE_OLD_ACCOUNT_ID");
  });

  it("is not configured, and makes no request, when no Cloudflare env is set", () => {
    expect(probe.isConfigured()).toBe(false);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("is configured only when an account id and a token are both present", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    expect(probe.isConfigured()).toBe(false);

    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);
    expect(probe.isConfigured()).toBe(true);
  });

  it("accepts an account-owned token that the user endpoint rejects", async () => {
    // Regression for the live incident that burned real operator trust: the
    // fleet's ST/CT tokens are ACCOUNT-OWNED and 401 at /user/tokens/verify by
    // design while being perfectly valid.  Verifying only the user endpoint
    // reported them as expired for days.  A token is dead only when BOTH
    // endpoints reject it.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/acct-um-0001/tokens/verify")) {
        return probeResponse(200, verifyBody());
      }
      if (url.includes("/user/tokens/verify")) {
        return probeResponse(401, { success: false, errors: [{ code: 9109 }] });
      }
      if (url.includes("/zones?")) return probeResponse(200, zonesBody(1));
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
    expect(result.headline).toBe("Usage Monitor API token is valid.");
  });

  it("accepts a user-owned token that the account endpoint rejects", async () => {
    // The inverse kind: user-owned tokens 401 at /accounts/{id}/tokens/verify.
    // The probe tries the account endpoint first, so the fallback must run.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/acct-um-0001/tokens/verify")) {
        return probeResponse(401, { success: false, errors: [{ code: 9109 }] });
      }
      if (url.includes("/user/tokens/verify")) {
        return probeResponse(200, verifyBody());
      }
      if (url.includes("/zones?")) return probeResponse(200, zonesBody(1));
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
  });

  it("reports a healthy single account with zones and token expiry", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/tokens/verify")) {
        return probeResponse(200, verifyBody("2026-12-31T23:59:59Z"));
      }
      if (url.includes("/zones?")) return probeResponse(200, zonesBody(7));
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("Usage Monitor API token is valid.");
    expect(result.error).toBeUndefined();
    // Single account: no "Accounts Verified" roll-up, it would just repeat.
    expect(result.metrics).toEqual([
      { label: "Usage Monitor", value: "Token active" },
      { label: "Zones", value: "7 zones" },
      { label: "Token Expiry", value: "2026-12-31" },
    ]);

    // The account id is scoped into the zones query; the token never is.
    const zoneCall = fetchJsonMock.mock.calls.find((call) =>
      String(call[0]).includes("/zones?")
    );
    expect(String(zoneCall?.[0])).toContain("account.id=acct-um-0001");
    expect(bearerToken(zoneCall?.[1])).toBe(UM_TOKEN);
    expect(JSON.stringify(result)).not.toContain(UM_TOKEN);
  });

  it("rolls up three accounts and never exceeds the six-metric budget", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);
    vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "acct-st-0002");
    vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", ST_TOKEN);
    vi.stubEnv("CLOUDFLARE_CT_ACCOUNT_ID", "acct-ct-0003");
    vi.stubEnv("CLOUDFLARE_CT_API_TOKEN", CT_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const token = bearerToken(init);
      if (url.includes("/tokens/verify")) {
        // Only the CT token carries an expiry, so it must be the one reported.
        return probeResponse(
          200,
          verifyBody(token === CT_TOKEN ? "2026-09-30T00:00:00Z" : undefined)
        );
      }
      if (url.includes("/zones?")) {
        const zones = token === UM_TOKEN ? 4 : token === ST_TOKEN ? 2 : 1;
        return probeResponse(200, zonesBody(zones));
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("All 3 Cloudflare API tokens are valid.");
    expect(result.metrics).toHaveLength(6);
    expect(result.metrics).toEqual([
      { label: "Accounts Verified", value: "3 of 3" },
      { label: "Usage Monitor", value: "Token active" },
      { label: "Socratic Trade", value: "Token active" },
      { label: "Congress.Trade", value: "Token active" },
      { label: "Zones", value: "7 zones", hint: "across verified accounts" },
      { label: "Token Expiry", value: "2026-09-30", hint: "Congress.Trade" },
    ]);
    const serialized = JSON.stringify(result);
    for (const token of [UM_TOKEN, ST_TOKEN, CT_TOKEN]) {
      expect(serialized).not.toContain(token);
    }
  });

  it("rolls up four accounts and still stays inside the six-metric budget", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);
    vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "acct-st-0002");
    vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", ST_TOKEN);
    vi.stubEnv("CLOUDFLARE_CT_ACCOUNT_ID", "acct-ct-0003");
    vi.stubEnv("CLOUDFLARE_CT_API_TOKEN", CT_TOKEN);
    vi.stubEnv("CLOUDFLARE_OLD_ACCOUNT_ID", "acct-old-0004");
    vi.stubEnv("CLOUDFLARE_OLD_API_TOKEN", OLD_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const token = bearerToken(init);
      if (url.includes("/tokens/verify")) {
        return probeResponse(200, verifyBody());
      }
      if (url.includes("/zones?")) {
        const zones =
          token === UM_TOKEN ? 2 : token === ST_TOKEN ? 2 : token === CT_TOKEN ? 1 : 0;
        return probeResponse(200, zonesBody(zones));
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("All 4 Cloudflare API tokens are valid.");
    expect(result.metrics.length).toBeLessThanOrEqual(6);
    expect(result.metrics).toContainEqual({
      label: "Accounts Verified",
      value: "4 of 4",
    });
    expect(result.metrics).toContainEqual({
      label: "Jay (Old)",
      value: "Token active",
    });
    expect(JSON.stringify(result)).not.toContain(OLD_TOKEN);
  });

  it("degrades and names the failing account by label when one token is rejected", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);
    vi.stubEnv("CLOUDFLARE_ST_ACCOUNT_ID", "acct-st-0002");
    vi.stubEnv("CLOUDFLARE_ST_API_TOKEN", ST_TOKEN);
    vi.stubEnv("CLOUDFLARE_CT_ACCOUNT_ID", "acct-ct-0003");
    vi.stubEnv("CLOUDFLARE_CT_API_TOKEN", CT_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const token = bearerToken(init);
      if (url.includes("/tokens/verify")) {
        if (token === ST_TOKEN) {
          return probeResponse(401, {
            success: false,
            errors: [{ code: 1000, message: "Invalid API Token" }],
            result: null,
          });
        }
        return probeResponse(200, verifyBody());
      }
      if (url.includes("/zones?")) return probeResponse(200, zonesBody(3));
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("degraded");
    // Two sentences, two spaces between them (fleet copy rule).
    expect(result.headline).toBe(
      "Socratic Trade failed token verification.  2 of 3 accounts still authenticate."
    );
    expect(result.error).toBe("unauthorized");
    expect(result.metrics).toContainEqual({
      label: "Socratic Trade",
      value: "Token rejected",
    });
    expect(result.metrics).toContainEqual({
      label: "Usage Monitor",
      value: "Token active",
    });
    // A rejected token is never re-used for a zones lookup.
    const stZoneCalls = fetchJsonMock.mock.calls.filter(
      (call) =>
        String(call[0]).includes("/zones?") &&
        bearerToken(call[1] as RequestInit) === ST_TOKEN
    );
    expect(stZoneCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(ST_TOKEN);
  });

  it("maps a 403 on the only account to unavailable / unauthorized", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/tokens/verify")) {
        return probeResponse(403, {
          success: false,
          errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
          result: null,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result).toEqual({
      state: "unavailable",
      headline: "Cloudflare rejected the Usage Monitor API token.",
      metrics: [],
      error: "unauthorized",
    });
  });

  it("maps a 500 to degraded / upstream_error without throwing", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async () =>
      probeResponse(500, { success: false, errors: [], result: null })
    );

    const result = await probe.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("upstream_error");
    expect(result.metrics).toEqual([]);
  });

  it("treats a 200 response for a non-active token as rejected credentials", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/tokens/verify")) {
        return probeResponse(200, {
          result: { id: "ed17574386854bf78a67040be0a770b0", status: "expired" },
          success: true,
          errors: [],
          messages: [],
        });
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe("Cloudflare rejected the Usage Monitor API token.");
  });

  it("maps a transport failure to unreachable and a timeout to timeout", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async () => {
      throw new Error("Request to https://api.cloudflare.com failed: network error");
    });
    const offline = await probe.probe();
    expect(offline.state).toBe("unreachable");
    expect(offline.error).toBe("unreachable");
    expect(offline.headline).toBe("Could not reach the Cloudflare API.");

    fetchJsonMock.mockImplementation(async () => {
      throw new Error("Request to https://api.cloudflare.com timed out after 8000ms");
    });
    const slow = await probe.probe();
    expect(slow.state).toBe("unreachable");
    expect(slow.error).toBe("timeout");
  });

  it("stays healthy when the token cannot read zones", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-um-0001");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", UM_TOKEN);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/tokens/verify")) return probeResponse(200, verifyBody());
      if (url.includes("/zones?")) {
        return probeResponse(403, {
          success: false,
          errors: [{ code: 9109, message: "Unauthorized" }],
          result: null,
        });
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await probe.probe();

    expect(result.state).toBe("healthy");
    expect(result.metrics).toEqual([
      { label: "Usage Monitor", value: "Token active" },
      { label: "Token Expiry", value: "No expiry set" },
    ]);
  });
});
