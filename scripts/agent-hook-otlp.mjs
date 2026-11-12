#!/usr/bin/env node
// Shared hook-to-OTLP shim for coding-agent CLIs that have a native hook
// mechanism but no OTel exporter of their own: agy (Antigravity CLI), Cursor,
// and GitHub Copilot CLI.  Claude Code and Codex CLI already export OTLP
// natively (~/.claude/settings.json, ~/.codex/config.toml [otel]) and are not
// wired through this script.
//
// What it does: reads ONE hook-event JSON payload on stdin, maps it through a
// strict allowlist, and POSTs either:
//   - an OTLP/HTTP JSON log record (Sentry `agent-sessions`, the original
//     target), or
//   - a `{ turns: [...] }` AgentTurn payload when the endpoint path contains
//     `/traces` or AGENT_HOOK_OTLP_FORMAT=turns (Usage Monitor
//     POST /api/otlp/v1/traces, or the fleet-telemetry-relay).
//
// Why v1 never delivered (2026-10-11 audit):
//   1. isTrustedSentryEndpoint rejected every non-sentry.io URL, so pointing
//      the shim at usage.jays.services or a relay was a silent no-op.
//   2. Missing credentials file / env trio is also a silent no-op (by
//      design -- a hook must never fail the agent). Run --self-test.
//   3. Cursor Cloud / non-interactive CLI often never fires
//      afterAgentResponse / stop; wire afterFileEdit too and use the
//      in-repo .cursor/hooks.json template for Cloud Agents.
//   4. Sentry Logs does not index unknown resource attrs such as
//      agent.platform the way UM traces does -- even a 200 can look like
//      "nothing landed" in the Sentry UI.
//
// Allowlisted fields ONLY -- everything else is dropped on the floor:
//   agent.platform, seat, event, tool.name, success, duration_ms,
//   session.id / conversationId, generationId, model, token counts,
//   costUsd, error
// Prompt/response text is OFF by default.  Jay approved capture behind
// AGENT_HOOK_OTLP_INCLUDE_CONTENT=1 (truncated at 4000 chars).  Tool
// arguments, file paths, and commands are never forwarded.
//
// Usage:
//   node agent-hook-otlp.mjs <platform> <event>
//     platform: antigravity | cursor | copilot
//     event:    the hook name exactly as that platform's own hooks.json uses
//               it (e.g. PostToolUse, afterFileEdit, postToolUse)
//   node agent-hook-otlp.mjs --self-test
//     Prints one secret-free JSON line: configured / trusted / format /
//     host.  Add AGENT_HOOK_OTLP_SELF_TEST_POST=1 to actually POST a
//     synthetic turn (still never prints the credential).
//
// Contract: reads stdin, builds at most one OTLP log record, and hands it to
// a DETACHED background process for the actual network POST (bounded there
// to a 2s timeout) -- the invoked (foreground) process itself never awaits
// the network and returns as soon as the send is scheduled.  This process
// ALWAYS exits 0, and prints nothing on stdout unless the specific
// platform+event needs a fixed no-op reply to guarantee it never blocks the
// host tool (see NOOP_REPLIES below) -- never anything derived from the
// payload.  A misconfigured or unreachable Sentry endpoint must never surface
// as hook failure, a blocked tool call, or a terminated agent turn.
//
// Why detached rather than a plain unawaited fetch: every host here applies
// a hook timeout of 3s, and a cold `node` start alone has been observed
// taking 2-3.85s on this Mac under heavy concurrent-agent load (see
// docs/observability/agent-hook-otlp.md) -- close enough to the old
// foreground 2s HTTP_TIMEOUT_MS that a real share of invocations were
// getting killed by the host before the POST could even complete, dropping
// the telemetry record and stalling the host's hook wait for the full
// timeout.  A `node ... --send` grandchild is spawned detached and unref'd
// (see scheduleBackgroundSend), so this process exits the instant the child
// exists as its own OS process, regardless of how long that child's own
// cold start + fetch takes.
//
// Credentials (never hardcoded here, never printed): resolved in order from
//   1. env vars AGENT_HOOK_OTLP_ENDPOINT / AGENT_HOOK_OTLP_HEADER_NAME /
//      AGENT_HOOK_OTLP_HEADER_VALUE
//   2. a chmod-600 JSON file at $AGENT_HOOK_OTLP_CREDENTIALS_FILE (default
//      ~/.config/usage-monitor/agent-hook-otlp-sentry.json), shaped
//      {"endpoint": "...", "headerName": "x-sentry-auth", "headerValue": "..."}
// Regenerate the file (never print the value; this reuses the exact header
// Claude Code already sends to the same Sentry project) with:
//   node -e '
//     const fs=require("node:fs"), os=require("node:os"), path=require("node:path");
//     const s=JSON.parse(fs.readFileSync(path.join(os.homedir(),".claude","settings.json"),"utf8"));
//     const env=s.env||{}; const endpoint=env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
//     // Split on the FIRST "=" only -- the header value itself contains one
//     // (Sentry's x-sentry-auth is "sentry sentry_key=<hex>, sentry_version=7").
//     // String.prototype.split(sep, limit) truncates rather than joining the
//     // remainder, so indexOf/slice is used instead of split("=", 2).
//     const raw=String(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS); const i=raw.indexOf("=");
//     const headerName=raw.slice(0,i), headerValue=raw.slice(i+1);
//     const dir=path.join(os.homedir(),".config","usage-monitor"); fs.mkdirSync(dir,{recursive:true});
//     const out=path.join(dir,"agent-hook-otlp-sentry.json");
//     fs.writeFileSync(out, JSON.stringify({endpoint, headerName: headerName.trim(), headerValue: headerValue.trim()}), {mode:0o600});
//     // `mode` only applies when the file is created -- re-tighten an
//     // existing (e.g. 0644) file so the ingest credential is not world-readable.
//     fs.chmodSync(out, 0o600);
//     console.log("wrote", out, "(", fs.statSync(out).size, "bytes )");
//   '
// If neither source resolves, the shim is a silent no-op (still exits 0).
//
// Wiring: every hooks.json below invokes the PINNED copy at
// ~/.local/share/agent-hook-otlp/agent-hook-otlp.mjs, never a path inside a
// git worktree -- ~/Code/<App> is reset by a daemon and can be checked out
// on any branch at any time, and a stale/missing pinned copy would silently
// break every wired hook (see docs/observability/agent-hook-otlp.md).
// Refresh the pinned copy from origin/main with:
//   node scripts/install-agent-hook-otlp.mjs
//   agy      ~/.gemini/config/hooks.json     -- PostInvocation, Stop only
//                                                (PostToolUse is not a
//                                                recognized agy hook event
//                                                in the installed CLI build
//                                                -- confirmed via
//                                                `agy -p "/hooks"
//                                                --output-format json`,
//                                                with and without an added
//                                                "matcher" key; never wire
//                                                it)
//   Cursor   ~/.cursor/hooks.json            -- fire-and-forget events only
//   Copilot  ~/.copilot/hooks/*.json         -- fire-and-forget events only
// Listed as an on-demand helper in /Users/jay/apps/MAC-LOCAL-PROCESSES.md.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HTTP_TIMEOUT_MS = 2000;
const SERVICE_NAME = "agent-hook-otlp";
const CONTENT_MAX_CHARS = 4000;
const ERROR_MAX_CHARS = 1000;
const BUILTIN_HTTPS_HOSTS = Object.freeze(["usage.jays.services"]);

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

export function defaultCredentialsFilePath() {
  return join(homedir(), ".config", "usage-monitor", "agent-hook-otlp-sentry.json");
}

/**
 * Resolve {endpoint, headerName, headerValue} from env vars, then a
 * chmod-600 JSON file.  Returns null (never throws) when nothing usable is
 * configured -- the caller then no-ops.  `readFile` is injectable for tests.
 */
export function resolveCredentials(env = process.env, readFile = readFileSync) {
  const envEndpoint = env.AGENT_HOOK_OTLP_ENDPOINT?.trim();
  const envHeaderName = env.AGENT_HOOK_OTLP_HEADER_NAME?.trim();
  const envHeaderValue = env.AGENT_HOOK_OTLP_HEADER_VALUE?.trim();
  if (envEndpoint && envHeaderName && envHeaderValue) {
    return { endpoint: envEndpoint, headerName: envHeaderName, headerValue: envHeaderValue };
  }

  const filePath = env.AGENT_HOOK_OTLP_CREDENTIALS_FILE?.trim() || defaultCredentialsFilePath();
  try {
    const raw = readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint.trim() : "";
    const headerName = typeof parsed.headerName === "string" ? parsed.headerName.trim() : "";
    const headerValue = typeof parsed.headerValue === "string" ? parsed.headerValue.trim() : "";
    if (endpoint && headerName && headerValue) {
      return { endpoint, headerName, headerValue };
    }
    return null;
  } catch {
    return null;
  }
}

export function isContentCaptureEnabled(env = process.env) {
  const raw = env.AGENT_HOOK_OTLP_INCLUDE_CONTENT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function resolvePayloadFormat(endpoint, env = process.env) {
  const explicit = env.AGENT_HOOK_OTLP_FORMAT?.trim().toLowerCase();
  if (explicit === "turns" || explicit === "logs") return explicit;
  try {
    const pathname = new URL(endpoint).pathname;
    if (pathname.includes("/traces")) return "turns";
  } catch {
    // fall through to logs
  }
  return "logs";
}

function truncate(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function asSafeInt(value) {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i >= 0 && i <= 2_147_483_647 ? i : undefined;
}

function asFiniteNumber(value) {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Per-platform field extraction -- narrow picks only, applied once per hook
// invocation.  Prompt/response stay off unless INCLUDE_CONTENT is set.
// Tool arguments, file paths, commands, and diffs are never forwarded.
// ---------------------------------------------------------------------------

const MCP_TOOL_PATTERN = /mcp/i;

/** Coarsen a tool name: MCP-flavoured names collapse to "mcp_tool". */
export function coarseToolName(name) {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const trimmed = name.trim();
  return MCP_TOOL_PATTERN.test(trimmed) ? "mcp_tool" : trimmed;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pick(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** platform "antigravity" (agy).  Payload shapes per antigravity.google/docs/hooks. */
function extractAntigravity(event, payload) {
  const sessionId = nonEmptyString(payload?.conversationId);
  const model = nonEmptyString(payload?.modelName);
  const hasError = nonEmptyString(payload?.error) !== undefined;
  switch (event) {
    case "PostToolUse":
      return {
        toolName: coarseToolName(payload?.toolCall?.name),
        success: !hasError,
        sessionId,
        model,
      };
    case "PostInvocation":
      return { success: true, sessionId, model };
    case "Stop":
      return { success: !hasError, sessionId, model };
    default:
      return { success: !hasError, sessionId, model };
  }
}

/** platform "cursor".  Payload shapes per cursor.com/docs/agent/hooks. */
function extractCursor(event, payload) {
  const sessionId = nonEmptyString(payload?.conversation_id);
  const model = nonEmptyString(payload?.model);
  switch (event) {
    case "afterFileEdit":
      return { toolName: "Edit", success: true, sessionId, model };
    case "afterAgentResponse":
      return { success: true, sessionId, model };
    case "stop":
      return { success: payload?.status === "completed", sessionId, model };
    default:
      return { success: true, sessionId, model };
  }
}

/** platform "copilot".  Payload shapes per docs.github.com/copilot/reference/hooks-reference (camelCase and VS Code-compatible snake_case both handled). */
function extractCopilot(event, payload) {
  const sessionId = nonEmptyString(pick(payload, "sessionId", "session_id"));
  switch (event) {
    case "postToolUse": {
      const toolName = coarseToolName(pick(payload, "toolName", "tool_name"));
      const toolResult = pick(payload, "toolResult", "tool_result") || {};
      // Documented values are "success" / "failure" (docs.github.com/copilot/
      // reference/hooks-reference) -- require the exact success value rather
      // than merely excluding "error", so a documented "failure" result (or
      // any future/unknown value) is correctly recorded as not successful.
      const resultType = pick(toolResult, "resultType", "result_type");
      return { toolName, success: resultType === "success", sessionId };
    }
    case "postToolUseFailure":
    case "PostToolUseFailure":
      // Fires after a tool completes with a failure; the payload carries
      // toolName/tool_name and an `error` string, no toolResult.
      return { toolName: coarseToolName(pick(payload, "toolName", "tool_name")), success: false, sessionId };
    case "sessionEnd": {
      const reason = pick(payload, "reason");
      return { success: reason === "complete", sessionId };
    }
    case "errorOccurred":
      return { success: false, sessionId };
    default:
      return { sessionId };
  }
}

const EXTRACTORS = {
  antigravity: extractAntigravity,
  cursor: extractCursor,
  copilot: extractCopilot,
};

/**
 * Extract the allowlisted fields for one (platform, event, payload).  Never
 * throws; an unrecognised platform/event yields an empty field set, which
 * still produces a valid (near-empty) log record.
 */
export function extractFields(platform, event, payload, env = process.env) {
  const extractor = EXTRACTORS[platform];
  const fields = extractor ? extractor(event, payload ?? {}) : {};
  const body = payload ?? {};
  // duration_ms is speculative across all three platforms today (none of
  // their documented hook payloads carry it) -- pick it defensively so a
  // future payload version is honoured without a code change, but never
  // fabricate one.
  const durationRaw = pick(body, "duration_ms", "durationMs", "duration");
  // Number("") is 0, which Number.isFinite treats as finite -- guard it
  // explicitly so an empty string is "absent", not a false duration_ms:0.
  const durationMs =
    durationRaw !== "" && Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : undefined;

  const usage = body.usage && typeof body.usage === "object" ? body.usage : {};
  const generationId = nonEmptyString(
    pick(body, "generation_id", "generationId", "generation.id")
  );
  const inputTokens = asSafeInt(
    pick(body, "input_tokens", "inputTokens", "prompt_tokens") ??
      pick(usage, "input_tokens", "inputTokens", "prompt_tokens")
  );
  const outputTokens = asSafeInt(
    pick(body, "output_tokens", "outputTokens", "completion_tokens") ??
      pick(usage, "output_tokens", "outputTokens", "completion_tokens")
  );
  const cacheTokens = asSafeInt(
    pick(body, "cache_tokens", "cacheTokens") ?? pick(usage, "cache_tokens", "cacheTokens")
  );
  const costUsd = asFiniteNumber(pick(body, "cost_usd", "costUsd") ?? pick(usage, "cost_usd", "costUsd"));
  // Coarse error only -- never the raw stack/transcript (privacy regression
  // guard in agent-hook-otlp.test.mjs stuffs SENTINEL into `error`).
  const error =
    fields.success === false || nonEmptyString(pick(body, "error", "errorMessage", "exception"))
      ? "hook_error"
      : undefined;

  const extra = {
    durationMs,
    generationId,
    inputTokens,
    outputTokens,
    cacheTokens,
    costUsd: costUsd != null && costUsd >= 0 ? costUsd : undefined,
    error,
  };

  if (isContentCaptureEnabled(env)) {
    extra.promptText = truncate(
      nonEmptyString(pick(body, "prompt", "promptText", "input")),
      CONTENT_MAX_CHARS
    );
    extra.responseText = truncate(
      nonEmptyString(pick(body, "response", "responseText", "text", "summary")),
      CONTENT_MAX_CHARS
    );
  }
  return { ...fields, ...extra };
}

// ---------------------------------------------------------------------------
// OTLP log record
// ---------------------------------------------------------------------------

function attr(key, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { intValue: String(Math.trunc(value)) } };
  return { key, value: { stringValue: String(value) } };
}

/**
 * Generate a fresh W3C-shaped trace/span id pair (32/16 lowercase hex
 * chars).  Empirically required: Sentry's OTLP logs ingest accepts (200 OK)
 * and even correlates-by-trace a record with no traceId/spanId, but never
 * surfaces it in the Logs product or free-text log search -- confirmed by
 * probing the identical endpoint with and without these fields and checking
 * `GET .../explore/traces/trace/<id>` (which reports a log count per trace
 * regardless of full-text search indexing lag).  There is no real parent
 * span here -- each hook invocation gets its own synthetic, disposable
 * trace -- but the fields must be present for Sentry to index the log.
 */
function newTraceContext(randomBytesImpl = randomBytes) {
  return {
    traceId: randomBytesImpl(16).toString("hex"),
    spanId: randomBytesImpl(8).toString("hex"),
  };
}

/** Build one OTLP/HTTP JSON resourceLogs body from allowlisted fields only. */
export function buildLogRecord(platform, event, fields, randomBytesImpl = randomBytes) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const { traceId, spanId } = newTraceContext(randomBytesImpl);
  const resourceAttributes = [
    attr("service.name", SERVICE_NAME),
    attr("agent.platform", platform),
    attr("seat", platform),
  ].filter(Boolean);
  const logAttributes = [
    attr("event", event),
    attr("tool.name", fields.toolName),
    attr("success", fields.success),
    attr("duration_ms", fields.durationMs),
    attr("session.id", fields.sessionId),
    attr("generation.id", fields.generationId),
    attr("model", fields.model),
    attr("input_tokens", fields.inputTokens),
    attr("output_tokens", fields.outputTokens),
    attr("cache_tokens", fields.cacheTokens),
    attr("cost_usd", fields.costUsd),
    attr("error", fields.error),
  ].filter(Boolean);

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: SERVICE_NAME },
            logRecords: [
              {
                timeUnixNano: nowNs.toString(),
                severityNumber: 9,
                severityText: "INFO",
                traceId,
                spanId,
                body: { stringValue: `${platform}.${event}` },
                attributes: logAttributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Direct `{ turns: [...] }` payload for UM /api/otlp/v1/traces or the relay. */
export function buildTurnRecord(platform, event, fields) {
  const toolNames = fields.toolName ? [fields.toolName] : undefined;
  return {
    turns: [
      {
        platform,
        seat: platform,
        conversationId: fields.sessionId,
        generationId: fields.generationId,
        model: fields.model,
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
        cacheTokens: fields.cacheTokens,
        costUsd: fields.costUsd,
        durationMs: fields.durationMs,
        toolCount: toolNames ? toolNames.length : undefined,
        toolNames,
        error: fields.error,
        promptText: fields.promptText,
        responseText: fields.responseText,
        occurredAt: new Date().toISOString(),
        attributes: {
          event,
          success: fields.success,
        },
      },
    ],
  };
}

export function buildOutboundBody(platform, event, fields, endpoint, env = process.env) {
  return resolvePayloadFormat(endpoint, env) === "turns"
    ? buildTurnRecord(platform, event, fields)
    : buildLogRecord(platform, event, fields);
}

// ---------------------------------------------------------------------------
// Fixed no-op replies -- only where a platform's own hook contract requires
// an explicit reply to guarantee the hook never blocks or alters the host
// tool.  Every other (platform, event) prints nothing.
// ---------------------------------------------------------------------------

export const NOOP_REPLIES = {
  antigravity: {
    PostToolUse: {},
    PostInvocation: {},
    Stop: {},
  },
};

export function noopReplyFor(platform, event) {
  return NOOP_REPLIES[platform]?.[event];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * True only for an https:// URL whose host is exactly `sentry.io` or a
 * subdomain of it.  The credentials file's `endpoint` is local, trusted,
 * chmod-600 data (see resolveCredentials), but postOtlp still checks this
 * before sending: it is the one place file content decides an outbound
 * request's destination (CodeQL js/file-access-to-http, alerts #52/#53), so
 * it is worth constraining independently of trusting the file's contents.
 */
export function isTrustedSentryEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && (url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io"));
}

/**
 * v2 trust gate.  sentry.io stays (v1).  Also allows usage.jays.services,
 * loopback (self-test / local UM), and extra hosts from
 * AGENT_HOOK_OTLP_ALLOWED_HOSTS (comma-separated, https only).  This is
 * why v1 never delivered to UM or the relay: those hosts were dropped
 * before fetch.
 */
export function isTrustedOtlpEndpoint(endpoint, env = process.env) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1";
  if (isLoopback) return url.protocol === "http:" || url.protocol === "https:";
  if (url.protocol !== "https:") return false;
  if (host === "sentry.io" || host.endsWith(".sentry.io")) return true;
  if (BUILTIN_HTTPS_HOSTS.includes(host)) return true;
  const extra = (env.AGENT_HOOK_OTLP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(host);
}

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

/**
 * POST the record, bounded to HTTP_TIMEOUT_MS.  Never throws;
 * the caller does not need a try/catch.  `fetchImpl` is injectable for tests.
 */
export async function postOtlp(credentials, body, fetchImpl = fetch, env = process.env) {
  if (!isTrustedOtlpEndpoint(credentials.endpoint, env)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    await fetchImpl(credentials.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [credentials.headerName]: credentials.headerValue,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Fire-and-forget: network errors, timeouts, and non-2xx responses are
    // never surfaced to the host tool.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand {credentials, body} to a DETACHED `node <scriptPath> --send` child
 * over its stdin and return without waiting for it.  The child performs the
 * actual postOtlp() network call (see the `--send` branch in main()) fully
 * independently of this process's lifetime: `detached: true` + `unref()` is
 * the standard Node idiom for a fire-and-forget background process --
 * spawn() creates the real OS process synchronously (the fork/exec happens
 * inside this call), so the child already exists before this function
 * returns and keeps running after this process exits.  Never throws;
 * `spawnImpl` is injectable for tests.
 */
export function scheduleBackgroundSend(scriptPath, credentials, body, spawnImpl = spawn) {
  try {
    const child = spawnImpl(process.execPath, [scriptPath, "--send"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {
      // Spawn failed (e.g. missing/unreadable scriptPath) -- best-effort
      // telemetry only, never surfaced to the caller.
    });
    child.stdin?.on("error", () => {
      // e.g. EPIPE if the child died before the write landed.
    });
    child.stdin?.end(JSON.stringify({ credentials, body }));
    child.unref();
  } catch {
    // Never let a scheduling failure reach the caller.
  }
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse the hook payload; malformed/empty input yields {} rather than throwing. */
export function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv, env = process.env, deps = {}) {
  const readStdinImpl = deps.readStdin ?? readStdin;
  const postOtlpImpl = deps.postOtlp ?? postOtlp;
  const scheduleBackgroundSendImpl = deps.scheduleBackgroundSend ?? scheduleBackgroundSend;
  const platform = argv[2];

  if (platform === "--self-test") {
    await runSelfTest(env, {
      postOtlp: postOtlpImpl,
      write: deps.write ?? ((line) => process.stdout.write(line)),
    });
    return;
  }

  // Background-sender mode: a detached child spawned by scheduleBackgroundSend
  // invokes this same script with a single "--send" argv[2].  It reads
  // {credentials, body} (already-built, already-allowlisted) from its own
  // stdin and performs the one real network POST -- fully off the critical
  // path of the actual hook invocation below, which never reaches this
  // branch.
  if (platform === "--send") {
    try {
      const raw = await readStdinImpl();
      const { credentials, body } = JSON.parse(raw || "{}");
      if (credentials && body) await postOtlpImpl(credentials, body);
    } catch {
      // Best-effort background sender; never throw.
    }
    return;
  }

  const event = argv[3];
  const reply = noopReplyFor(platform, event);
  if (reply !== undefined) {
    process.stdout.write(JSON.stringify(reply));
  }

  try {
    if (!platform || !event || !EXTRACTORS[platform]) return;
    const raw = await readStdinImpl();
    const payload = parsePayload(raw);
    const fields = extractFields(platform, event, payload, env);
    const credentials = resolveCredentials(env);
    if (!credentials) return;
    const body = buildOutboundBody(platform, event, fields, credentials.endpoint, env);
    // Schedule-and-return: the actual fetch happens in a detached child
    // (see scheduleBackgroundSend's docstring for why), so this call never
    // awaits the network and this function returns immediately after.
    scheduleBackgroundSendImpl(argv[1], credentials, body);
  } catch {
    // A telemetry shim must never fail the hook it is attached to.
  }
}

/**
 * Secret-free diagnostic.  Never prints a token, header value, or payload
 * body.  Used to debug the four silent-no-op cases that made v1 look dead.
 */
export async function runSelfTest(env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => process.stdout.write(line));
  const postOtlpImpl = deps.postOtlp ?? postOtlp;
  const credentials = resolveCredentials(env);
  const report = {
    ok: true,
    configured: Boolean(credentials),
    trusted: false,
    format: null,
    host: null,
    posted: false,
    contentCapture: isContentCaptureEnabled(env),
  };
  if (!credentials) {
    report.ok = false;
    report.reason = "no credentials (set AGENT_HOOK_OTLP_ENDPOINT + HEADER_* or the chmod-600 file)";
    write(`${JSON.stringify(report)}\n`);
    return report;
  }
  report.host = endpointHost(credentials.endpoint);
  report.trusted = isTrustedOtlpEndpoint(credentials.endpoint, env);
  report.format = resolvePayloadFormat(credentials.endpoint, env);
  if (!report.trusted) {
    report.ok = false;
    report.reason =
      "endpoint host is not trusted (sentry.io, usage.jays.services, localhost, or AGENT_HOOK_OTLP_ALLOWED_HOSTS)";
    write(`${JSON.stringify(report)}\n`);
    return report;
  }
  const shouldPost = ["1", "true", "on", "yes"].includes(
    (env.AGENT_HOOK_OTLP_SELF_TEST_POST ?? "").trim().toLowerCase()
  );
  if (shouldPost) {
    const fields = {
      sessionId: "self-test",
      model: "self-test",
      success: true,
      durationMs: 1,
    };
    const body = buildOutboundBody("cursor", "self-test", fields, credentials.endpoint, env);
    await postOtlpImpl(credentials, body, fetch, env);
    report.posted = true;
  } else {
    report.reason = "dry-run (set AGENT_HOOK_OTLP_SELF_TEST_POST=1 to POST a synthetic turn)";
  }
  write(`${JSON.stringify(report)}\n`);
  return report;
}

/**
 * True when this module is the process entrypoint (run directly), not
 * merely `import`ed (as the test suite does).  Resolves `process.argv[1]`
 * through `realpathSync` before comparing: Node canonicalizes
 * `import.meta.url` to the real (symlink-resolved) path of the executed
 * file, so a bare string comparison against the argv path is false, and
 * `main()` silently never runs, whenever a hooks.json entry invokes this
 * script through a symlink.
 */
export function isEntrypoint(argv = process.argv, metaUrl = import.meta.url, realpath = realpathSync) {
  if (!argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpath(argv[1])).href;
  } catch {
    // argv[1] does not resolve (e.g. deleted mid-run) -- fall back to a
    // literal comparison rather than silently skipping main().
    return metaUrl === pathToFileURL(argv[1]).href;
  }
}

if (isEntrypoint()) {
  main().finally(() => {
    process.exitCode = 0;
  });
}
