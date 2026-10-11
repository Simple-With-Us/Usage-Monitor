import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APNS_ENDPOINTS,
  APNS_TOKEN_REFRESH_MS,
  apnsConfigured,
  buildApnsPayload,
  decodeApnsPrivateKeyPem,
  fanOutApnsAlert,
  getApnsProviderToken,
  invalidateApnsProviderToken,
  loadApnsConfig,
  resolveApnsEnvironment,
  sendApnsPush,
  type ApnsConfig,
  type ApnsHttpRequest,
  type ApnsHttpResponse,
  type ApnsTransport,
} from "../apns";

const testKeyPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const testConfig = (): ApnsConfig => ({
  keyId: "KEY123456",
  teamId: "CC8UTF7ATG",
  bundleId: "com.simplewithus.usage.client.ios",
  privateKeyPem: testKeyPem,
});

const hexToken = (seed: string) =>
  Buffer.from(seed.padEnd(32, "0")).toString("hex").slice(0, 64);

function recordingTransport(responder: (req: ApnsHttpRequest) => ApnsHttpResponse): {
  transport: ApnsTransport;
  calls: ApnsHttpRequest[];
} {
  const calls: ApnsHttpRequest[] = [];
  const transport: ApnsTransport = async (req) => {
    calls.push(req);
    return responder(req);
  };
  return { transport, calls };
}

const okResponse: ApnsHttpResponse = { status: 200, body: "" };

beforeEach(() => {
  invalidateApnsProviderToken();
});

describe("loadApnsConfig", () => {
  it("requires key id, team id, bundle id, and a private key", () => {
    const base = {
      APNS_KEY_ID: "K1",
      APNS_TEAM_ID: "T1",
      APNS_BUNDLE_ID: "com.simplewithus.usage.client.ios",
      APNS_P8: testKeyPem,
    };
    expect(apnsConfigured(loadApnsConfig(base))).toBe(true);
    expect(loadApnsConfig({ ...base, APNS_KEY_ID: "" })).toBeNull();
    expect(loadApnsConfig({ ...base, APNS_TEAM_ID: "" })).toBeNull();
    expect(loadApnsConfig({ ...base, APNS_P8: "" })).toBeNull();
  });

  it("accepts APNS_P8 as raw PEM, escaped PEM, or base64", () => {
    const ids = { APNS_KEY_ID: "K1", APNS_TEAM_ID: "T1", APNS_BUNDLE_ID: "b" };
    expect(loadApnsConfig({ ...ids, APNS_P8: testKeyPem })?.privateKeyPem.trim()).toBe(testKeyPem.trim());
    expect(
      loadApnsConfig({ ...ids, APNS_P8: testKeyPem.replace(/\n/g, "\\n") })?.privateKeyPem
    ).toContain("BEGIN PRIVATE KEY");
    expect(
      loadApnsConfig({
        ...ids,
        APNS_PRIVATE_KEY_B64: Buffer.from(testKeyPem).toString("base64"),
      })?.privateKeyPem.trim()
    ).toBe(testKeyPem.trim());
  });

  it("defaults the topic to the remote Usage Monitor client bundle", () => {
    const config = loadApnsConfig({
      APNS_KEY_ID: "K1",
      APNS_TEAM_ID: "T1",
      APNS_P8: testKeyPem,
    });
    expect(config?.bundleId).toBe("com.simplewithus.usage.client.ios");
  });
});

describe("decodeApnsPrivateKeyPem", () => {
  it("rejects junk that is neither PEM nor base64 PEM", () => {
    expect(decodeApnsPrivateKeyPem("not-a-key")).toBeNull();
    expect(decodeApnsPrivateKeyPem("")).toBeNull();
  });
});

describe("resolveApnsEnvironment", () => {
  it("maps Xcode development tokens to sandbox and everything else to production", () => {
    expect(resolveApnsEnvironment("sandbox")).toBe("sandbox");
    expect(resolveApnsEnvironment("development")).toBe("sandbox");
    expect(resolveApnsEnvironment("debug")).toBe("sandbox");
    expect(resolveApnsEnvironment("production")).toBe("production");
    expect(resolveApnsEnvironment("")).toBe("production");
    expect(resolveApnsEnvironment(undefined)).toBe("production");
  });
});

describe("APNs provider token", () => {
  it("reuses the same jwt inside the refresh window and mints a new one after it", () => {
    const config = testConfig();
    const t0 = 1_700_000_000_000;
    const first = getApnsProviderToken(config, t0);
    expect(getApnsProviderToken(config, t0 + 19 * 60_000)).toBe(first);
    expect(APNS_TOKEN_REFRESH_MS).toBeLessThan(60 * 60_000);
    expect(getApnsProviderToken(config, t0 + APNS_TOKEN_REFRESH_MS + 1)).not.toBe(first);
  });

  it("signs ES256 with the kid/iss claims Apple expects", () => {
    const jwt = getApnsProviderToken(testConfig(), 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123456",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
      iss: "CC8UTF7ATG",
      iat: 1_700_000_000,
    });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });
});

describe("sendApnsPush", () => {
  it("picks the endpoint from the token environment, never from NODE_ENV", async () => {
    const seen: string[] = [];
    const transport: ApnsTransport = async (req) => {
      seen.push(req.origin);
      return okResponse;
    };
    await sendApnsPush(
      { deviceToken: hexToken("s"), environment: "sandbox", title: "t", body: "b" },
      { config: testConfig(), transport }
    );
    await sendApnsPush(
      { deviceToken: hexToken("p"), environment: "production", title: "t", body: "b" },
      { config: testConfig(), transport }
    );
    expect(seen).toEqual([APNS_ENDPOINTS.sandbox, APNS_ENDPOINTS.production]);
  });

  it("sends topic, category, and alert payload without opening Apple", async () => {
    const { transport, calls } = recordingTransport(() => okResponse);
    const token = hexToken("headers");
    await sendApnsPush(
      {
        deviceToken: token,
        environment: "production",
        title: "Budget exceeded",
        body: "OpenRouter is over budget",
        collapseId: "budget-openrouter",
        data: { tab: "alerts", alertCode: "budget_exceeded", providerId: "p1" },
      },
      { config: testConfig(), transport }
    );
    expect(calls[0].path).toBe(`/3/device/${token}`);
    expect(calls[0].headers["apns-topic"]).toBe("com.simplewithus.usage.client.ios");
    expect(calls[0].headers["apns-push-type"]).toBe("alert");
    expect(calls[0].headers["apns-collapse-id"]).toBe("budget-openrouter");
    const payload = JSON.parse(calls[0].body);
    expect(payload.aps.alert).toEqual({ title: "Budget exceeded", body: "OpenRouter is over budget" });
    expect(payload.aps.category).toBe("USAGE_ALERT");
    expect(payload.tab).toBe("alerts");
    expect(payload.alertCode).toBe("budget_exceeded");
  });

  it("classifies dead tokens, auth errors, and retryable statuses", async () => {
    const run = (status: number, reason?: string) =>
      sendApnsPush(
        { deviceToken: hexToken(`s${status}`), environment: "production", title: "t", body: "b" },
        {
          config: testConfig(),
          transport: async () => ({
            status,
            body: reason ? JSON.stringify({ reason }) : "",
          }),
        }
      );
    expect((await run(410, "Unregistered")).disposition).toBe("token_dead");
    expect((await run(400, "BadDeviceToken")).disposition).toBe("token_dead");
    expect((await run(403, "InvalidProviderToken")).disposition).toBe("auth_error");
    expect((await run(429, "TooManyProviderTokenUpdates")).disposition).toBe("retryable");
    expect((await run(503)).disposition).toBe("retryable");
    expect((await run(400, "BadTopic")).disposition).toBe("permanent");
  });

  it("never throws on a transport failure", async () => {
    const result = await sendApnsPush(
      { deviceToken: hexToken("boom"), environment: "production", title: "t", body: "b" },
      {
        config: testConfig(),
        transport: async () => {
          throw new Error("socket hang up");
        },
      }
    );
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("retryable");
    expect(result.error).toContain("socket hang up");
  });
});

describe("fanOutApnsAlert", () => {
  it("delivers to live devices and retires Apple-rejected tokens", async () => {
    const live = hexToken("live");
    const dead = hexToken("dead");
    const retired: string[] = [];
    const { transport, calls } = recordingTransport((req) =>
      req.path.endsWith(dead)
        ? { status: 410, body: JSON.stringify({ reason: "Unregistered" }) }
        : okResponse
    );

    const result = await fanOutApnsAlert({
      title: "Budget warning",
      body: "Anthropic is at 80%",
      collapseId: "budget-anthropic",
      data: { tab: "alerts", alertCode: "budget_warning" },
      devices: [
        { deviceToken: live, environment: "production" },
        { deviceToken: dead, environment: "development" },
      ],
      config: testConfig(),
      transport,
      retireToken: async (token) => {
        retired.push(token);
      },
    });

    expect(result).toEqual({
      delivered: 1,
      retired: 1,
      retryable: 0,
      authErrors: 0,
      permanent: 0,
    });
    expect(retired).toEqual([dead]);
    expect(calls.map((c) => c.origin)).toEqual([
      APNS_ENDPOINTS.production,
      APNS_ENDPOINTS.sandbox,
    ]);
  });
});

describe("buildApnsPayload", () => {
  it("keeps the alert body inside aps and uses the iOS category", () => {
    expect(buildApnsPayload({ title: "T", body: "B" })).toMatchObject({
      aps: { alert: { title: "T", body: "B" }, category: "USAGE_ALERT" },
    });
  });
});
