import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_SETTING_DEFS,
  APP_SETTING_KEYS,
  AppSettingsService,
  appSettings,
} from "@/lib/app-settings";

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a mock fetch with canned login + raw-secrets responses. */
function makeMockFetch(overrides?: {
  loginStatus?: number;
  rawSecrets?: Array<{ secretKey: string; secretValue: string }>;
  rawStatus?: number;
  patchStatus?: number;
  onCall?: (call: RecordedCall) => void;
}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    const call = { url: urlStr, method, body };
    calls.push(call);
    overrides?.onCall?.(call);
    if (urlStr.includes("/universal-auth/login")) {
      if ((overrides?.loginStatus ?? 200) !== 200) {
        return jsonResponse({ error: "bad auth" }, overrides?.loginStatus);
      }
      return jsonResponse({ accessToken: "test-access-token", expiresIn: 1800 });
    }
    if (urlStr.includes("/api/v3/secrets/raw/")) {
      // Single-secret write path (PATCH, then POST-on-404).
      return jsonResponse({}, overrides?.patchStatus ?? 200);
    }
    if (urlStr.includes("/api/v3/secrets/raw")) {
      if ((overrides?.rawStatus ?? 200) !== 200) {
        return jsonResponse({ error: "boom" }, overrides?.rawStatus);
      }
      return jsonResponse({
        secrets: overrides?.rawSecrets ?? [
          { secretKey: "ADAPTER_HTTP_TIMEOUT_MS", secretValue: "10000" },
          { secretKey: "ALERT_MIN_SEVERITY", secretValue: "critical" },
          { secretKey: "USAGE_SCHEDULER_ENABLED", secretValue: "true" },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${method} ${urlStr}`);
  });
  return { fetchImpl, calls };
}

function clearInfisicalCredEnv() {
  for (const name of [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_AUTOMATION_CLIENT_ID",
    "INFISICAL_AUTOMATION_CLIENT_SECRET",
  ]) {
    delete process.env[name];
  }
}

beforeEach(() => {
  appSettings._resetForTests();
  clearInfisicalCredEnv();
});

describe("app-settings (Infisical SOT tunable knobs)", () => {
  it("init loads the full secret set into the in-memory cache", async () => {
    const { fetchImpl, calls } = makeMockFetch();
    await appSettings.init({
      clientId: "id",
      clientSecret: "secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(appSettings.isInfisicalMode).toBe(true);
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    expect(appSettings.get("ALERT_MIN_SEVERITY")).toBe("critical");
    expect(appSettings.has("USAGE_SCHEDULER_ENABLED")).toBe(true);
    expect(appSettings.getAll()["ADAPTER_HTTP_TIMEOUT_MS"]).toBe("10000");
    // Login + one raw-secrets GET.
    expect(calls.filter((c) => c.url.includes("/universal-auth/login"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/secrets/raw"))).toHaveLength(1);
  });

  it("runtime reads make zero network calls after init", async () => {
    const { fetchImpl, calls } = makeMockFetch();
    await appSettings.init({
      clientId: "id",
      clientSecret: "secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const baseline = calls.length;
    expect(baseline).toBeGreaterThan(0);

    appSettings.get("ADAPTER_HTTP_TIMEOUT_MS");
    appSettings.get("MISSING_KEY");
    appSettings.has("ALERT_MIN_SEVERITY");
    appSettings.getAll();
    appSettings.getBool("USAGE_SCHEDULER_ENABLED", false);
    appSettings.getInt("ADAPTER_HTTP_TIMEOUT_MS", 30000, { min: 1 });
    appSettings.getFloat("ALERT_UNASSIGNED_SPEND_FLOOR_USD", 25, { min: 0 });
    appSettings.getWithSource("ALERT_MIN_SEVERITY");
    appSettings.getAllMeta();
    expect(() => appSettings.getRequired("ADAPTER_HTTP_TIMEOUT_MS")).not.toThrow();
    expect(() => appSettings.getRequired("MISSING_KEY")).toThrow(/INFISICAL\.md/);

    expect(calls.length).toBe(baseline);
  });

  it("set() writes to Infisical BEFORE updating the cache (ordering)", async () => {
    const seenDuringPatch: Array<string | undefined> = [];
    const { fetchImpl } = makeMockFetch({
      onCall: (call) => {
        if (call.method === "PATCH") {
          // If the cache were updated first, this would already read "20000".
          seenDuringPatch.push(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS"));
        }
      },
    });
    await appSettings.init({
      clientId: "id",
      clientSecret: "secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const normalized = await appSettings.set("ADAPTER_HTTP_TIMEOUT_MS", "20000");
    expect(normalized).toBe("20000");
    expect(seenDuringPatch).toEqual(["10000"]); // old value still in cache during PATCH
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("20000"); // cache updated after
  });

  it("failed write-through rejects and leaves the cache untouched", async () => {
    const { fetchImpl, calls } = makeMockFetch({ patchStatus: 500 });
    await appSettings.init({
      clientId: "id",
      clientSecret: "secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      appSettings.set("ADAPTER_HTTP_TIMEOUT_MS", "20000")
    ).rejects.toThrow(/write-through failed/);
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("failed refresh keeps serving the last-known-good cache", async () => {
    let failRaw = false;
    const { fetchImpl } = makeMockFetch();
    const flakyFetch = (async (url: unknown, init?: RequestInit) => {
      if (failRaw && String(url).includes("/api/v3/secrets/raw")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      return fetchImpl(url, init);
    }) as typeof fetch;

    await appSettings.init({
      clientId: "id",
      clientSecret: "secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: flakyFetch,
    });
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");

    failRaw = true;
    await expect(appSettings.refresh()).rejects.toThrow();
    // Last-known-good cache is untouched.
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    expect(appSettings.isInfisicalMode).toBe(true);
  });

  it("init without credentials stays in env-fallback mode with zero network calls", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be touched in env-fallback mode");
    });
    process.env.ADAPTER_HTTP_TIMEOUT_MS = "12345";

    await appSettings.init({ fetchImpl: fetchImpl as typeof fetch });
    expect(appSettings.isInfisicalMode).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appSettings.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("12345");
    expect(appSettings.get("UNSET_KNOB_XYZ")).toBeUndefined();

    delete process.env.ADAPTER_HTTP_TIMEOUT_MS;
  });

  it("init degrades to env-fallback mode (loudly) when the Infisical load fails", async () => {
    const { fetchImpl } = makeMockFetch({ loginStatus: 401 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ALERT_MIN_SEVERITY = "info";

    await appSettings.init({
      clientId: "id",
      clientSecret: "bad-secret",
      environment: "dev",
      refreshIntervalMs: 0,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(appSettings.isInfisicalMode).toBe(false);
    expect(appSettings.get("ALERT_MIN_SEVERITY")).toBe("info");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    delete process.env.ALERT_MIN_SEVERITY;
  });

  it("typed getters parse, bound, and fall back", () => {
    process.env.USAGE_SCHEDULER_ENABLED = "yes";
    process.env.ADAPTER_HTTP_TIMEOUT_MS = "not-a-number";
    process.env.ALERT_UNASSIGNED_SPEND_FLOOR_USD = "12.5";

    expect(appSettings.getBool("USAGE_SCHEDULER_ENABLED", false)).toBe(true);
    expect(appSettings.getBool("MISSING", true)).toBe(true);
    expect(appSettings.getInt("ADAPTER_HTTP_TIMEOUT_MS", 30000, { min: 1 })).toBe(30000);
    expect(appSettings.getFloat("ALERT_UNASSIGNED_SPEND_FLOOR_USD", 25, { min: 0 })).toBe(12.5);

    process.env.ADAPTER_HTTP_TIMEOUT_MS = "-5";
    expect(appSettings.getInt("ADAPTER_HTTP_TIMEOUT_MS", 30000, { min: 1 })).toBe(30000);

    delete process.env.USAGE_SCHEDULER_ENABLED;
    delete process.env.ADAPTER_HTTP_TIMEOUT_MS;
    delete process.env.ALERT_UNASSIGNED_SPEND_FLOOR_USD;
  });

  it("set() validates keys and values against the schema", async () => {
    await appSettings.init(); // env-fallback mode
    await expect(appSettings.set("NOT_A_KNOB", "x")).rejects.toThrow(/not a writable app setting/);
    await expect(appSettings.set("USAGE_SCHEDULER_ENABLED", "maybe")).rejects.toThrow(/Invalid boolean/);
    await expect(appSettings.set("ADAPTER_HTTP_TIMEOUT_MS", "-1")).rejects.toThrow(/must be >= 1/);
    await expect(appSettings.set("ALERT_MIN_SEVERITY", "panic")).rejects.toThrow(/expected one of/);

    // Valid write in env mode lands in process.env (local-dev parity).
    const normalized = await appSettings.set("ALERT_MIN_SEVERITY", "INFO");
    expect(normalized).toBe("info");
    expect(process.env.ALERT_MIN_SEVERITY).toBe("info");
    delete process.env.ALERT_MIN_SEVERITY;
  });

  it("settingsEnv() overlays knob keys and passes everything else through", () => {
    process.env.ALERT_MIN_SEVERITY = "critical";
    process.env.SOME_UNRELATED_SECRET = "shh";

    const overlay = appSettings.settingsEnv();
    expect(overlay.ALERT_MIN_SEVERITY).toBe("critical");
    expect(overlay.SOME_UNRELATED_SECRET).toBe("shh");
    expect(APP_SETTING_KEYS.has("ALERT_MIN_SEVERITY")).toBe(true);

    delete process.env.ALERT_MIN_SEVERITY;
    delete process.env.SOME_UNRELATED_SECRET;
  });

  it("every schema entry is a documented writable knob with a default", () => {
    expect(APP_SETTING_DEFS.length).toBeGreaterThan(10);
    for (const def of APP_SETTING_DEFS) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.defaultValue).not.toBe("");
      expect(APP_SETTING_KEYS.has(def.key)).toBe(true);
    }
    // A fresh service with no creds and no env reads nothing.
    const fresh = new AppSettingsService();
    for (const key of APP_SETTING_KEYS) {
      expect(fresh.get(key)).toBeUndefined();
    }
  });
});
