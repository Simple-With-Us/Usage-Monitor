import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The probe reaches upstream only through `requestJson`, which wraps this
// module's `fetchJson`.  Mocking it here keeps the suite entirely offline.
vi.mock("@/lib/adapters/helpers", () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from "@/lib/adapters/helpers";
import { SECRETS_PROBES } from "../platform-status/probes/secrets";

const fetchJsonMock = vi.mocked(fetchJson);

const INFISICAL_ENV_VARS = [
  "INFISICAL_BASE_URL",
  "INFISICAL_ENV",
  "INFISICAL_AUTOMATION_CLIENT_ID",
  "INFISICAL_AUTOMATION_CLIENT_SECRET",
  "INFISICAL_ST_CLIENT_ID",
  "INFISICAL_ST_CLIENT_SECRET",
  "INFISICAL_ST_PROJECT_ID",
  "INFISICAL_ST_SECRET_PATH",
  "INFISICAL_CT_CLIENT_ID",
  "INFISICAL_CT_CLIENT_SECRET",
  "INFISICAL_CT_PROJECT_ID",
  "INFISICAL_CT_SECRET_PATH",
  "INFISICAL_SHARED_CLIENT_ID",
  "INFISICAL_SHARED_CLIENT_SECRET",
  "INFISICAL_SHARED_PROJECT_ID",
  "INFISICAL_SHARED_SECRET_PATH",
  "INFISICAL_UM_CLIENT_ID",
  "INFISICAL_UM_CLIENT_SECRET",
  "INFISICAL_UM_PROJECT_ID",
  "INFISICAL_UM_SECRET_PATH",
] as const;

const CLIENT_SECRET = "st.machine-identity.client-secret-value";
const ACCESS_TOKEN = "infisical-access-token-value";

function response(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers({ "content-type": "application/json" }),
  };
}

/** A realistic v4 list payload — names only, never values. */
function secretList(count: number, prefix = "SECRET") {
  return {
    secrets: Array.from({ length: count }, (_, index) => ({
      id: `secret-${index}`,
      secretKey: `${prefix}_${index}`,
      version: 3,
      type: "shared",
      workspace: "mock-um-project-id",
      environment: "prod",
      secretPath: "/",
    })),
    imports: [],
  };
}

const infisical = SECRETS_PROBES.find((entry) => entry.id === "infisical")!;

describe("platform-status secrets probes", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const name of INFISICAL_ENV_VARS) vi.stubEnv(name, "");
    fetchJsonMock.mockReset();
    fetchJsonMock.mockImplementation(async () => {
      throw new Error("unexpected upstream call");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchJsonMock.mockReset();
  });

  it("exposes exactly the Infisical probe in the secrets category", () => {
    expect(SECRETS_PROBES).toHaveLength(1);
    expect(infisical.name).toBe("Infisical");
    expect(infisical.category).toBe("secrets");
    expect(infisical.requiredEnv).toEqual([
      "INFISICAL_AUTOMATION_CLIENT_ID",
      "INFISICAL_AUTOMATION_CLIENT_SECRET",
    ]);
  });

  it("reports unconfigured, without any request, when no machine identity is set", async () => {
    expect(infisical.isConfigured()).toBe(false);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("treats the automation pair as credentials for every project scope", () => {
    vi.stubEnv("INFISICAL_AUTOMATION_CLIENT_ID", "automation-client-id");
    vi.stubEnv("INFISICAL_AUTOMATION_CLIENT_SECRET", CLIENT_SECRET);
    expect(infisical.isConfigured()).toBe(true);
  });

  it("ignores a half-configured identity for the purpose of being configured", () => {
    vi.stubEnv("INFISICAL_ST_CLIENT_ID", "st-client-id");
    expect(infisical.isConfigured()).toBe(false);
  });

  it("reports healthy with the visible secret count for each authenticated scope", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("INFISICAL_UM_PROJECT_ID", "mock-um-project-id");
    expect(infisical.isConfigured()).toBe(true);

    const requestedUrls: string[] = [];
    fetchJsonMock.mockImplementation(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes("/api/v1/auth/universal-auth/login")) {
        return response(200, {
          accessToken: ACCESS_TOKEN,
          expiresIn: 7200,
          tokenType: "Bearer",
        });
      }
      return response(200, secretList(12));
    });

    const result = await infisical.probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
    expect(result.headline).toBe(
      "1 machine identity authenticated.  12 secrets visible in prod."
    );
    // Fleet copy rule: two spaces between sentences in human-readable prose.
    expect(result.headline).toContain(".  ");
    expect(result.metrics).toEqual([
      { label: "Usage-Monitor", value: "12 secrets" },
      { label: "Environment", value: "prod" },
    ]);

    // Login, then list — and the list must never ask for secret values.
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toBe(
      "https://app.infisical.com/api/v1/auth/universal-auth/login"
    );
    expect(requestedUrls[1]).toContain("/api/v4/secrets?");
    expect(requestedUrls[1]).toContain("viewSecretValue=false");
    expect(requestedUrls[1]).toContain(
      "projectId=mock-um-project-id"
    );

    // No credential or token material may reach the rendered card.
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).not.toContain("um-client-id");
  });

  it("ignores a non-prod INFISICAL_ENV and flags a half-configured sibling identity", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("INFISICAL_ST_CLIENT_ID", "st-client-id-without-a-secret");
    vi.stubEnv("INFISICAL_ENV", "staging");

    fetchJsonMock.mockImplementation(async (url: string) =>
      url.includes("/login")
        ? response(200, { accessToken: ACCESS_TOKEN })
        : response(200, secretList(4))
    );

    const result = await infisical.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("incomplete_credentials");
    expect(result.headline).toBe(
      "Authenticated.  Half a credential pair is set for 1 identity."
    );
    expect(result.metrics).toEqual([
      { label: "Usage-Monitor", value: "4 secrets" },
      {
        label: "Incomplete Identities",
        value: "1 identity",
        hint: "client id and secret must both be set",
      },
      { label: "Environment", value: "prod" },
    ]);
  });

  it("degrades and names the scope when ONE identity is rejected among working ones", async () => {
    // Regression for the live production incident: the stored Socratic Trade
    // client secret was stale while CT, Shared and Automation all worked, and
    // this card claimed Infisical had "rejected the machine identity
    // credentials" wholesale.  One dead identity must not erase three live
    // ones — the operator needs to know exactly which secret to rotate.
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("INFISICAL_ST_CLIENT_ID", "st-client-id");
    vi.stubEnv("INFISICAL_ST_CLIENT_SECRET", "st-stale-secret");
    vi.stubEnv("INFISICAL_ST_PROJECT_ID", "39d93bb7-76f9-498c-8b50-a7def52e072f");

    fetchJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/auth/universal-auth/login")) {
        const body = String(init?.body ?? "");
        return body.includes("st-client-id")
          ? response(401, { statusCode: 401, message: "Unauthorized" })
          : response(200, { accessToken: ACCESS_TOKEN });
      }
      return response(200, secretList(12));
    });

    const result = await infisical.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("identity_rejected");
    expect(result.headline).toBe(
      "1 of 2 machine identities authenticated.  The stored client secret for SocraticTrade.com was rejected, so that scope's credential sync is stalled."
    );
    expect(result.headline).toContain(".  ");
    expect(result.metrics).toEqual([
      { label: "Usage-Monitor", value: "12 secrets" },
      { label: "SocraticTrade.com", value: "Rejected", hint: "HTTP 401" },
    ]);

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("st-stale-secret");
    expect(rendered).not.toContain(CLIENT_SECRET);
  });

  it("renders unavailable when the machine identity is rejected", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);

    fetchJsonMock.mockResolvedValue(
      response(401, { statusCode: 401, message: "Unauthorized", error: "Unauthorized" })
    );

    const result = await infisical.probe();

    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe(
      "Infisical rejected the machine identity credentials.  Provider credential sync cannot refresh secrets."
    );
    expect(result.metrics).toEqual([]);
  });

  it("renders degraded on a server-side upstream failure", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);

    fetchJsonMock.mockImplementation(async (url: string) =>
      url.includes("/login")
        ? response(200, { accessToken: ACCESS_TOKEN })
        : response(503, { message: "Service Unavailable" })
    );

    const result = await infisical.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("upstream_error");
    expect(result.headline).toBe(
      "Infisical returned HTTP 503.  Secret visibility could not be confirmed."
    );
  });

  it("renders unreachable when the request never completes", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);

    fetchJsonMock.mockRejectedValue(new Error("Request to https://app.infisical.com failed"));

    const result = await infisical.probe();

    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("unreachable");
    expect(result.headline).toBe(
      "Infisical did not respond.  Provider credential sync could not be verified."
    );
  });

  it("flags a scope that authenticates but shows no secrets", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);

    fetchJsonMock.mockImplementation(async (url: string) =>
      url.includes("/login")
        ? response(200, { accessToken: ACCESS_TOKEN })
        : response(200, secretList(0))
    );

    const result = await infisical.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("no_secrets_visible");
    expect(result.headline).toBe(
      "No secrets are visible in 1 project.  Provider credential sync has nothing to read there."
    );
    expect(result.metrics[0]).toEqual({ label: "Usage-Monitor", value: "0 secrets" });
  });

  it("refuses a base URL that is not an allowed Infisical host", async () => {
    vi.stubEnv("INFISICAL_UM_CLIENT_ID", "um-client-id");
    vi.stubEnv("INFISICAL_UM_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("INFISICAL_BASE_URL", "https://infisical.attacker.example");

    const result = await infisical.probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("invalid_base_url");
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});
