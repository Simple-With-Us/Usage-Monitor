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

function metadata(permission) {
  return {
    workspace: "project-id-fixture",
    permissions: [permission],
    scopes: [{ environment: "prod", secretPath: "/" }],
    expiresAt: null,
  };
}

function fetchWithReadback(value = ACCESS_TOKEN_FIXTURE) {
  return vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/service-token") {
      const permission = init.headers.authorization.endsWith("read.fixture") ? "read" : "write";
      return new Response(JSON.stringify(metadata(permission)), { status: 200 });
    }
    if (parsed.pathname === "/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN" && init.method === "POST") {
      return new Response("private response body", { status: 200 });
    }
    if (parsed.pathname === "/api/v4/secrets/MUSE_CODE_ACCESS_TOKEN" && init.method === "GET") {
      return new Response(JSON.stringify({ secret: { secretValue: value } }), { status: 200 });
    }
    throw new Error("unexpected mocked request");
  });
}

describe("transferMuseCodeAccessToken", () => {
  it("does not query Infisical or Keychain without a complete valid destination and write token", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: { ...WRITE_ENV, INFISICAL_SECRET_PATH: "/../outside" },
      fetchImpl,
      execFileImpl,
      platform: "darwin",
    })).rejects.toMatchObject({ code: "invalid-secret-path" });
    await expect(transferMuseCodeAccessToken({
      env: { ...WRITE_ENV, INFISICAL_UM_WRITE_TOKEN: "" },
      fetchImpl,
      execFileImpl,
      platform: "darwin",
    })).rejects.toMatchObject({ code: "write-service-token-required" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("does not query Infisical or Keychain from a non-macOS host", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV,
      fetchImpl,
      execFileImpl,
      platform: "linux",
    })).rejects.toMatchObject({ code: "interactive-transfer-requires-macos" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("validates scoped write permission before the one explicit Keychain read, then writes without returning the value", async () => {
    const fetchImpl = fetchWithReadback();
    const execFileImpl = vi.fn(async () => ({ stdout: JSON.stringify({ access_token: ACCESS_TOKEN_FIXTURE, refresh_token: "unused-fixture" }) }));
    const result = await transferMuseCodeAccessToken({
      env: WRITE_ENV,
      fetchImpl,
      execFileImpl,
      platform: "darwin",
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, writeRequest] = fetchImpl.mock.calls[1];
    expect(writeRequest.method).toBe("POST");
    expect(JSON.parse(writeRequest.body)).toMatchObject({
      projectId: "project-id-fixture",
      environment: "prod",
      secretPath: "/",
      secretValue: ACCESS_TOKEN_FIXTURE,
      type: "shared",
    });
    expect(writeRequest.body).not.toContain("unused-fixture");
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN_FIXTURE);
    expect(JSON.stringify(result)).not.toContain("unused-fixture");
    expect(result).toMatchObject({ keychainRead: true, writeScopeStatus: 200, writeStatus: 200 });
    expect(result).not.toHaveProperty("refreshToken");
  });

  it("reports only HTTP status and a boolean for optional separate-token readback", async () => {
    const env = { ...WRITE_ENV, INFISICAL_UM_READ_TOKEN: "st.read.fixture" };
    const fetchImpl = fetchWithReadback();
    const execFileImpl = vi.fn(async () => ({ stdout: JSON.stringify({ access_token: ACCESS_TOKEN_FIXTURE }) }));
    const result = await transferMuseCodeAccessToken({ env, fetchImpl, execFileImpl, platform: "darwin" });
    expect(result).toMatchObject({
      writeStatus: 200,
      readbackScopeStatus: 200,
      readbackStatus: 200,
      readbackMatches: true,
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN_FIXTURE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not leak Infisical error bodies or the source token on a rejected write", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(metadata("write")), { status: 200 });
      }
      expect(init.body).toContain(ACCESS_TOKEN_FIXTURE);
      return new Response(`private ${ACCESS_TOKEN_FIXTURE} body`, { status: 403 });
    });
    const execFileImpl = vi.fn(async () => ({ stdout: JSON.stringify({ access_token: ACCESS_TOKEN_FIXTURE }) }));
    try {
      await transferMuseCodeAccessToken({
        env: WRITE_ENV,
        fetchImpl,
        execFileImpl,
        platform: "darwin",
      });
      throw new Error("expected write rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "secret-write-rejected", status: 403 });
      expect(error.message).not.toContain("private");
      expect(error.message).not.toContain(ACCESS_TOKEN_FIXTURE);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses a write token with the wrong folder scope before reading Keychain", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...metadata("write"),
      scopes: [{ environment: "prod", secretPath: "/wrong" }],
    }), { status: 200 }));
    const execFileImpl = vi.fn();
    await expect(transferMuseCodeAccessToken({
      env: WRITE_ENV,
      fetchImpl,
      execFileImpl,
      platform: "darwin",
    })).rejects.toMatchObject({ code: "write-token-scope-mismatch" });
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
