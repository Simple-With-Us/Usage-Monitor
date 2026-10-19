import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Developer & release platform probes.  The network is stubbed at the adapter
 * boundary (`fetchJson`) that `probe-helpers.requestJson` wraps, so nothing in
 * this file touches GitHub or Apple.
 *
 * Every case freezes the clock: both probes render relative ages ("3h ago",
 * "in 42m") and this repo has been burned before by fixtures whose dates were
 * pinned to a real calendar month.
 */

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return { ...actual, fetchJson };
});

import { DEVELOPER_PROBES } from "../platform-status/probes/developer";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const GITHUB_TOKEN_VARS = ["GITHUB_TOKEN", "GITHUB_API_TOKEN", "GITHUB_PAT"] as const;
const ASC_VARS = ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"] as const;

const ecKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ASC_PRIVATE_KEY_PEM = ecKeyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function probeById(id: string) {
  const probe = DEVELOPER_PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`No probe registered for ${id}`);
  return probe;
}

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

function clearProbeEnv() {
  for (const name of [...GITHUB_TOKEN_VARS, ...ASC_VARS]) vi.stubEnv(name, "");
}

function configureGitHub() {
  vi.stubEnv("GITHUB_TOKEN", "ghp-test-token-never-rendered");
}

function configureAppStoreConnect(privateKey = ASC_PRIVATE_KEY_PEM) {
  vi.stubEnv("ASC_ISSUER_ID", "57246542-96fe-1a63-e053-0824d011072a");
  vi.stubEnv("ASC_KEY_ID", "2X9R4HXF34");
  vi.stubEnv("ASC_PRIVATE_KEY", privateKey);
}

function rateLimitBody(coreRemaining = 4_832, coreLimit = 5_000) {
  return {
    resources: {
      core: { limit: coreLimit, remaining: coreRemaining, reset: NOW_SECONDS + 2_520, used: coreLimit - coreRemaining },
      graphql: { limit: 5_000, remaining: 4_900, reset: NOW_SECONDS + 1_800, used: 100 },
      search: { limit: 30, remaining: 30, reset: NOW_SECONDS + 60, used: 0 },
    },
    rate: { limit: coreLimit, remaining: coreRemaining, reset: NOW_SECONDS + 2_520, used: coreLimit - coreRemaining },
  };
}

function workflowRunsBody(overrides: Record<string, unknown> = {}) {
  return {
    total_count: 482,
    workflow_runs: [
      {
        id: 19284756301,
        name: "CI",
        head_branch: "main",
        run_number: 482,
        event: "push",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-11T11:40:00.000Z",
        updated_at: "2026-08-11T11:46:00.000Z",
        html_url: "https://github.com/Simple-With-Us/Usage-Monitor/actions/runs/19284756301",
        ...overrides,
      },
    ],
  };
}

function buildsBody() {
  return {
    data: [
      {
        type: "builds",
        id: "5b1a8f2c-0000-4000-8000-1c0de0000001",
        attributes: {
          version: "141",
          uploadedDate: "2026-08-04T09:12:00.000Z",
          expirationDate: "2026-11-02T09:12:00.000Z",
          expired: false,
          processingState: "VALID",
          usesNonExemptEncryption: false,
        },
      },
      {
        type: "builds",
        id: "5b1a8f2c-0000-4000-8000-1c0de0000002",
        attributes: {
          version: "142",
          uploadedDate: "2026-08-11T09:00:00.000Z",
          expirationDate: "2026-11-09T12:00:00.000Z",
          expired: false,
          processingState: "VALID",
          usesNonExemptEncryption: false,
        },
      },
      {
        type: "builds",
        id: "5b1a8f2c-0000-4000-8000-1c0de0000003",
        attributes: {
          version: "140",
          uploadedDate: "2026-07-28T18:30:00.000Z",
          expirationDate: "2026-10-26T18:30:00.000Z",
          expired: false,
          processingState: "PROCESSING",
        },
      },
    ],
    meta: { paging: { total: 3, limit: 5 } },
  };
}

/** Pull the JWT the probe sent to Apple out of the stubbed request. */
function capturedBearerToken(callIndex = 0): string {
  const init = fetchJson.mock.calls[callIndex]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  const authorization = init?.headers?.Authorization ?? "";
  expect(authorization.startsWith("Bearer ")).toBe(true);
  return authorization.slice("Bearer ".length);
}

describe("developer platform probes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fetchJson.mockReset();
    fetchJson.mockImplementation(async () => {
      throw new Error("unexpected upstream request");
    });
    clearProbeEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    fetchJson.mockReset();
  });

  it("registers both developer cards with stable ids", () => {
    expect(DEVELOPER_PROBES.map((probe) => probe.id)).toEqual(["github", "app-store-connect"]);
    for (const probe of DEVELOPER_PROBES) expect(probe.category).toBe("developer");
  });

  describe("github", () => {
    it("is not configured when no token env var is set", () => {
      expect(probeById("github").isConfigured()).toBe(false);
    });

    it("is configured from any of the accepted token env var names", () => {
      for (const name of GITHUB_TOKEN_VARS) {
        clearProbeEnv();
        vi.stubEnv(name, "token-value");
        expect(probeById("github").isConfigured()).toBe(true);
      }
    });

    it("renders rate-limit headroom and the latest workflow run when healthy", async () => {
      configureGitHub();
      fetchJson
        .mockResolvedValueOnce(jsonResponse(rateLimitBody()))
        .mockResolvedValueOnce(jsonResponse(workflowRunsBody()));

      const result = await probeById("github").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe(
        "GitHub API is responding with 97% rate-limit headroom.  Latest CI run passed."
      );
      expect(result.metrics).toEqual([
        { label: "Core Rate Limit", value: "4,832 of 5,000 calls left", hint: "resets in 42m" },
        { label: "Core Headroom", value: "97%" },
        { label: "GraphQL Rate Limit", value: "4,900 of 5,000 calls left" },
        { label: "Latest Workflow", value: "CI", hint: "main · run #482" },
        { label: "Run Conclusion", value: "Success", hint: "14m ago" },
      ]);
      expect(result.metrics.length).toBeLessThanOrEqual(6);

      const rateLimitUrl = fetchJson.mock.calls[0]?.[0] as string;
      const runsUrl = fetchJson.mock.calls[1]?.[0] as string;
      expect(rateLimitUrl).toBe("https://api.github.com/rate_limit");
      expect(runsUrl).toBe(
        "https://api.github.com/repos/Simple-With-Us/Usage-Monitor/actions/runs?per_page=1"
      );
      expect(JSON.stringify(result)).not.toContain("ghp-test-token-never-rendered");
    });

    it("goes degraded and names the workflow when the latest run failed", async () => {
      configureGitHub();
      fetchJson
        .mockResolvedValueOnce(jsonResponse(rateLimitBody()))
        .mockResolvedValueOnce(
          jsonResponse(workflowRunsBody({ name: "Release", conclusion: "failure" }))
        );

      const result = await probeById("github").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("workflow_failed");
      expect(result.headline).toBe(
        "Latest Release run failed.  GitHub API headroom is 97%."
      );
    });

    it("goes degraded when core rate-limit headroom is nearly exhausted", async () => {
      configureGitHub();
      fetchJson
        .mockResolvedValueOnce(jsonResponse(rateLimitBody(200, 5_000)))
        .mockResolvedValueOnce(jsonResponse(workflowRunsBody()));

      const result = await probeById("github").probe();

      expect(result.state).toBe("degraded");
      expect(result.headline).toBe(
        "GitHub API rate limit is nearly exhausted at 4% headroom."
      );
    });

    it("keeps the rate-limit card when the Actions read is not permitted", async () => {
      configureGitHub();
      fetchJson
        .mockResolvedValueOnce(jsonResponse(rateLimitBody()))
        .mockResolvedValueOnce(jsonResponse({ message: "Resource not accessible" }, 403));

      const result = await probeById("github").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "GitHub API is responding with 97% rate-limit headroom.  Workflow runs are not readable with this token."
      );
      expect(result.metrics.map((entry) => entry.label)).toEqual([
        "Core Rate Limit",
        "Core Headroom",
        "GraphQL Rate Limit",
      ]);
    });

    it("maps a rejected token to unavailable without a second request", async () => {
      configureGitHub();
      fetchJson.mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, 401));

      const result = await probeById("github").probe();

      expect(result).toEqual({
        state: "unavailable",
        headline: "GitHub rejected the token.",
        metrics: [],
        error: "unauthorized",
      });
      expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    it("maps a 500 to degraded and a transport failure to unreachable", async () => {
      configureGitHub();
      fetchJson.mockResolvedValueOnce(jsonResponse({ message: "server error" }, 500));
      await expect(probeById("github").probe()).resolves.toMatchObject({
        state: "degraded",
        error: "upstream_error",
      });

      fetchJson.mockReset();
      fetchJson.mockRejectedValueOnce(new Error("socket hang up"));
      await expect(probeById("github").probe()).resolves.toEqual({
        state: "unreachable",
        headline: "GitHub API is unreachable.",
        metrics: [],
        error: "unreachable",
      });
    });
  });

  describe("app store connect", () => {
    it("is not configured when the Apple credentials are absent", () => {
      expect(probeById("app-store-connect").isConfigured()).toBe(false);
    });

    it("is not configured when only part of the credential set is present", () => {
      vi.stubEnv("ASC_ISSUER_ID", "issuer");
      vi.stubEnv("ASC_KEY_ID", "key");
      expect(probeById("app-store-connect").isConfigured()).toBe(false);
      vi.stubEnv("ASC_PRIVATE_KEY", ASC_PRIVATE_KEY_PEM);
      expect(probeById("app-store-connect").isConfigured()).toBe(true);
    });

    it("signs an ES256 token whose signature is 64-byte R||S, not DER", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(jsonResponse(buildsBody()));

      await probeById("app-store-connect").probe();

      const [encodedHeader, encodedPayload, encodedSignature] =
        capturedBearerToken().split(".");
      const signature = Buffer.from(encodedSignature, "base64url");

      // A DER signature is 70-72 bytes and variable length; JOSE ES256 is
      // exactly two fixed-width 32-byte components.
      expect(signature.byteLength).toBe(64);

      expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({
        alg: "ES256",
        kid: "2X9R4HXF34",
        typ: "JWT",
      });
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      expect(payload).toMatchObject({
        iss: "57246542-96fe-1a63-e053-0824d011072a",
        aud: "appstoreconnect-v1",
        iat: NOW_SECONDS,
      });
      expect(payload.exp - payload.iat).toBe(600);

      // The decisive check: the R||S bytes must verify against the public key.
      expect(
        verify(
          "SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          { key: ecKeyPair.publicKey, dsaEncoding: "ieee-p1363" },
          signature
        )
      ).toBe(true);
    });

    it("produces a fixed-width signature across repeated signings", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(jsonResponse(buildsBody()));

      for (let attempt = 0; attempt < 20; attempt += 1) {
        fetchJson.mockClear();
        await probeById("app-store-connect").probe();
        const [encodedHeader, encodedPayload, encodedSignature] =
          capturedBearerToken().split(".");
        const signature = Buffer.from(encodedSignature, "base64url");
        expect(signature.byteLength).toBe(64);
        expect(
          verify(
            "SHA256",
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            { key: ecKeyPair.publicKey, dsaEncoding: "ieee-p1363" },
            signature
          )
        ).toBe(true);
      }
    });

    it("accepts a newline-escaped PEM from a single-line env var", async () => {
      configureAppStoreConnect(ASC_PRIVATE_KEY_PEM.replace(/\n/g, "\\n"));
      fetchJson.mockResolvedValue(jsonResponse(buildsBody()));

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("healthy");
      expect(Buffer.from(capturedBearerToken().split(".")[2], "base64url").byteLength).toBe(64);
    });

    it("renders the newest build and its processing state when healthy", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(jsonResponse(buildsBody()));

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe(
        "Latest build 142 is processed and ready in App Store Connect."
      );
      expect(result.metrics).toEqual([
        { label: "Latest Build", value: "142", hint: "uploaded 3h ago" },
        { label: "Processing State", value: "Valid" },
        { label: "Builds In Processing", value: "1 build" },
        { label: "Recent Builds", value: "3 builds", hint: "latest 5" },
        { label: "Build Expiry", value: "in 90d" },
      ]);
      expect(result.metrics.length).toBeLessThanOrEqual(6);
      expect(fetchJson.mock.calls[0]?.[0]).toBe(
        "https://api.appstoreconnect.apple.com/v1/builds?sort=-uploadedDate&limit=5"
      );
      expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    });

    it("asks Apple to sort by newest upload before the page is limited", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(jsonResponse(buildsBody()));

      await probeById("app-store-connect").probe();

      // `limit` without `sort` returns an arbitrary partial page once the
      // account has more than five builds, so the newest build can be absent
      // from the response and no in-memory comparison can recover it.
      const requested = new URL(fetchJson.mock.calls[0]?.[0] as string);
      expect(requested.searchParams.get("sort")).toBe("-uploadedDate");
      expect(requested.searchParams.get("limit")).toBe("5");
    });

    it("surfaces a failed newest build on an account with more builds than the page", async () => {
      configureAppStoreConnect();
      // What Apple returns for `sort=-uploadedDate&limit=5` on a busy account:
      // the five newest uploads, newest first, with older ones cut off.  The
      // failure an operator must see is the one at the top.
      fetchJson.mockResolvedValue(
        jsonResponse({
          data: [
            { version: "150", uploaded: "2026-08-11T09:00:00.000Z", state: "FAILED" },
            { version: "149", uploaded: "2026-08-10T09:00:00.000Z", state: "VALID" },
            { version: "148", uploaded: "2026-08-09T09:00:00.000Z", state: "VALID" },
            { version: "147", uploaded: "2026-08-08T09:00:00.000Z", state: "VALID" },
            { version: "146", uploaded: "2026-08-07T09:00:00.000Z", state: "VALID" },
          ].map((build, index) => ({
            type: "builds",
            id: `5b1a8f2c-0000-4000-8000-1c0de00001${index}`,
            attributes: {
              version: build.version,
              uploadedDate: build.uploaded,
              expired: false,
              processingState: build.state,
            },
          })),
          meta: { paging: { total: 37, limit: 5 } },
        })
      );

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("build_processing_failed");
      expect(result.headline).toBe(
        "Latest build 150 failed processing in App Store Connect."
      );
      expect(result.metrics).toContainEqual({
        label: "Latest Build",
        value: "150",
        hint: "uploaded 3h ago",
      });
    });

    it("goes degraded when Apple failed to process the newest build", async () => {
      configureAppStoreConnect();
      const body = buildsBody();
      body.data[1].attributes.processingState = "FAILED";
      fetchJson.mockResolvedValue(jsonResponse(body));

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("build_processing_failed");
      expect(result.headline).toBe(
        "Latest build 142 failed processing in App Store Connect."
      );
    });

    it("maps a rejected key to unavailable", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(
        jsonResponse({ errors: [{ status: "401", code: "NOT_AUTHORIZED" }] }, 401)
      );

      const result = await probeById("app-store-connect").probe();

      expect(result).toEqual({
        state: "unavailable",
        headline: "App Store Connect rejected the API key.",
        metrics: [],
        error: "unauthorized",
      });
    });

    it("reports an unusable private key without leaking key material or calling out", async () => {
      configureAppStoreConnect("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----");

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("invalid_credentials");
      expect(result.headline).toBe(
        "App Store Connect key could not sign a request.  Check ASC_PRIVATE_KEY and ASC_KEY_ID."
      );
      expect(JSON.stringify(result)).not.toContain("not-a-real-key");
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it("rejects a non-EC key rather than emitting an invalid token", async () => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      configureAppStoreConnect(rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString());

      const result = await probeById("app-store-connect").probe();

      expect(result).toMatchObject({ state: "unavailable", error: "invalid_credentials" });
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it("stays healthy with an explicit note when the account has no builds", async () => {
      configureAppStoreConnect();
      fetchJson.mockResolvedValue(jsonResponse({ data: [], meta: { paging: { total: 0 } } }));

      const result = await probeById("app-store-connect").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "App Store Connect is reachable.  No builds have been uploaded yet."
      );
    });

    it("maps a transport failure to unreachable", async () => {
      configureAppStoreConnect();
      fetchJson.mockRejectedValue(new Error("Request to https://api.appstoreconnect.apple.com timed out after 8000ms"));

      const result = await probeById("app-store-connect").probe();

      expect(result).toEqual({
        state: "unreachable",
        headline: "App Store Connect is unreachable.",
        metrics: [],
        error: "timeout",
      });
    });
  });
});
