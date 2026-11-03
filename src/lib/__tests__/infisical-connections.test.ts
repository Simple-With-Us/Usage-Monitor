import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const database = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/prisma", () => { const appSetting = {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) => database.has(where.key) ? { key: where.key, value: database.get(where.key) } : null),
  findMany: vi.fn(async () => [...database].map(([key, value]) => ({ key, value }))),
  upsert: vi.fn(async ({ where, update }: { where: { key: string }; update: { value: string } }) => { database.set(where.key, update.value); }),
  deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => { database.delete(where.key); }),
}; return { prisma: { appSetting, $transaction: (fn: (client: { appSetting: typeof appSetting }) => unknown) => fn({ appSetting }) } }; });
vi.mock("@/lib/ingest-admission", () => ({ withInternalUsageWriteAdmission: (fn: () => unknown) => fn() }));
import { connectionMetadata, InfisicalConnectionSchema, infisicalConnectionFromEnv, loadInfisicalConnection, loadInfisicalConnectionSnapshot, mergeConnectionCredentials, saveInfisicalConnection, resolveInfisicalConnection, type InfisicalConnection } from "../infisical-connections";
import { authorizeInfisical, infisicalOrigin, requireInfisicalSecretIdentity } from "../infisical-auth";
import { createRoutedInfisicalSettings } from "../infisical-settings-client";
import { AppSettingsService } from "../app-settings";
import { configureInfisicalRuntimeSettings, initializeInfisicalRuntimeSettings } from "../infisical-runtime-settings";
import { createSessionToken, SESSION_COOKIE_NAME } from "../auth";
import { encryptJson } from "../crypto";
import { hasStoredInfisicalConnections, isInfisicalConnectionDisabled, InfisicalSourceSchema } from "../infisical-connections";
import { GET, PUT, DELETE } from "@/app/api/settings/infisical/route";

function connection(): InfisicalConnection {
  return { source: "ct", projectId: "project-test", mode: "service-tokens", secretPath: "/read", readPaths: ["/read"], writePaths: ["/write"], tokens: [
    { id: "read", token: "st.test-read", paths: ["/read"], permissions: ["read"] },
    { id: "write", token: "st.test-write", paths: ["/write"], permissions: ["write"] },
  ] };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mockFetch(config = connection()) {
  const calls: { url: string; method: string; token: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    calls.push({ url: url.pathname, method: init?.method ?? "GET", token: bearer });
    if (url.pathname.endsWith("/universal-auth/login")) return json({ accessToken: "machine-access" });
    if (url.pathname === "/api/v2/service-token") {
      const token = config.tokens.find((item) => item.token === bearer);
      return json({ workspace: config.projectId, scopes: token?.paths.map((secretPath) => ({ environment: "prod", secretPath })), permissions: token?.permissions, expiresAt: null });
    }
    if (init?.method === "PATCH" || init?.method === "POST") return json({});
    const path = url.searchParams.get("secretPath");
    return json({ secrets: [{ secretKey: "ADAPTER_HTTP_TIMEOUT_MS", secretValue: "10000", workspace: config.projectId, environment: "prod", secretPath: path }] });
  });
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}
beforeEach(() => {
  database.clear();
  for (const prefix of ["ST", "CT", "SHARED", "UM", "ST_PRIMARY"]) for (const suffix of ["CLIENT_ID", "CLIENT_SECRET", "PROJECT_ID", "SECRET_PATH", "READ_TOKEN", "WRITE_TOKEN", "READ_PATHS", "WRITE_PATHS"]) vi.stubEnv(`INFISICAL_${prefix}_${suffix}`, "");
  for (const name of ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_TOKEN", "INFISICAL_PROJECT_ID", "INFISICAL_APP_PROJECT_ID", "INFISICAL_PATH"]) vi.stubEnv(name, "");
  vi.stubEnv("ENCRYPTION_KEY", "57".repeat(32)); vi.stubEnv("SESSION_SECRET", "test-session-secret-value-32-chars!!");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Infisical scope routing", () => {
  it("authorizes an exact service-token project, folder and permission", async () => {
    const c = connection(); const mock = mockFetch(c);
    expect(await authorizeInfisical(c, "/read", "read", mock)).toBe("st.test-read");
    expect(mock.calls.map((call) => call.url)).toEqual(["/api/v2/service-token"]);
  });
  it.each([
    { workspace: "wrong-project" },
    { scopes: [{ environment: "dev", secretPath: "/read" }] },
    { scopes: [{ environment: "prod", secretPath: "/" }] },
    { scopes: [{ environment: "prod", secretPath: "/read/**" }] },
    { scopes: [{ environment: "prod", secretPath: "/read" }, { environment: "prod", secretPath: "/other" }] },
    { permissions: ["read", "write"] },
    { expiresAt: "2020-01-01T00:00:00Z" },
    { expiresAt: "invalid" },
  ])("rejects mismatched/expired metadata before reading secrets: %j", async (override) => {
    const fetchImpl = vi.fn(async () => json({ workspace: "project-test", scopes: [{ environment: "prod", secretPath: "/read" }], permissions: ["read"], ...override }));
    await expect(authorizeInfisical(connection(), "/read", "read", { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not send read-only tokens to a write or descendant-folder operation", async () => {
    const mock = mockFetch();
    await expect(authorizeInfisical(connection(), "/read", "write", mock)).rejects.toThrow("folder_permission_denied");
    await expect(authorizeInfisical(connection(), "/read/child", "read", mock)).rejects.toThrow("folder_permission_denied");
    expect(mock.calls).toEqual([]);
  });
  it("uses exact single-folder token metadata when a legacy raw response omits identity, never ignoring contradictions", () => {
    expect(() => requireInfisicalSecretIdentity(connection(), "/read", {})).not.toThrow();
    expect(() => requireInfisicalSecretIdentity(connection(), "/read", { secretPath: "/wrong" })).toThrow("secret_scope_mismatch");
    const multi = connection(); multi.readPaths.push("/other"); multi.tokens[0].paths.push("/other");
    expect(() => requireInfisicalSecretIdentity(multi, "/read", {})).toThrow("secret_scope_mismatch");
    expect(() => requireInfisicalSecretIdentity(multi, "/read", { workspace: multi.projectId, environment: "prod", secretPath: "/read" })).not.toThrow();
  });
  it("rejects overlapping read routes and wildcard folders", () => {
    const c = connection(); c.tokens[1].paths = ["/read"]; c.tokens[1].permissions = ["read"];
    expect(InfisicalConnectionSchema.safeParse(c).success).toBe(false);
    expect(InfisicalConnectionSchema.safeParse({ ...connection(), readPaths: ["/**"] }).success).toBe(false);
  });
  it.each(["http://app.infisical.com", "https://app.infisical.com.evil.test", "https://user:password@app.infisical.com", "https://app.infisical.com/path", "https://app.infisical.com:444", "https://app.infisical.com?secret=value"])("refuses credential egress to %s", (url) => { expect(() => infisicalOrigin(url)).toThrow("invalid_base_url"); });
  it("does not borrow the Automation identity or combine two credential pairs", () => {
    expect(infisicalConnectionFromEnv("ct", { NODE_ENV: "test", INFISICAL_AUTOMATION_CLIENT_ID: "automation", INFISICAL_AUTOMATION_CLIENT_SECRET: "must-not-use" })).toBeNull();
    const c = infisicalConnectionFromEnv("um", { NODE_ENV: "test", INFISICAL_UM_PROJECT_ID: "project-test", INFISICAL_UM_CLIENT_ID: "own-id", INFISICAL_CLIENT_SECRET: "different-pair" });
    expect(c?.clientId).toBe("own-id"); expect(c?.clientSecret).toBeUndefined();
  });
});

describe("Encrypted connection persistence", () => {
  it("encrypts credentials and exposes only configured flags", async () => {
    const c = connection(); await saveInfisicalConnection(c);
    const ciphertext = [...database.values()].join();
    expect(ciphertext).not.toContain("st.test-read"); expect(ciphertext).not.toContain("project-test");
    expect(await loadInfisicalConnection("ct")).toEqual(c);
    const metadata = JSON.stringify(connectionMetadata(c));
    expect(metadata).not.toContain("st.test"); expect(metadata).not.toContain('"token":'); expect(metadata).toContain('"configured":true');
  });
  it("preserves blank credentials only for unchanged scope and permission coordinates", () => {
    const c = connection(); const blank = structuredClone(c); blank.tokens.forEach((token) => { token.token = ""; });
    expect(mergeConnectionCredentials(blank, c)).toEqual(c);
    expect(() => mergeConnectionCredentials({ ...blank, projectId: "another" }, c)).toThrow();
    const changed = structuredClone(blank); changed.tokens[0].paths = ["/different"];
    expect(() => mergeConnectionCredentials(changed, c)).toThrow();
  });
  it("does not borrow a previous machine secret for a different client id", () => {
    const c: InfisicalConnection = { ...connection(), mode: "machine-identity", tokens: [], clientId: "first", clientSecret: "hidden" };
    expect(() => mergeConnectionCredentials({ ...c, clientId: "second", clientSecret: "" }, c)).toThrow();
  });
  it("rejects a concurrent edit rather than overwriting verified replacement credentials", async () => {
    const previous = connection(); await saveInfisicalConnection(previous);
    const snapshot = await loadInfisicalConnectionSnapshot("ct");
    const newer = structuredClone(previous); newer.tokens[0].token = "st.replacement";
    await saveInfisicalConnection(newer);
    await expect(saveInfisicalConnection(previous, snapshot.revision)).rejects.toThrow("concurrent_infisical_connection_edit");
    expect((await loadInfisicalConnection("ct"))?.tokens[0].token).toBe("st.replacement");
  });
  it("caps unique tokens across project aliases and deduplicates reuse", async () => {
    const c = connection(); await saveInfisicalConnection(c);
    const alias = { ...structuredClone(c), source: "shared" as const };
    await expect(saveInfisicalConnection(alias)).resolves.toBeUndefined();
    alias.tokens[0].token = "st.third-token";
    await expect(saveInfisicalConnection(alias)).rejects.toThrow("infisical_project_token_limit");
  });
  it("counts effective environment tokens in the whole-project cap", async () => {
    vi.stubEnv("INFISICAL_SHARED_PROJECT_ID", "project-test");
    vi.stubEnv("INFISICAL_SHARED_READ_TOKEN", "st.environment-third-token");
    await expect(saveInfisicalConnection(connection())).rejects.toThrow("infisical_project_token_limit");
  });
  it("marks declared machine-identity write permissions as unverified", () => {
    expect(connectionMetadata({ ...connection(), mode: "machine-identity", tokens: [], clientId: "custom", clientSecret: "secret" })).toMatchObject({ writePermissionsVerified: false });
  });
});

describe("Routed runtime settings", () => {
  it("hydrates saved non-UM connection and disable state at startup before a probe can short-circuit", async () => {
    await Promise.all(InfisicalSourceSchema.options.map(loadInfisicalConnection));
    expect(hasStoredInfisicalConnections()).toBe(false);
    const c = { ...connection(), source: "ct" as const };
    database.set("infisical.connection.v1.ct", encryptJson(c));
    database.set("infisical.connection.v1.st", encryptJson({ source: "st", disabled: true }));
    vi.stubEnv("DATABASE_URL", "file:test.db");
    const service = new AppSettingsService();
    await initializeInfisicalRuntimeSettings(service);
    expect(hasStoredInfisicalConnections()).toBe(true);
    expect(isInfisicalConnectionDisabled("st")).toBe(true);
    service.stop();
  });
  it("logs in once per machine-identity refresh while keeping folder queries separate", async () => {
    const c = { ...connection(), mode: "machine-identity" as const, tokens: [], clientId: "custom", clientSecret: "secret", readPaths: ["/read", "/other"] };
    let logins = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/login")) { logins++; return json({ accessToken: "fake-access" }); }
      return json({ secrets: [{ secretKey: url.searchParams.get("secretPath") === "/read" ? "FIRST" : "SECOND", secretValue: "fake-value" }] });
    });
    const client = createRoutedInfisicalSettings(c, { fetchImpl, refreshIntervalMs: 0 });
    await client.init(); expect(logins).toBe(1); expect(client.has("FIRST") && client.has("SECOND")).toBe(true);
    await client.refresh(); expect(logins).toBe(2); client.stop();
  });
  it("rejects malformed external values before replacing last-known-good settings", async () => {
    const c = connection(); const mock = mockFetch(c);
    const client = createRoutedInfisicalSettings(c, { ...mock, refreshIntervalMs: 0 });
    await client.init();
    const original = vi.mocked(mock.fetchImpl).getMockImplementation()!;
    vi.mocked(mock.fetchImpl).mockImplementation(async (input, init) => String(input).includes("/api/v2/service-token") ? original(input, init) : json({ secrets: [{ secretKey: "ADAPTER_HTTP_TIMEOUT_MS", secretValue: { malformed: "secret-canary" } }] }));
    await expect(client.refresh()).rejects.toThrow("invalid_response");
    expect(client.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000"); client.stop();
  });
  it("keeps a read-only cache unchanged after a rejected write", async () => {
    const c = connection(); const mock = mockFetch(c);
    const client = createRoutedInfisicalSettings(c, { ...mock, refreshIntervalMs: 0 });
    await client.init(); expect(client.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    await expect(client.set("ADAPTER_HTTP_TIMEOUT_MS", "20000")).rejects.toThrow("save rejected");
    expect(client.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000"); expect(mock.calls.some((call) => call.method === "PATCH")).toBe(false);
  });
  it("routes writes through the write token and preserves last-known-good cache on refresh failure", async () => {
    const c = connection(); c.tokens[1].paths = ["/read"]; c.writePaths = ["/read"];
    const mock = mockFetch(c); const client = createRoutedInfisicalSettings(c, { ...mock, refreshIntervalMs: 0 });
    await client.init(); await client.set("ADAPTER_HTTP_TIMEOUT_MS", "20000");
    expect(mock.calls.find((call) => call.method === "PATCH")?.token).toBe("st.test-write");
    vi.mocked(mock.fetchImpl).mockRejectedValueOnce(new Error("upstream error containing st.test-read"));
    await expect(client.refresh()).rejects.toThrow("network_error"); expect(client.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("20000");
  });
  it("fails closed on duplicate keys across folders", async () => {
    const c = connection(); c.readPaths.push("/other"); c.tokens[0].paths.push("/other");
    const client = createRoutedInfisicalSettings(c, { ...mockFetch(c), refreshIntervalMs: 0 });
    await expect(client.init()).rejects.toThrow("ambiguous_secret_folder");
  });
  it("activates a changed credential mode only after verification and persistence succeed", async () => {
    const service = new AppSettingsService(); const c = { ...connection(), source: "um" as const };
    vi.stubGlobal("fetch", mockFetch(c).fetchImpl);
    await configureInfisicalRuntimeSettings(service, c, async () => {}, { refreshIntervalMs: 0 });
    expect(service.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    const mi = { ...c, mode: "machine-identity" as const, tokens: [], clientId: "custom-id", clientSecret: "custom-secret" };
    const mock = mockFetch(mi); vi.stubGlobal("fetch", mock.fetchImpl);
    await expect(configureInfisicalRuntimeSettings(service, mi, async () => { throw new Error("save failed"); }, { refreshIntervalMs: 0 })).rejects.toThrow("save failed");
    expect(service.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    const persisted = vi.fn(async () => {}); await configureInfisicalRuntimeSettings(service, mi, persisted, { refreshIntervalMs: 0 });
    expect(persisted).toHaveBeenCalledOnce(); expect(mock.calls.some((call) => call.url.endsWith("/universal-auth/login"))).toBe(true);
    service.stop();
  });
  it("initializes from the saved service-token connection instead of an ambient machine identity", async () => {
    const c = { ...connection(), source: "um" as const };
    await saveInfisicalConnection(c);
    vi.stubEnv("INFISICAL_CLIENT_ID", "ambient-id"); vi.stubEnv("INFISICAL_CLIENT_SECRET", "ambient-secret");
    const mock = mockFetch(c); vi.stubGlobal("fetch", mock.fetchImpl);
    const service = new AppSettingsService();
    await initializeInfisicalRuntimeSettings(service);
    expect(service.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    expect(mock.calls.some((call) => call.url.endsWith("/universal-auth/login"))).toBe(false);
    service.stop();
  });
  it("keeps a persisted disable across server initialization without an ambient login", async () => {
    expect((await DELETE(request("DELETE", { source: "um" }))).status).toBe(200);
    vi.stubEnv("INFISICAL_CLIENT_ID", "ambient-id"); vi.stubEnv("INFISICAL_CLIENT_SECRET", "ambient-secret");
    const mock = mockFetch(); vi.stubGlobal("fetch", mock.fetchImpl);
    const service = new AppSettingsService();
    await initializeInfisicalRuntimeSettings(service);
    await service.init();
    expect(service.isInfisicalMode).toBe(false); expect(mock.calls).toEqual([]);
  });
  it.each(["network", "expired"])("keeps deploy-env reads available after saved connection %s failure and rejects ephemeral writes", async (kind) => {
    const c = { ...connection(), source: "um" as const }; await saveInfisicalConnection(c);
    vi.stubEnv("ADAPTER_HTTP_TIMEOUT_MS", "30000");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = mockFetch(c);
    vi.stubGlobal("fetch", kind === "network" ? vi.fn(async () => { throw new Error("failure containing st.test-read"); }) : vi.fn(async () => json({ workspace: c.projectId, permissions: ["read"], scopes: [{ environment: "prod", secretPath: "/read" }], expiresAt: "2020-01-01T00:00:00Z" })));
    const service = new AppSettingsService();
    await expect(initializeInfisicalRuntimeSettings(service)).resolves.toBeUndefined();
    expect(service.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("30000");
    expect(service.areInfisicalWritesBlocked).toBe(true);
    await expect(service.set("ADAPTER_HTTP_TIMEOUT_MS", "20000")).rejects.toThrow("save rejected");
    expect(process.env.ADAPTER_HTTP_TIMEOUT_MS).toBe("30000");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("st.test-read");
    vi.stubGlobal("fetch", mock.fetchImpl);
    await configureInfisicalRuntimeSettings(service, c, async () => {}, { refreshIntervalMs: 0 });
    expect(service.isInfisicalMode).toBe(true); expect(service.areInfisicalWritesBlocked).toBe(false);
    service.stop(); warning.mockRestore();
  });
  it("keeps verify-and-save strict when candidate initialization fails", async () => {
    const c = { ...connection(), source: "um" as const }; const service = new AppSettingsService();
    vi.stubGlobal("fetch", mockFetch(c).fetchImpl);
    await configureInfisicalRuntimeSettings(service, c, async () => {}, { refreshIntervalMs: 0 });
    const persist = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("upstream unavailable"); }));
    await expect(configureInfisicalRuntimeSettings(service, c, persist, { refreshIntervalMs: 0 })).rejects.toThrow("network_error");
    expect(persist).not.toHaveBeenCalled(); expect(service.isInfisicalMode).toBe(true); expect(service.get("ADAPTER_HTTP_TIMEOUT_MS")).toBe("10000");
    service.stop();
  });
  it("normalizes the explicit generic service-token and path aliases into verified live UM settings", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.generic-read"); vi.stubEnv("INFISICAL_UM_WRITE_TOKEN", "st.generic-write");
    vi.stubEnv("INFISICAL_PROJECT_ID", "project-test"); vi.stubEnv("INFISICAL_PATH", "/read");
    vi.stubEnv("ADAPTER_HTTP_TIMEOUT_MS", "30000");
    const c = infisicalConnectionFromEnv("um")!;
    expect(c.secretPath).toBe("/read"); const mock = mockFetch(c); vi.stubGlobal("fetch", mock.fetchImpl);
    const service = new AppSettingsService(); await initializeInfisicalRuntimeSettings(service);
    expect(service.isInfisicalMode).toBe(true);
    await service.set("ADAPTER_HTTP_TIMEOUT_MS", "20000");
    expect(mock.calls.find((call) => call.method === "PATCH")?.token).toBe("st.generic-write");
    expect(process.env.ADAPTER_HTTP_TIMEOUT_MS).toBe("30000"); service.stop();
  });
  it("never reports ephemeral save success for an unscoped bootstrap access token", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "fake-access-token");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new AppSettingsService(); await initializeInfisicalRuntimeSettings(service);
    await expect(service.set("ADAPTER_HTTP_TIMEOUT_MS", "20000")).rejects.toThrow("save rejected");
    expect(service.isInfisicalMode).toBe(false); warning.mockRestore();
  });
});

const request = (method: string, body?: unknown, authenticated = true) => new NextRequest("https://usage.example.test/api/settings/infisical", { method, headers: { ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
describe("Admin connection API", () => {
  it.each([null, [], { secrets: [null] }, { secrets: [{ secretKey: 42 }] }])("rejects malformed secret-list responses before persisting a verified connection: %j", async (payload) => {
    const c = connection(); const mock = mockFetch(c);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => String(input).includes("/api/v2/service-token") ? mock.fetchImpl(input, init) : json(payload)));
    const response = await PUT(request("PUT", c));
    expect(response.status).toBe(400); expect(database.size).toBe(0);
    expect(await response.text()).not.toContain("st.test-read");
  });
  it("does not let an earlier verification overwrite a later durable disable", async () => {
    const c = { ...connection(), source: "um" as const };
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atVerification = new Promise<void>((resolve) => { entered = resolve; });
    const mock = mockFetch(c); let held = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!held && String(input).includes("/api/v2/service-token")) { held = true; entered(); await gate; }
      return mock.fetchImpl(input, init);
    }));
    const pending = PUT(request("PUT", c)); await atVerification;
    expect((await DELETE(request("DELETE", { source: "um" }))).status).toBe(200);
    release(); expect((await pending).status).toBe(400);
    expect(await resolveInfisicalConnection("um")).toBeNull();
    const { appSettings } = await import("../app-settings"); expect(appSettings.isInfisicalMode).toBe(false);
  });
  it("shows effective environment connection metadata without returning credentials", async () => {
    vi.stubEnv("INFISICAL_CT_PROJECT_ID", "project-test"); vi.stubEnv("INFISICAL_CT_CLIENT_ID", "ambient-id"); vi.stubEnv("INFISICAL_CT_CLIENT_SECRET", "ambient-secret");
    const response = await GET(request("GET")); const body = await response.text();
    expect(body).toContain('"clientSecretConfigured":true'); expect(body).toContain('"projectId":"project-test"');
    expect(body).not.toContain("ambient-id"); expect(body).not.toContain("ambient-secret");
  });
  it("requires a dashboard session for read, write and delete", async () => {
    expect((await GET(request("GET", undefined, false))).status).toBe(403);
    expect((await PUT(request("PUT", connection(), false))).status).toBe(403);
    expect((await DELETE(request("DELETE", { source: "ct" }, false))).status).toBe(403);
    expect(database.size).toBe(0);
  });
  it("verifies and saves encrypted credentials, preserves masked blanks, and explicitly deletes", async () => {
    const c = connection(); vi.stubGlobal("fetch", mockFetch(c).fetchImpl);
    const response = await PUT(request("PUT", c)); expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("st.test");
    const blank = structuredClone(c); blank.tokens.forEach((token) => { token.token = ""; });
    expect((await PUT(request("PUT", blank))).status).toBe(200);
    const get = await GET(request("GET")); expect(await get.text()).not.toContain("st.test");
    expect((await DELETE(request("DELETE", { source: "ct" }))).status).toBe(200);
    vi.stubEnv("INFISICAL_CT_CLIENT_ID", "ambient-id"); vi.stubEnv("INFISICAL_CT_CLIENT_SECRET", "ambient-secret"); vi.stubEnv("INFISICAL_CT_PROJECT_ID", "project-test");
    expect(await resolveInfisicalConnection("ct")).toBeNull();
    expect(await (await GET(request("GET"))).json()).toMatchObject({ disabledSources: ["ct"] });
  });
  it("rejects a successful wrong-project metadata response without disclosing its body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ workspace: "wrong-project", secretValue: "st.test-read", permissions: ["read"], scopes: [{ environment: "prod", secretPath: "/read" }] })));
    const response = await PUT(request("PUT", connection())); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("st.test-read"); expect(database.size).toBe(0);
  });
  it("checks machine-identity read access for every declared folder before saving", async () => {
    const c: InfisicalConnection = { ...connection(), mode: "machine-identity", tokens: [], clientId: "dedicated", clientSecret: "hidden", readPaths: ["/read", "/blocked"] };
    const mock = mockFetch(c);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => new URL(String(input)).searchParams.get("secretPath") === "/blocked" ? json({ secretValue: "must-not-leak" }, 403) : mock.fetchImpl(input, init)));
    const response = await PUT(request("PUT", c));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("must-not-leak"); expect(database.size).toBe(0);
  });
});
