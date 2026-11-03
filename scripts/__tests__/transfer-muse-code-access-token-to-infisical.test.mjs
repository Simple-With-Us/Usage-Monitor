import { describe, expect, it, vi } from "vitest";

import { transferMuseCodeAccessToken } from "../transfer-muse-code-access-token-to-infisical.mjs";

const WRITE_ENV = {
  INFISICAL_BASE_URL: "https://app.infisical.com",
  INFISICAL_UM_PROJECT_ID: "project-id-fixture",
  INFISICAL_ENVIRONMENT: "prod",
  INFISICAL_SECRET_PATH: "/",
  INFISICAL_UM_WRITE_TOKEN: "st.write.fixture",
};
const ACCESS_TOKEN_FIXTURE = "oauth-access-fixture";

function metadata(permissions) {
  return {
    workspace: "project-id-fixture",
    permissions: Array.isArray(permissions) ? permissions : [permissions],
    scopes: [{ environment: "prod", secretPath: "/" }],
    expiresAt: null,
  };
}

function fetchMock({ writeStatus = 200, readbackValue = ACCESS_TOKEN_FIXTURE, writePermissions = ["write"] } = {}) {
  return vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/service-token") {
      const permissions = init.headers.authorization.endsWith("read.fixture")
        ? ["read"]
        : writePermissions;
      return new Response(JSON.stringify(metadata(permissions)), { status: 200 });
    }
    if (parsed.pathname === "/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN" && init.method !== "GET") {
      return new Response("private response body", { status: writeStatus });
    }
    if (parsed.pathname === "/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN" && init.method === "GET") {
      return new Response(JSON.stringify({ secret: { secretValue: readbackValue } }), { status: 200 });
    }
    throw new Error("unexpected mocked request");
  });
}

function keychainMock(accessToken = ACCESS_TOKEN_FIXTURE) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({ access_token: accessToken, refresh_token: "unused-fixture" }),
  }));
}

function secretRequests(fetchImpl) {
  return fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === "/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN");
}

describe("transferMuseCodeAccessToken", () => {
  it("fails closed before Infisical or Keychain without a complete target and write token", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: { ...WRITE_ENV, INFISICAL_SECRET_PATH: "/../outside" }, fetchImpl, execFileImpl, platform: "darwin",
    })).rejects.toMatchObject({ code: "invalid-secret-path" });
    await expect(transferMuseCodeAccessToken({
      env: { ...WRITE_ENV, INFISICAL_UM_WRITE_TOKEN: "" }, fetchImpl, execFileImpl, platform: "darwin",
    })).rejects.toMatchObject({ code: "write-service-token-required" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("does not query Infisical or Keychain from non-macOS", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl, platform: "linux",
    })).rejects.toMatchObject({ code: "interactive-transfer-requires-macos" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("accepts exact-scope read/write metadata, reads Keychain with a 180-second approval window, and PATCHes only the named secret", async () => {
    const fetchImpl = fetchMock({ writePermissions: ["read", "write"] });
    const execFileImpl = keychainMock();
    const result = await transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl, platform: "darwin",
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"],
      expect.objectContaining({ timeout: 180_000 }),
    );
    const requests = secretRequests(fetchImpl);
    expect(requests).toHaveLength(1);
    const [url, request] = requests[0];
    expect(new URL(url).pathname).toBe("/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN");
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body)).toMatchObject({
      projectId: "project-id-fixture", environment: "prod", secretPath: "/",
      secretValue: ACCESS_TOKEN_FIXTURE, type: "shared",
    });
    expect(request.body).not.toContain("unused-fixture");
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN_FIXTURE);
    expect(JSON.stringify(result)).not.toContain("unused-fixture");
    expect(result).toMatchObject({ keychainRead: true, writeScopeStatus: 200, writeStatus: 200 });
    expect(result).not.toHaveProperty("refreshToken");
  });

  it("creates the named secret with POST only when PATCH returns 404", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(metadata("write")), { status: 200 });
      }
      return new Response("private response body", { status: init.method === "PATCH" ? 404 : 201 });
    });
    const result = await transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl: keychainMock(), platform: "darwin",
    });
    expect(secretRequests(fetchImpl).map(([, request]) => request.method)).toEqual(["PATCH", "POST"]);
    expect(result.writeStatus).toBe(201);
  });

  it("does not POST after a 409 PATCH conflict or expose its API error body", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(metadata("write")), { status: 200 });
      }
      return new Response(`private ${ACCESS_TOKEN_FIXTURE} conflict body`, { status: 409 });
    });
    try {
      await transferMuseCodeAccessToken({
        env: WRITE_ENV, fetchImpl, execFileImpl: keychainMock(), platform: "darwin",
      });
      throw new Error("expected write rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "secret-write-rejected", status: 409 });
      expect(error.message).not.toContain("private");
      expect(error.message).not.toContain(ACCESS_TOKEN_FIXTURE);
    }
    expect(secretRequests(fetchImpl).map(([, request]) => request.method)).toEqual(["PATCH"]);
  });

  it("keeps optional readback separate and strictly read-only", async () => {
    const env = { ...WRITE_ENV, INFISICAL_UM_READ_TOKEN: "st.read.fixture" };
    const fetchImpl = fetchMock({ writePermissions: ["read", "write"] });
    const result = await transferMuseCodeAccessToken({ env, fetchImpl, execFileImpl: keychainMock(), platform: "darwin" });
    expect(result).toMatchObject({
      writeStatus: 200, readbackScopeStatus: 200, readbackStatus: 200, readbackMatches: true,
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN_FIXTURE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects a readback token with write permission before reading Keychain", async () => {
    const env = { ...WRITE_ENV, INFISICAL_UM_READ_TOKEN: "st.read.fixture" };
    const fetchImpl = vi.fn(async (_url, init = {}) => new Response(JSON.stringify(metadata(
      init.headers.authorization.endsWith("read.fixture") ? ["read", "write"] : ["write"],
    )), { status: 200 }));
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({ env, fetchImpl, execFileImpl, platform: "darwin" }))
      .rejects.toMatchObject({ code: "read-token-scope-mismatch" });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["CRLF", "oauth\r\naccess"],
    ["too long", "x".repeat(16_385)],
  ])("rejects a %s access token before any secret write", async (_label, accessToken) => {
    const fetchImpl = fetchMock();
    const execFileImpl = keychainMock(accessToken);
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl, platform: "darwin",
    })).rejects.toMatchObject({ code: expect.stringMatching(/^keychain-access-token-/) });
    expect(secretRequests(fetchImpl)).toHaveLength(0);
  });

  it("does not leak the source token or full Infisical response body on a rejected write", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(metadata("write")), { status: 200 });
      }
      return new Response(`private ${ACCESS_TOKEN_FIXTURE} body`, { status: 500 });
    });
    const execFileImpl = keychainMock();
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl, platform: "darwin",
    })).rejects.toMatchObject({ code: "secret-write-rejected", status: 500 });
    expect(secretRequests(fetchImpl)).toHaveLength(1);
  });

  it("refuses a write token with the wrong folder scope before reading Keychain", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...metadata("write"), scopes: [{ environment: "prod", secretPath: "/wrong" }],
    }), { status: 200 }));
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV, fetchImpl, execFileImpl, platform: "darwin",
    })).rejects.toMatchObject({ code: "write-token-scope-mismatch" });
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
