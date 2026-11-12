import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NOOP_REPLIES,
  buildLogRecord,
  buildTurnRecord,
  coarseToolName,
  defaultCredentialsFilePath,
  extractFields,
  isContentCaptureEnabled,
  isEntrypoint,
  isTrustedOtlpEndpoint,
  isTrustedSentryEndpoint,
  main,
  noopReplyFor,
  parsePayload,
  postOtlp,
  resolveCredentials,
  resolvePayloadFormat,
  runSelfTest,
  scheduleBackgroundSend,
} from "../agent-hook-otlp.mjs";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "agent-hook-otlp.mjs");

const ALLOWLIST_KEYS = new Set([
  "service.name",
  "agent.platform",
  "seat",
  "event",
  "tool.name",
  "success",
  "duration_ms",
  "session.id",
  "generation.id",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_tokens",
  "cost_usd",
  "error",
]);

function attributeKeys(record) {
  const resourceKeys = record.resourceLogs[0].resource.attributes.map((a) => a.key);
  const logKeys = record.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a) => a.key);
  return new Set([...resourceKeys, ...logKeys]);
}

describe("coarseToolName", () => {
  it("collapses MCP-flavoured names case-insensitively", () => {
    expect(coarseToolName("mcp__github__search")).toBe("mcp_tool");
    expect(coarseToolName("MCP_TOOL")).toBe("mcp_tool");
    expect(coarseToolName("some-MCPish-name")).toBe("mcp_tool");
  });

  it("passes through a plain tool name unchanged", () => {
    expect(coarseToolName("Bash")).toBe("Bash");
    expect(coarseToolName("Edit")).toBe("Edit");
  });

  it("returns undefined for empty, whitespace, or non-string input", () => {
    expect(coarseToolName("")).toBeUndefined();
    expect(coarseToolName("   ")).toBeUndefined();
    expect(coarseToolName(undefined)).toBeUndefined();
    expect(coarseToolName(null)).toBeUndefined();
    expect(coarseToolName(42)).toBeUndefined();
  });
});

describe("resolveCredentials", () => {
  it("prefers env vars when all three are set", () => {
    const env = {
      AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
      AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
      AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=abc",
    };
    const readFile = vi.fn(() => {
      throw new Error("must not read the credentials file when env vars are complete");
    });
    expect(resolveCredentials(env, readFile)).toEqual({
      endpoint: "https://example.sentry.io/v1/logs",
      headerName: "x-sentry-auth",
      headerValue: "sentry sentry_key=abc",
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to the credentials file when env vars are incomplete", () => {
    const readFile = vi.fn(() =>
      JSON.stringify({
        endpoint: "https://example.sentry.io/v1/logs",
        headerName: "x-sentry-auth",
        headerValue: "sentry sentry_key=fromfile",
      })
    );
    expect(resolveCredentials({}, readFile)).toEqual({
      endpoint: "https://example.sentry.io/v1/logs",
      headerName: "x-sentry-auth",
      headerValue: "sentry sentry_key=fromfile",
    });
  });

  it("honours AGENT_HOOK_OTLP_CREDENTIALS_FILE for the file path", () => {
    const readFile = vi.fn((path) => {
      expect(path).toBe("/custom/path.json");
      return JSON.stringify({ endpoint: "e", headerName: "h", headerValue: "v" });
    });
    resolveCredentials({ AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/custom/path.json" }, readFile);
    expect(readFile).toHaveBeenCalledWith("/custom/path.json", "utf8");
  });

  it("returns null when the file is missing", () => {
    const readFile = vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("returns null when the file has malformed JSON", () => {
    const readFile = vi.fn(() => "{not json");
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("returns null when the file is missing a required field", () => {
    const readFile = vi.fn(() => JSON.stringify({ endpoint: "e", headerName: "h" }));
    expect(resolveCredentials({}, readFile)).toBeNull();
  });

  it("defaultCredentialsFilePath points under ~/.config/usage-monitor", () => {
    expect(defaultCredentialsFilePath()).toMatch(/\.config\/usage-monitor\/agent-hook-otlp-sentry\.json$/);
  });
});

describe("isTrustedSentryEndpoint", () => {
  it("accepts https sentry.io and its subdomains", () => {
    expect(isTrustedSentryEndpoint("https://sentry.io/api/1/envelope/")).toBe(true);
    expect(isTrustedSentryEndpoint("https://o123.ingest.us.sentry.io/api/456/integration/otlp/v1/logs")).toBe(true);
  });

  it("rejects non-https, non-sentry.io, and malformed endpoints", () => {
    expect(isTrustedSentryEndpoint("http://o123.ingest.us.sentry.io/api/456/v1/logs")).toBe(false);
    expect(isTrustedSentryEndpoint("https://evil.example.com/v1/logs")).toBe(false);
    expect(isTrustedSentryEndpoint("https://sentry.io.evil.example.com/v1/logs")).toBe(false);
    expect(isTrustedSentryEndpoint("not a url")).toBe(false);
    expect(isTrustedSentryEndpoint("")).toBe(false);
  });
});

describe("isTrustedOtlpEndpoint (v2 — why v1 never delivered)", () => {
  it("still accepts sentry.io over https", () => {
    expect(isTrustedOtlpEndpoint("https://o123.ingest.us.sentry.io/api/1/otlp/v1/logs")).toBe(true);
  });

  it("accepts Usage Monitor and loopback (the hosts v1 silently dropped)", () => {
    expect(isTrustedOtlpEndpoint("https://usage.jays.services/api/otlp/v1/traces")).toBe(true);
    expect(isTrustedOtlpEndpoint("http://127.0.0.1:4103/api/otlp/v1/traces")).toBe(true);
    expect(isTrustedOtlpEndpoint("http://localhost:4103/api/otlp/v1/traces")).toBe(true);
  });

  it("accepts extra https hosts from AGENT_HOOK_OTLP_ALLOWED_HOSTS", () => {
    const env = { AGENT_HOOK_OTLP_ALLOWED_HOSTS: "relay.example.com, other.example.net" };
    expect(isTrustedOtlpEndpoint("https://relay.example.com/v1/traces", env)).toBe(true);
    expect(isTrustedOtlpEndpoint("https://evil.example.com/v1/traces", env)).toBe(false);
    expect(isTrustedOtlpEndpoint("http://relay.example.com/v1/traces", env)).toBe(false);
  });

  it("still rejects random internet hosts", () => {
    expect(isTrustedOtlpEndpoint("https://evil.example.com/steal")).toBe(false);
    expect(isTrustedOtlpEndpoint("https://sentry.io.evil.example.com/v1/logs")).toBe(false);
  });
});

describe("resolvePayloadFormat", () => {
  it("defaults to turns when the path contains /traces", () => {
    expect(resolvePayloadFormat("https://usage.jays.services/api/otlp/v1/traces")).toBe("turns");
    expect(resolvePayloadFormat("https://example.sentry.io/v1/logs")).toBe("logs");
  });

  it("honours an explicit AGENT_HOOK_OTLP_FORMAT override", () => {
    expect(resolvePayloadFormat("https://usage.jays.services/api/otlp/v1/traces", {
      AGENT_HOOK_OTLP_FORMAT: "logs",
    })).toBe("logs");
    expect(resolvePayloadFormat("https://example.sentry.io/v1/logs", {
      AGENT_HOOK_OTLP_FORMAT: "turns",
    })).toBe("turns");
  });
});

describe("content capture and turn payload", () => {
  it("is off by default so prompt/response stay out of the wire body", () => {
    expect(isContentCaptureEnabled({})).toBe(false);
    const fields = extractFields("cursor", "afterAgentResponse", {
      conversation_id: "c-2",
      model: "claude-sonnet-5",
      text: "SECRET-RESPONSE",
      prompt: "SECRET-PROMPT",
    });
    expect(fields.promptText).toBeUndefined();
    expect(fields.responseText).toBeUndefined();
  });

  it("captures truncated prompt/response only when INCLUDE_CONTENT is on", () => {
    const fields = extractFields(
      "cursor",
      "afterAgentResponse",
      {
        conversation_id: "c-2",
        model: "claude-sonnet-5",
        text: "y".repeat(4010),
        prompt: "hello",
        input_tokens: 12,
        output_tokens: 4,
        generation_id: "gen-1",
      },
      { AGENT_HOOK_OTLP_INCLUDE_CONTENT: "1" }
    );
    expect(fields.promptText).toBe("hello");
    expect(fields.responseText).toHaveLength(4000);
    expect(fields.inputTokens).toBe(12);
    expect(fields.outputTokens).toBe(4);
    expect(fields.generationId).toBe("gen-1");
    const turn = buildTurnRecord("cursor", "afterAgentResponse", fields);
    expect(turn.turns[0].promptText).toBe("hello");
    expect(turn.turns[0].conversationId).toBe("c-2");
  });

  it("coarsens errors to hook_error and never forwards the raw stack", () => {
    const fields = extractFields("copilot", "errorOccurred", {
      sessionId: "cp-3",
      error: "SECRET-stack-trace",
    });
    expect(fields.error).toBe("hook_error");
    expect(JSON.stringify(fields)).not.toContain("SECRET-stack-trace");
  });
});

describe("runSelfTest", () => {
  it("reports configured=false without printing secrets", async () => {
    const lines = [];
    const report = await runSelfTest({}, { write: (line) => lines.push(line) });
    expect(report.configured).toBe(false);
    expect(report.ok).toBe(false);
    expect(lines.join("")).not.toContain("Bearer");
    expect(lines.join("")).not.toContain("sentry_key");
  });

  it("reports trusted host and format without posting by default", async () => {
    const lines = [];
    const post = vi.fn();
    const report = await runSelfTest(
      {
        AGENT_HOOK_OTLP_ENDPOINT: "https://usage.jays.services/api/otlp/v1/traces",
        AGENT_HOOK_OTLP_HEADER_NAME: "Authorization",
        AGENT_HOOK_OTLP_HEADER_VALUE: "Bearer SUPER-SECRET",
      },
      { write: (line) => lines.push(line), postOtlp: post }
    );
    expect(report.configured).toBe(true);
    expect(report.trusted).toBe(true);
    expect(report.format).toBe("turns");
    expect(report.host).toBe("usage.jays.services");
    expect(report.posted).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(lines.join("")).not.toContain("SUPER-SECRET");
  });
});

describe("extractFields: antigravity", () => {
  it("PostToolUse: coarse tool name, success from absence of error", () => {
    const fields = extractFields("antigravity", "PostToolUse", {
      toolCall: { name: "run_terminal_command", args: { command: "rm -rf /tmp/x" } },
      conversationId: "conv-1",
      modelName: "gemini-3-pro",
      stepIdx: 4,
    });
    expect(fields.toolName).toBe("run_terminal_command");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("conv-1");
    expect(fields.model).toBe("gemini-3-pro");
  });

  it("PostToolUse: an MCP tool name collapses, and a present error means failure", () => {
    const fields = extractFields("antigravity", "PostToolUse", {
      toolCall: { name: "mcp__cloudflare__deploy" },
      error: "boom",
      conversationId: "conv-2",
    });
    expect(fields.toolName).toBe("mcp_tool");
    expect(fields.success).toBe(false);
  });

  it("PostInvocation carries no tool name and defaults to success", () => {
    const fields = extractFields("antigravity", "PostInvocation", {
      conversationId: "conv-3",
      invocationNum: 2,
      modelName: "gemini-3-flash",
    });
    expect(fields.toolName).toBeUndefined();
    expect(fields.success).toBe(true);
    expect(fields.model).toBe("gemini-3-flash");
  });

  it("Stop reflects an error field when present", () => {
    const clean = extractFields("antigravity", "Stop", { conversationId: "c", fullyIdle: true });
    expect(clean.success).toBe(true);
    const failed = extractFields("antigravity", "Stop", { conversationId: "c", error: "panic" });
    expect(failed.success).toBe(false);
  });

  it("an unrecognised antigravity event still yields a safe field set", () => {
    const fields = extractFields("antigravity", "SomeFutureEvent", { conversationId: "c" });
    expect(fields.sessionId).toBe("c");
    expect(fields.success).toBe(true);
  });
});

describe("extractFields: cursor", () => {
  it("afterFileEdit synthesizes a coarse Edit tool name without touching the diff", () => {
    const fields = extractFields("cursor", "afterFileEdit", {
      conversation_id: "sess-1",
      model: "claude-sonnet-5",
      file_path: "/Users/jay/secret-project/file.ts",
      edits: [{ old_string: "password = 'x'", new_string: "password = 'y'" }],
    });
    expect(fields.toolName).toBe("Edit");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("sess-1");
    expect(fields.model).toBe("claude-sonnet-5");
  });

  it("afterAgentResponse never reads the response text", () => {
    const fields = extractFields("cursor", "afterAgentResponse", {
      conversation_id: "sess-2",
      text: "the assistant's full reply, never allowed to leave this process",
    });
    expect(fields.toolName).toBeUndefined();
    expect(fields.success).toBe(true);
    expect(fields).not.toHaveProperty("text");
  });

  it("stop maps status:completed to success and anything else to failure", () => {
    expect(extractFields("cursor", "stop", { status: "completed" }).success).toBe(true);
    expect(extractFields("cursor", "stop", { status: "aborted" }).success).toBe(false);
    expect(extractFields("cursor", "stop", { status: "error" }).success).toBe(false);
  });
});

describe("extractFields: copilot", () => {
  it("postToolUse reads camelCase fields and collapses MCP tool names", () => {
    const fields = extractFields("copilot", "postToolUse", {
      sessionId: "s-1",
      toolName: "mcp_github_search",
      toolResult: { resultType: "success", textResultForLlm: "should never be read" },
    });
    expect(fields.toolName).toBe("mcp_tool");
    expect(fields.success).toBe(true);
    expect(fields.sessionId).toBe("s-1");
  });

  it("postToolUse also reads the VS Code-compatible snake_case shape", () => {
    const fields = extractFields("copilot", "postToolUse", {
      session_id: "s-2",
      tool_name: "read_file",
      tool_result: { result_type: "error" },
    });
    expect(fields.toolName).toBe("read_file");
    expect(fields.success).toBe(false);
    expect(fields.sessionId).toBe("s-2");
  });

  it("postToolUse treats the documented 'failure' resultType as unsuccessful, not just 'error'", () => {
    // docs.github.com/copilot/reference/hooks-reference documents
    // resultType as "success" | "failure" -- "error" is not the only
    // non-success value, so the check must require "success" explicitly.
    expect(extractFields("copilot", "postToolUse", { toolResult: { resultType: "failure" } }).success).toBe(false);
    expect(extractFields("copilot", "postToolUse", { toolResult: {} }).success).toBe(false);
    expect(extractFields("copilot", "postToolUse", {}).success).toBe(false);
  });

  it("postToolUseFailure records the tool as unsuccessful (camelCase and VS Code shapes)", () => {
    const camel = extractFields("copilot", "postToolUseFailure", {
      sessionId: "s-3",
      toolName: "mcp_github_search",
      error: "boom -- never read",
    });
    expect(camel).toMatchObject({ toolName: "mcp_tool", success: false, sessionId: "s-3" });
    const snake = extractFields("copilot", "PostToolUseFailure", {
      hook_event_name: "PostToolUseFailure",
      session_id: "s-4",
      tool_name: "read_file",
      error: "ENOENT",
    });
    expect(snake).toMatchObject({ toolName: "read_file", success: false, sessionId: "s-4" });
  });

  it("sessionEnd maps reason:complete to success", () => {
    expect(extractFields("copilot", "sessionEnd", { reason: "complete" }).success).toBe(true);
    expect(extractFields("copilot", "sessionEnd", { reason: "error" }).success).toBe(false);
    expect(extractFields("copilot", "sessionEnd", { reason: "user_exit" }).success).toBe(false);
  });

  it("errorOccurred is always success:false and coarsens the error (never the object)", () => {
    const fields = extractFields("copilot", "errorOccurred", {
      sessionId: "s-3",
      error: { message: "stack trace and everything", name: "TypeError", stack: "at foo()" },
    });
    expect(fields.success).toBe(false);
    expect(fields.error).toBe("hook_error");
    expect(JSON.stringify(fields)).not.toContain("stack trace");
  });
});

describe("extractFields: duration_ms passthrough", () => {
  it("picks a numeric duration when a payload happens to carry one", () => {
    expect(extractFields("copilot", "postToolUse", { duration_ms: 1234 }).durationMs).toBe(1234);
    expect(extractFields("copilot", "postToolUse", { durationMs: 5 }).durationMs).toBe(5);
  });

  it("omits duration_ms when absent or non-numeric", () => {
    expect(extractFields("copilot", "postToolUse", {}).durationMs).toBeUndefined();
    expect(extractFields("copilot", "postToolUse", { duration_ms: "not a number" }).durationMs).toBeUndefined();
  });

  it("treats an empty-string duration as absent, not a false 0 (Number('') is 0)", () => {
    expect(extractFields("copilot", "postToolUse", { duration_ms: "" }).durationMs).toBeUndefined();
  });

  it("an unknown platform yields no tool/session fields", () => {
    const fields = extractFields("unknown-platform", "whatever", { conversationId: "x" });
    expect(fields.sessionId).toBeUndefined();
    expect(fields.toolName).toBeUndefined();
    expect(fields.durationMs).toBeUndefined();
  });
});

describe("buildLogRecord", () => {
  it("only ever contains allowlisted attribute keys", () => {
    const record = buildLogRecord("antigravity", "PostToolUse", {
      toolName: "Bash",
      success: true,
      durationMs: 42,
      sessionId: "conv-1",
      model: "gemini-3-pro",
    });
    for (const key of attributeKeys(record)) {
      expect(ALLOWLIST_KEYS.has(key)).toBe(true);
    }
    expect(record.resourceLogs[0].resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "agent.platform", value: { stringValue: "antigravity" } },
        { key: "seat", value: { stringValue: "antigravity" } },
      ])
    );
    const logRecord = record.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.body).toEqual({ stringValue: "antigravity.PostToolUse" });
    expect(logRecord.attributes).toEqual(
      expect.arrayContaining([
        { key: "event", value: { stringValue: "PostToolUse" } },
        { key: "tool.name", value: { stringValue: "Bash" } },
        { key: "success", value: { boolValue: true } },
        { key: "duration_ms", value: { intValue: "42" } },
        { key: "session.id", value: { stringValue: "conv-1" } },
        { key: "model", value: { stringValue: "gemini-3-pro" } },
      ])
    );
  });

  it("omits attributes for undefined fields instead of emitting null/empty values", () => {
    const record = buildLogRecord("cursor", "afterAgentResponse", { success: true });
    const logRecord = record.resourceLogs[0].scopeLogs[0].logRecords[0];
    const keys = logRecord.attributes.map((a) => a.key);
    expect(keys).toContain("event");
    expect(keys).toContain("success");
    expect(keys).not.toContain("tool.name");
    expect(keys).not.toContain("duration_ms");
    expect(keys).not.toContain("session.id");
    expect(keys).not.toContain("model");
  });

  it("ignores any field beyond the known five, even when it carries forbidden-looking content", () => {
    // extractFields would never produce these extra keys in real use, but
    // buildLogRecord itself must not widen what it reads off `fields` if a
    // caller (or a future extractor bug) ever passed them through: it must
    // read exactly toolName/success/durationMs/sessionId/model and nothing
    // else, no matter what else rides along on the object.
    // Deliberately NOT shaped like a real credential (no "Bearer ", no
    // "api_key=", no "authorization:") -- this is a content-leak test, not a
    // secret-scanner test, and a credential-shaped fixture string trips
    // CI's own gitleaks gate on this file even though it is fake.
    const FORBIDDEN = "FORBIDDEN-fixture-2f6a19";
    const record = buildLogRecord("cursor", "afterFileEdit", {
      toolName: "Edit",
      success: true,
      sessionId: "sess-1",
      prompt: `the user's private message: ${FORBIDDEN}`,
      transcriptPath: `/Users/jay/very/private/${FORBIDDEN}.json`,
      workspacePaths: [`/Users/jay/${FORBIDDEN}-repo`],
      command: `some-tool --flag ${FORBIDDEN}`,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(new RegExp(`${FORBIDDEN}|transcriptPath|workspacePaths`, "i"));
    const logRecord = record.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.attributes.map((a) => a.key).sort()).toEqual(["event", "session.id", "tool.name", "success"].sort());
  });

  it("stamps a plausible current timeUnixNano", () => {
    const before = BigInt(Date.now()) * 1_000_000n;
    const record = buildLogRecord("copilot", "postToolUse", {});
    const after = BigInt(Date.now()) * 1_000_000n;
    const stamped = BigInt(record.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano);
    expect(stamped >= before && stamped <= after).toBe(true);
  });

  it("stamps a fresh 32/16-hex trace/span id pair on every record (required for Sentry to index the log -- see newTraceContext's comment)", () => {
    const a = buildLogRecord("copilot", "postToolUse", {}).resourceLogs[0].scopeLogs[0].logRecords[0];
    const b = buildLogRecord("copilot", "postToolUse", {}).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  it("accepts an injectable randomBytes for deterministic tests", () => {
    const fixed = (n) => Buffer.alloc(n, 0xab);
    const record = buildLogRecord("cursor", "stop", {}, fixed).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.traceId).toBe("ab".repeat(16));
    expect(record.spanId).toBe("ab".repeat(8));
  });
});

describe("noopReplyFor / NOOP_REPLIES", () => {
  it("antigravity's three wired events each have a fixed safe reply", () => {
    expect(noopReplyFor("antigravity", "PostToolUse")).toEqual({});
    expect(noopReplyFor("antigravity", "PostInvocation")).toEqual({});
    expect(noopReplyFor("antigravity", "Stop")).toEqual({});
  });

  it("cursor and copilot events have no special reply (fire-and-forget, print nothing)", () => {
    expect(noopReplyFor("cursor", "afterFileEdit")).toBeUndefined();
    expect(noopReplyFor("cursor", "afterAgentResponse")).toBeUndefined();
    expect(noopReplyFor("cursor", "stop")).toBeUndefined();
    expect(noopReplyFor("copilot", "postToolUse")).toBeUndefined();
    expect(noopReplyFor("copilot", "sessionEnd")).toBeUndefined();
    expect(noopReplyFor("copilot", "errorOccurred")).toBeUndefined();
  });

  it("NOOP_REPLIES only covers antigravity today", () => {
    expect(Object.keys(NOOP_REPLIES)).toEqual(["antigravity"]);
  });
});

describe("parsePayload", () => {
  it("parses a valid JSON object", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns {} for empty, whitespace, malformed, or non-object input", () => {
    expect(parsePayload("")).toEqual({});
    expect(parsePayload("   ")).toEqual({});
    expect(parsePayload("{not json")).toEqual({});
    expect(parsePayload("42")).toEqual({});
    expect(parsePayload("[1,2,3]")).toEqual({});
    expect(parsePayload("null")).toEqual({});
  });
});

describe("scheduleBackgroundSend", () => {
  it("spawns a detached `node <scriptPath> --send`, writes {credentials, body} to its stdin, and unrefs it", () => {
    const stdinChunks = [];
    const fakeChild = {
      stdin: { end: (data) => stdinChunks.push(data), on: () => {} },
      on: () => {},
      unref: vi.fn(),
    };
    const spawnImpl = vi.fn(() => fakeChild);
    const credentials = { endpoint: "https://example.sentry.io/v1/logs", headerName: "x-sentry-auth", headerValue: "v" };
    const body = { resourceLogs: [] };

    scheduleBackgroundSend("/path/to/agent-hook-otlp.mjs", credentials, body, spawnImpl);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [execPath, args, options] = spawnImpl.mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args).toEqual(["/path/to/agent-hook-otlp.mjs", "--send"]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(["pipe", "ignore", "ignore"]);
    expect(JSON.parse(stdinChunks[0])).toEqual({ credentials, body });
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it("never throws when spawnImpl itself throws", () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("EMFILE");
    });
    expect(() => scheduleBackgroundSend("/path", { endpoint: "e" }, {}, spawnImpl)).not.toThrow();
  });

  it("never throws when the returned child has no stdin (e.g. a stub missing it)", () => {
    const spawnImpl = vi.fn(() => ({ on: () => {}, unref: () => {} }));
    expect(() => scheduleBackgroundSend("/path", { endpoint: "e" }, {}, spawnImpl)).not.toThrow();
  });
});

describe("postOtlp", () => {
  it("posts once with the auth header and never throws on success", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    });
    await postOtlp(
      { endpoint: "https://example.sentry.io/v1/logs", headerName: "x-sentry-auth", headerValue: "abc" },
      { hello: "world" },
      fetchImpl
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.sentry.io/v1/logs");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-sentry-auth"]).toBe("abc");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ hello: "world" });
  });

  it("swallows a network error without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      postOtlp({ endpoint: "https://x.sentry.io", headerName: "h", headerValue: "v" }, {}, fetchImpl)
    ).resolves.toBeUndefined();
  });

  it("aborts and swallows the abort instead of hanging when fetch never resolves", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          })
      );
      const promise = postOtlp({ endpoint: "https://x.sentry.io", headerName: "h", headerValue: "v" }, {}, fetchImpl);
      await vi.advanceTimersByTimeAsync(2100);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never calls fetch for an untrusted endpoint, even with valid-looking credentials", async () => {
    const fetchImpl = vi.fn();
    await postOtlp({ endpoint: "https://evil.example.com/v1/logs", headerName: "h", headerValue: "v" }, {}, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does call fetch for loopback (v2 self-test / local UM)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202 }));
    await postOtlp(
      { endpoint: "http://127.0.0.1:4103/api/otlp/v1/traces", headerName: "Authorization", headerValue: "Bearer x" },
      { turns: [] },
      fetchImpl
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("isEntrypoint", () => {
  it("is true when argv[1]'s realpath matches import.meta.url", () => {
    const realpath = (p) => {
      expect(p).toBe("/some/symlink/agent-hook-otlp.mjs");
      return "/real/target/agent-hook-otlp.mjs";
    };
    const metaUrl = pathToFileURL("/real/target/agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/some/symlink/agent-hook-otlp.mjs"], metaUrl, realpath)).toBe(true);
  });

  it("is false when running as an imported module (different file)", () => {
    const realpath = (p) => p;
    const metaUrl = pathToFileURL("/real/target/agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/some/other/script.mjs"], metaUrl, realpath)).toBe(false);
  });

  it("is false when argv has no script path", () => {
    expect(isEntrypoint(["node"], "file:///x", () => "/x")).toBe(false);
  });

  it("falls back to a literal comparison when realpath throws (e.g. deleted mid-run)", () => {
    const realpath = () => {
      throw new Error("ENOENT");
    };
    const metaUrl = pathToFileURL("/real/target/agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/real/target/agent-hook-otlp.mjs"], metaUrl, realpath)).toBe(true);
    expect(isEntrypoint(["node", "/other/path.mjs"], metaUrl, realpath)).toBe(false);
  });
});

describe("main", () => {
  it("no-ops silently (no network call) when credentials are not configured", async () => {
    const postOtlpImpl = vi.fn();
    await main(
      ["node", "agent-hook-otlp.mjs", "cursor", "afterFileEdit"],
      // A real credentials file may exist on this machine (this repo's own
      // setup writes one); point the file fallback at a path that never
      // exists so this test exercises the true "nothing configured" path
      // regardless of the host machine's state.
      { AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/nonexistent/agent-hook-otlp-sentry.json" },
      {
        readStdin: async () => JSON.stringify({ conversation_id: "s", model: "m" }),
        postOtlp: postOtlpImpl,
      }
    );
    expect(postOtlpImpl).not.toHaveBeenCalled();
  });

  it("no-ops on an unrecognised platform without reading stdin", async () => {
    const readStdinImpl = vi.fn();
    const postOtlpImpl = vi.fn();
    await main(["node", "agent-hook-otlp.mjs", "not-a-real-platform", "SomeEvent"], {}, {
      readStdin: readStdinImpl,
      postOtlp: postOtlpImpl,
    });
    expect(readStdinImpl).not.toHaveBeenCalled();
    expect(postOtlpImpl).not.toHaveBeenCalled();
  });

  it("schedules a background send (never calls postOtlp directly) when credentials are present", async () => {
    const postOtlpImpl = vi.fn(async () => {});
    const scheduleBackgroundSendImpl = vi.fn();
    const env = {
      AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
      AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
      AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=abc",
    };
    await main(
      ["node", "/path/to/agent-hook-otlp.mjs", "copilot", "postToolUse"],
      env,
      {
        readStdin: async () => JSON.stringify({ sessionId: "s-9", toolName: "read_file", toolResult: { resultType: "success" } }),
        postOtlp: postOtlpImpl,
        scheduleBackgroundSend: scheduleBackgroundSendImpl,
      }
    );
    // The P2 fix: main() must hand the built body to the background
    // scheduler and return, never await postOtlp (the network call) itself.
    expect(postOtlpImpl).not.toHaveBeenCalled();
    expect(scheduleBackgroundSendImpl).toHaveBeenCalledTimes(1);
    const [scriptPath, credentials, body] = scheduleBackgroundSendImpl.mock.calls[0];
    expect(scriptPath).toBe("/path/to/agent-hook-otlp.mjs");
    expect(credentials.endpoint).toBe("https://example.sentry.io/v1/logs");
    const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.attributes).toEqual(
      expect.arrayContaining([{ key: "session.id", value: { stringValue: "s-9" } }])
    );
  });

  it('in "--send" mode, reads {credentials, body} from stdin and posts them -- this is the detached background sender\'s own entrypoint', async () => {
    const postOtlpImpl = vi.fn(async () => {});
    const credentials = { endpoint: "https://example.sentry.io/v1/logs", headerName: "x-sentry-auth", headerValue: "v" };
    const body = { resourceLogs: [] };
    await main(["node", "/path/to/agent-hook-otlp.mjs", "--send"], {}, {
      readStdin: async () => JSON.stringify({ credentials, body }),
      postOtlp: postOtlpImpl,
    });
    expect(postOtlpImpl).toHaveBeenCalledTimes(1);
    expect(postOtlpImpl).toHaveBeenCalledWith(credentials, body);
  });

  it('"--send" mode never throws on malformed or empty stdin, and never posts without both credentials and body', async () => {
    const postOtlpImpl = vi.fn(async () => {});
    await expect(
      main(["node", "/path/to/agent-hook-otlp.mjs", "--send"], {}, {
        readStdin: async () => "not json {{{",
        postOtlp: postOtlpImpl,
      })
    ).resolves.toBeUndefined();
    await expect(
      main(["node", "/path/to/agent-hook-otlp.mjs", "--send"], {}, {
        readStdin: async () => JSON.stringify({ credentials: null, body: { a: 1 } }),
        postOtlp: postOtlpImpl,
      })
    ).resolves.toBeUndefined();
    expect(postOtlpImpl).not.toHaveBeenCalled();
  });

  it("never throws even when readStdin itself rejects", async () => {
    await expect(
      main(["node", "agent-hook-otlp.mjs", "cursor", "stop"], {}, {
        readStdin: async () => {
          throw new Error("pipe closed");
        },
      })
    ).resolves.toBeUndefined();
  });

  it("never throws even when the background scheduler itself throws synchronously", async () => {
    const env = {
      AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
      AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
      AGENT_HOOK_OTLP_HEADER_VALUE: "v",
    };
    await expect(
      main(["node", "/path/to/agent-hook-otlp.mjs", "cursor", "stop"], env, {
        readStdin: async () => JSON.stringify({ status: "completed" }),
        scheduleBackgroundSend: () => {
          throw new Error("spawn EMFILE");
        },
      })
    ).resolves.toBeUndefined();
  });
});

describe("main -- privacy regression: no forbidden content or non-allowlisted key for any wired (platform, event)", () => {
  // One entry per (platform, event) actually wired in ~/.gemini/config/hooks.json,
  // ~/.cursor/hooks.json, and ~/.copilot/hooks/agent-hook-otlp.json today.  Each
  // payload is adversarially stuffed with sentinel strings in every field real
  // hook payloads are documented to carry, standing in for prompt text, tool
  // args/commands, file paths, transcripts, and error stacks.
  const SENTINEL = "SENTINEL-forbidden-98f13c02";
  const cases = [
    {
      platform: "antigravity",
      event: "PostToolUse",
      payload: {
        conversationId: "conv-1",
        modelName: "gemini-3-pro",
        toolCall: { name: "Bash", args: { command: `rm -rf ${SENTINEL}` } },
        error: "",
        transcriptPath: `/Users/jay/${SENTINEL}/transcript.json`,
        workspacePaths: [`/Users/jay/${SENTINEL}`],
      },
    },
    {
      platform: "antigravity",
      event: "PostInvocation",
      payload: { conversationId: "conv-2", modelName: "gemini-3-pro", response: SENTINEL, error: "" },
    },
    {
      platform: "antigravity",
      event: "Stop",
      payload: { conversationId: "conv-3", modelName: "gemini-3-pro", error: `${SENTINEL} traceback`, fullyIdle: true },
    },
    {
      platform: "cursor",
      event: "afterFileEdit",
      payload: { conversation_id: "c-1", model: "claude-sonnet-5", file_path: `/repo/${SENTINEL}.ts`, diff: SENTINEL },
    },
    {
      platform: "cursor",
      event: "afterAgentResponse",
      payload: { conversation_id: "c-2", model: "claude-sonnet-5", text: SENTINEL },
    },
    {
      platform: "cursor",
      event: "stop",
      payload: { conversation_id: "c-3", model: "claude-sonnet-5", status: "completed", summary: SENTINEL },
    },
    {
      platform: "copilot",
      event: "postToolUse",
      payload: {
        sessionId: "cp-1",
        toolName: "shell",
        toolArgs: { command: SENTINEL },
        toolResult: { resultType: "success", output: SENTINEL },
      },
    },
    {
      platform: "copilot",
      event: "sessionEnd",
      payload: { sessionId: "cp-2", reason: "complete", transcript: SENTINEL },
    },
    {
      platform: "copilot",
      event: "errorOccurred",
      payload: { sessionId: "cp-3", error: `${SENTINEL} stack trace` },
    },
  ];

  for (const { platform, event, payload } of cases) {
    it(`${platform}.${event}: body carries no sentinel and only allowlisted keys`, async () => {
      const scheduleBackgroundSendImpl = vi.fn();
      const env = {
        AGENT_HOOK_OTLP_ENDPOINT: "https://example.sentry.io/v1/logs",
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "v",
      };
      await main(["node", "/path/to/agent-hook-otlp.mjs", platform, event], env, {
        readStdin: async () => JSON.stringify(payload),
        scheduleBackgroundSend: scheduleBackgroundSendImpl,
      });
      expect(scheduleBackgroundSendImpl).toHaveBeenCalledTimes(1);
      const [, credentials, body] = scheduleBackgroundSendImpl.mock.calls[0];
      expect(credentials.headerValue).toBe("v");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(SENTINEL);
      expect(attributeKeys(body)).toEqual(new Set([...attributeKeys(body)].filter((k) => ALLOWLIST_KEYS.has(k))));
    });
  }
});

describe("agent-hook-otlp.mjs as a real subprocess", () => {
  let server;
  let serverUrl;
  let receivedRequests;
  let tempDir;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function startServer() {
    receivedRequests = [];
    server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        receivedRequests.push({
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    serverUrl = `http://127.0.0.1:${port}/otlp/v1/logs`;
  }

  function run(args, { input = "{}", env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it("prints the fixed antigravity Stop reply and exits 0 regardless of the network outcome", async () => {
    await startServer();
    const payload = {
      conversationId: "conv-secret-session",
      modelName: "gemini-3-pro",
      error: "",
      fullyIdle: true,
      transcriptPath: "/Users/jay/very/private/transcript.json",
      workspacePaths: ["/Users/jay/private-repo"],
    };
    const { code, stdout } = await run(["antigravity", "Stop"], {
      input: JSON.stringify(payload),
      env: {
        AGENT_HOOK_OTLP_ENDPOINT: "https://evil.example.com/v1/logs",
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe(JSON.stringify({}));

    // The host-visible stdout reply is unconditional.  Loopback is now a
    // trusted v2 target, so this test points at an untrusted internet host
    // to prove the reply still lands when the send is dropped.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedRequests).toHaveLength(0);
  });

  it("never sends to an untrusted internet host even when credentials otherwise resolve cleanly", async () => {
    await startServer();
    const { code, stdout } = await run(["cursor", "afterFileEdit"], {
      input: JSON.stringify({ conversation_id: "conv-secret-session", model: "claude-sonnet-5" }),
      env: {
        AGENT_HOOK_OTLP_ENDPOINT: "https://evil.example.com/v1/logs",
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedRequests).toHaveLength(0);
  });

  it("exits 0 and prints nothing extra for a fire-and-forget cursor event, even with no server listening", async () => {
    const { code, stdout, stderr } = await run(["cursor", "afterAgentResponse"], {
      input: JSON.stringify({ conversation_id: "s", text: "never sent" }),
      env: {
        AGENT_HOOK_OTLP_ENDPOINT: "http://127.0.0.1:1/unreachable",
        AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
        AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("exits 0 with malformed stdin and no configured credentials", async () => {
    const { code, stdout } = await run(["copilot", "postToolUse"], {
      input: "not json at all {{{",
      env: {
        AGENT_HOOK_OTLP_CREDENTIALS_FILE: "/nonexistent/agent-hook-otlp-sentry.json",
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("reads credentials from a chmod-600 file and delivers to loopback (v2; v1 silently dropped this)", async () => {
    await startServer();
    tempDir = await mkdtemp(join(tmpdir(), "agent-hook-otlp-"));
    const credsPath = join(tempDir, "creds.json");
    await writeFile(
      credsPath,
      JSON.stringify({ endpoint: serverUrl, headerName: "x-sentry-auth", headerValue: "sentry sentry_key=fromfile" }),
      { mode: 0o600 }
    );
    const { code, stdout } = await run(["cursor", "afterFileEdit"], {
      input: JSON.stringify({ conversation_id: "s-file", model: "claude-sonnet-5" }),
      env: { AGENT_HOOK_OTLP_CREDENTIALS_FILE: credsPath },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    await vi.waitFor(() => expect(receivedRequests.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(receivedRequests[0].headers["x-sentry-auth"]).toBe("sentry sentry_key=fromfile");
    expect(receivedRequests[0].body).toContain("s-file");
    expect(receivedRequests[0].body).not.toContain("fromfile");
  });

  it("still runs main() when invoked through a symlink (P2 finding: import.meta.url resolves the real path)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-hook-otlp-symlink-"));
    const linkPath = join(tempDir, "agent-hook-otlp-link.mjs");
    await symlink(SCRIPT_PATH, linkPath);

    const { code, stdout } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [linkPath, "antigravity", "PostToolUse"], {
        env: {
          ...process.env,
          // A fake, never-sentry.io host: isTrustedSentryEndpoint rejects it
          // synchronously (proven separately by isTrustedSentryEndpoint's and
          // postOtlp's own unit tests), so the detached background sender
          // this spawns never dials out -- this regression test only needs
          // to prove main() actually ran through the symlink, not that a
          // real request reached a real host, and CI must not make real
          // outbound calls.
          AGENT_HOOK_OTLP_ENDPOINT: "https://fake.invalid.example/v1/logs",
          AGENT_HOOK_OTLP_HEADER_NAME: "x-sentry-auth",
          AGENT_HOOK_OTLP_HEADER_VALUE: "sentry sentry_key=test",
        },
      });
      let out = "";
      child.on("error", reject);
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (closeCode) => resolve({ code: closeCode, stdout: out }));
      child.stdin.end(JSON.stringify({ toolCall: { name: "Bash" }, conversationId: "via-symlink" }));
    });

    // Proves main() actually ran (the antigravity PostToolUse "{}" reply is
    // written by main() itself, after the symlink-safe entrypoint check
    // passes) -- not that a real POST reached sentry.io, which this sandbox
    // cannot reach and does not need to for this specific regression.
    expect(code).toBe(0);
    expect(stdout).toBe(JSON.stringify({}));
  });

  it("scheduleBackgroundSend returns immediately even when the spawned child is slow -- real detached child, real timing (P2 fix regression guard)", async () => {
    // This is the direct proof for the P2 finding: the caller (main(), and
    // therefore the hook host waiting on this process) must never block on
    // however long the actual "network" work inside the detached child
    // takes.  A real child process is spawned here -- via the real
    // scheduleBackgroundSend, not a mock -- that deliberately sleeps for
    // 1.2s (standing in for a slow cold start + fetch) before writing a
    // marker file, well past the 500ms this test allows the CALLER to take.
    tempDir = await mkdtemp(join(tmpdir(), "agent-hook-otlp-slow-"));
    const markerPath = join(tempDir, "marker.txt");
    const slowScriptPath = join(tempDir, "slow-child.mjs");
    await writeFile(
      slowScriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        `    writeFileSync(${JSON.stringify(markerPath)}, 'ran');`,
        "  }, 1200);",
        "});",
      ].join("\n")
    );

    const start = Date.now();
    scheduleBackgroundSend(slowScriptPath, { endpoint: "https://example.sentry.io/v1/logs" }, { fake: "body" });
    const elapsed = Date.now() - start;

    // scheduleBackgroundSend's own work is a synchronous spawn() call (the
    // fork/exec happens inside it) plus writing to a pipe -- it does not
    // wait for the child's Node runtime to finish starting, so this must be
    // fast regardless of machine load, unlike the child's own cold start.
    expect(elapsed).toBeLessThan(500);
    // Not written yet -- the child is still "working" at this point, proving
    // this test would fail if scheduleBackgroundSend ever awaited it.
    expect(existsSync(markerPath)).toBe(false);

    // Poll rather than a single fixed sleep: this Mac's load average can
    // push a cold Node start well past a second on its own (see the P2
    // finding this test guards against), so a generous, self-terminating
    // ceiling is used instead of a brittle fixed wait.
    const deadline = Date.now() + 15_000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(existsSync(markerPath)).toBe(true);
  }, 20_000);
});
