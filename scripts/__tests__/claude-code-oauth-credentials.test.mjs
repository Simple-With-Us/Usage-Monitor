import { afterEach, describe, expect, it, vi } from "vitest";

import { parseClaudeCodeCredentialsJson } from "../lib/claude-code-oauth-credentials.mjs";
import { PROVIDERS, resolveCredentialField } from "../subscription-quota-collector.mjs";

describe("parseClaudeCodeCredentialsJson", () => {
  it("accepts a valid credentials envelope and strips unknown oauth keys", () => {
    const data = parseClaudeCodeCredentialsJson(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "secret-token",
          expiresAt: 9_999_999_999_999,
          subscriptionType: "max_20x",
          unexpectedVendorField: "drop-me",
        },
        otherTopLevel: "also-dropped",
      }),
    );
    expect(data).toEqual({
      claudeAiOauth: {
        accessToken: "secret-token",
        expiresAt: 9_999_999_999_999,
        subscriptionType: "max_20x",
      },
    });
    expect(resolveCredentialField(data.claudeAiOauth, ["accessToken"])).toEqual({
      key: "accessToken",
      value: "secret-token",
    });
  });

  it("rejects malformed JSON with a generic log line only", () => {
    const log = vi.fn();
    expect(parseClaudeCodeCredentialsJson("{not json", { logImpl: log })).toBeNull();
    expect(log).toHaveBeenCalledWith("claude: OAuth credential JSON is not valid JSON");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/secret|token/i);
  });

  it("rejects schema violations without logging the payload", () => {
    const log = vi.fn();
    expect(parseClaudeCodeCredentialsJson(JSON.stringify({ claudeAiOauth: 42 }), { logImpl: log })).toBeNull();
    expect(log).toHaveBeenCalledWith("claude: OAuth credential JSON failed schema validation");
    expect(log.mock.calls.flat().join(" ")).not.toContain("42");
  });
});

describe("Claude provider credential source", () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_CREDENTIALS_JSON;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_CREDENTIALS_JSON;
    } else {
      process.env.CLAUDE_CODE_OAUTH_CREDENTIALS_JSON = previous;
    }
    vi.unstubAllGlobals();
  });

  it("reads OAuth from CLAUDE_CODE_OAUTH_CREDENTIALS_JSON and never logs the token", async () => {
    process.env.CLAUDE_CODE_OAUTH_CREDENTIALS_JSON = JSON.stringify({
      claudeAiOauth: {
        accessToken: "env-only-token",
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: "max_20x",
      },
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" },
        }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await PROVIDERS.claude.fetch({ debug: false });
    expect(result.skipped).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers.authorization).toBe("Bearer env-only-token");
  });

  it("skips when env JSON is present but has no access token field", async () => {
    process.env.CLAUDE_CODE_OAUTH_CREDENTIALS_JSON = JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 3_600_000 },
    });
    await expect(PROVIDERS.claude.fetch({ debug: false })).resolves.toEqual({
      skipped: "no Claude Code OAuth credential found",
    });
  });
});
