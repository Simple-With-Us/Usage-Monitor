import { nanosToDate, type FlatAttributes } from "./types";
import { aiRequestFromSpan, type AiRequestInput } from "./ai-request-mapper";

// ---------------------------------------------------------------------------
// OTLP traces -> AgentTurn mapping (POST /api/otlp/v1/traces)
// ---------------------------------------------------------------------------
// The relay (or any OTLP exporter) sends EITHER standard OTLP-HTTP JSON
// traces (`{ resourceSpans: [...] }`, gen_ai semconv attributes on spans)
// OR a direct turn payload (`{ turns: [...] }`) for producers without an
// OTLP span pipeline (e.g. the hook shim v2). Both shapes land in the same
// AgentTurn table.
//
// This table is diagnostic/per-turn analytics ONLY. It never writes
// ExternalUsageEvent, so token/cost ledger math (budgets, rollups) cannot
// double count against /api/otlp/v1/metrics or the JSONL collectors that
// already feed the ledger.
//
// Prompt/response text is truncated at ingest (PROMPT_RESPONSE_MAX_CHARS)
// and expires via contentExpiresAt (AGENT_TURN_CONTENT_RETENTION_DAYS,
// default 30); rows expire via AGENT_TURN_RETENTION_DAYS (default 90).
// See data-retention.ts purgeAgentTurns.
// ---------------------------------------------------------------------------

export const PROMPT_RESPONSE_MAX_CHARS = 4000;
export const ERROR_MAX_CHARS = 1000;
const MAX_TURNS_PER_REQUEST = 200;
const MAX_TOOL_NAMES = 50;
const MAX_TOOL_NAME_LENGTH = 128;

export interface AgentTurnInput {
  platform: string;
  seat?: string;
  repo?: string;
  conversationId?: string;
  generationId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
  durationMs?: number;
  toolCount?: number;
  toolNames?: string[];
  error?: string;
  promptText?: string;
  responseText?: string;
  occurredAt: Date;
  contentExpiresAt?: Date;
}

export interface MapTracesResult {
  turns: AgentTurnInput[];
  /** Per-request rows from claude_code.llm_request spans (UM-1590). */
  aiRequests: AiRequestInput[];
  ignored: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

export function agentTurnContentRetentionDays(): number {
  return readPositiveIntEnv("AGENT_TURN_CONTENT_RETENTION_DAYS", 30);
}

export function agentTurnRetentionDays(): number {
  return readPositiveIntEnv("AGENT_TURN_RETENTION_DAYS", 90);
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function asSafeInt(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  if (n == null) return undefined;
  const i = Math.trunc(n);
  return i >= 0 && i <= 2_147_483_647 ? i : undefined;
}

function normalizePlatform(raw: unknown): string {
  const v = asNonEmptyString(raw)?.toLowerCase().replace(/[\s_]+/g, "-");
  return v || "unknown-agent";
}

function contentExpiry(occurredAt: Date): Date {
  return new Date(occurredAt.getTime() + agentTurnContentRetentionDays() * 86_400_000);
}

function cleanToolNames(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: string[] = [];
  for (const item of list) {
    const name = asNonEmptyString(item);
    if (!name) continue;
    out.push(name.slice(0, MAX_TOOL_NAME_LENGTH));
    if (out.length >= MAX_TOOL_NAMES) break;
  }
  return out.length > 0 ? out : undefined;
}

function spanDurationMs(startNano: unknown, endNano: unknown): number | undefined {
  const start = asFiniteNumber(typeof startNano === "bigint" ? Number(startNano) : startNano);
  const end = asFiniteNumber(typeof endNano === "bigint" ? Number(endNano) : endNano);
  if (start == null || end == null || end < start) return undefined;
  const ms = Math.round((end - start) / 1_000_000);
  return ms >= 0 && ms <= 86_400_000 ? ms : undefined;
}

// --- OTLP resourceSpans shape (minimal subset) ------------------------------

interface OtlpSpan {
  name?: unknown;
  traceId?: unknown;
  spanId?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
  status?: { code?: unknown; message?: unknown };
}

function scalarOf(value: Record<string, unknown> | undefined): string | number | boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (value.intValue !== undefined) {
    const n = typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function flattenSpanAttributes(
  attributes: OtlpSpan["attributes"]
): Record<string, string | number | boolean | undefined> {
  const flat: Record<string, string | number | boolean | undefined> = {};
  for (const kv of attributes ?? []) {
    if (!kv || typeof kv.key !== "string" || !kv.key) continue;
    flat[kv.key] = scalarOf(kv.value);
  }
  return flat;
}

// AgentTurn.platform is a CODING-PLATFORM dimension (claude-code, codex,
// cursor-agent), and OTLP ingest credentials are scoped per producer, so a
// turn labelled with the model vendor instead of the harness both mislabels
// the turn and makes a correctly scoped credential's whole trace batch fail
// authorization (403 "Credential is not authorized for platform
// \"anthropic\"").  Claude Code's trace spans name their harness in the span
// prefix (`claude_code.interaction`, `claude_code.llm_request`, ...) while
// `gen_ai.system` names the vendor ("anthropic"), so resolve the harness
// identity first for those spans.  An explicit `agent.platform` attribute
// always wins, and non-Claude producers keep the previous resolution order.
const HARNESS_BY_SPAN_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["claude_code.", "claude-code"],
];

// OpenRouter Broadcast describes the model vendor in `gen_ai.system`, not the
// gateway that emitted the trace.  Its stable OTLP marker is
// `openrouter.trace.id`; prefer that gateway identity so one OpenRouter feed
// does not fragment AgentTurn.platform into openai/anthropic/google buckets.
const OPENROUTER_TRACE_MARKER = "openrouter.trace.id";

function resolveTurnPlatform(
  attrs: Record<string, string | number | boolean | undefined>,
  spanName: string | undefined,
  gatewayPlatform?: string
): string {
  const explicit = asNonEmptyString(attrs["agent.platform"]);
  if (explicit) return normalizePlatform(explicit);
  if (gatewayPlatform) return gatewayPlatform;
  if (asNonEmptyString(attrs[OPENROUTER_TRACE_MARKER])) return "openrouter";
  if (spanName) {
    for (const [prefix, harness] of HARNESS_BY_SPAN_PREFIX) {
      if (spanName.startsWith(prefix)) return harness;
    }
  }
  if (asNonEmptyString(attrs["service.name"])?.toLowerCase() === "claude-code") {
    return "claude-code";
  }
  return normalizePlatform(attrs["gen_ai.system"] ?? attrs["gen_ai.agent.name"]);
}

function turnFromSpanAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
  span: OtlpSpan,
  spanName?: string,
  gatewayPlatform?: string
): AgentTurnInput | null {
  const platform = resolveTurnPlatform(attrs, spanName, gatewayPlatform);
  // Skip spans that carry none of the agent/gen_ai dimensions — they are not
  // agent turns (e.g. a stray http span forwarded by a broad exporter).
  const looksLikeTurn =
    attrs["agent.platform"] !== undefined ||
    attrs["gen_ai.system"] !== undefined ||
    attrs["gen_ai.agent.name"] !== undefined ||
    attrs["gen_ai.request.model"] !== undefined ||
    attrs["gen_ai.conversation.id"] !== undefined ||
    attrs["session.id"] !== undefined;
  if (!looksLikeTurn) return null;

  const inputTokens =
    asSafeInt(attrs["gen_ai.usage.input_tokens"]) ??
    asSafeInt(attrs["gen_ai.usage.prompt_tokens"]) ??
    asSafeInt(attrs["input_tokens"]);
  const outputTokens =
    asSafeInt(attrs["gen_ai.usage.output_tokens"]) ??
    asSafeInt(attrs["gen_ai.usage.completion_tokens"]) ??
    asSafeInt(attrs["output_tokens"]);
  const cacheTokens =
    asSafeInt(attrs["gen_ai.usage.cache_tokens"]) ??
    asSafeInt(attrs["gen_ai.usage.cache_read_tokens"]) ??
    asSafeInt(attrs["cache_tokens"]);
  const costUsd =
    asFiniteNumber(attrs["gen_ai.usage.cost"]) ?? asFiniteNumber(attrs["cost_usd"]);
  const durationMs =
    asSafeInt(attrs["duration_ms"]) ??
    asSafeInt(attrs["durationMs"]) ??
    spanDurationMs(span.startTimeUnixNano, span.endTimeUnixNano);
  const toolNames = cleanToolNames(
    attrs["gen_ai.tool.names"] ?? attrs["tool.names"] ?? attrs["gen_ai.tool.name"] ?? attrs["tool.name"]
  );
  const statusCode = asNonEmptyString((span.status as Record<string, unknown> | undefined)?.code) ??
    (typeof span.status?.code === "number" ? String(span.status.code) : undefined);
  const statusMessage = asNonEmptyString(
    (span.status as Record<string, unknown> | undefined)?.message
  );
  const errorAttr = asNonEmptyString(attrs["error"]) ?? asNonEmptyString(attrs["exception.message"]);
  const isErrorStatus = statusCode === "2" || statusCode?.toLowerCase() === "error";
  const error = truncate(statusMessage ?? (isErrorStatus ? "span_error" : undefined) ?? errorAttr, ERROR_MAX_CHARS);

  const endMs = asFiniteNumber(span.endTimeUnixNano);
  const startMs = asFiniteNumber(span.startTimeUnixNano);
  const occurredAt =
    (typeof span.endTimeUnixNano === "string" || typeof span.endTimeUnixNano === "number"
      ? nanosToDate(span.endTimeUnixNano as string & number)
      : undefined) ??
    new Date(
      endMs != null && endMs > 0
        ? Math.round(endMs / 1_000_000)
        : startMs != null && startMs > 0
          ? Math.round(startMs / 1_000_000)
          : Date.now()
    );

  const turn: AgentTurnInput = {
    platform,
    seat: asNonEmptyString(attrs["seat"]) ?? platform,
    repo: asNonEmptyString(attrs["repo"]) ?? asNonEmptyString(attrs["project.name"]) ?? asNonEmptyString(attrs["project"]),
    conversationId:
      asNonEmptyString(attrs["gen_ai.conversation.id"]) ?? asNonEmptyString(attrs["session.id"]),
    generationId:
      asNonEmptyString(attrs["gen_ai.generation.id"]) ??
      asNonEmptyString(attrs["gen_ai.response.id"]) ??
      asNonEmptyString(attrs["generation.id"]),
    model: asNonEmptyString(attrs["gen_ai.request.model"]) ?? asNonEmptyString(attrs["model"]),
    inputTokens,
    outputTokens,
    cacheTokens,
    costUsd: costUsd != null && costUsd >= 0 ? costUsd : undefined,
    durationMs,
    toolCount: toolNames ? toolNames.length : asSafeInt(attrs["tool.count"]) ?? undefined,
    toolNames,
    error,
    promptText: truncate(asNonEmptyString(attrs["gen_ai.input.messages"]) ?? asNonEmptyString(attrs["prompt"]), PROMPT_RESPONSE_MAX_CHARS),
    responseText: truncate(asNonEmptyString(attrs["gen_ai.output.messages"]) ?? asNonEmptyString(attrs["response"]), PROMPT_RESPONSE_MAX_CHARS),
    occurredAt,
    contentExpiresAt: contentExpiry(occurredAt),
  };
  if (turn.toolCount == null) turn.toolCount = 0;
  return turn;
}

/** Map a parsed OTLP-JSON `{ resourceSpans: [...] }` body to turn inputs. */
export function mapOtlpTracesRequest(body: unknown): MapTracesResult {
  const turns: AgentTurnInput[] = [];
  const aiRequests: AiRequestInput[] = [];
  let ignored = 0;
  const resourceSpans = (body as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return { turns, aiRequests, ignored };
  for (const resource of resourceSpans) {
    const r = resource as {
      resource?: { attributes?: OtlpSpan["attributes"] };
      scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
    };
    const resourceAttrs = flattenSpanAttributes(r?.resource?.attributes);
    const gatewayPlatform =
      asNonEmptyString(resourceAttrs[OPENROUTER_TRACE_MARKER]) ||
      (r?.scopeSpans ?? []).some((scope) =>
        ((scope as { spans?: OtlpSpan[] })?.spans ?? []).some((span) =>
          Boolean(asNonEmptyString(flattenSpanAttributes(span?.attributes)[OPENROUTER_TRACE_MARKER]))
        )
      )
        ? "openrouter"
        : undefined;
    for (const scope of r?.scopeSpans ?? []) {
      for (const span of (scope as { spans?: OtlpSpan[] })?.spans ?? []) {
        if (!span || typeof span !== "object") {
          ignored += 1;
          continue;
        }
        const merged = { ...resourceAttrs, ...flattenSpanAttributes(span.attributes) };
        const spanName = typeof span.name === "string" ? span.name : undefined;
        // Claude Code's traces beta: llm_request spans are model calls, not
        // turns, so they feed AiRequest (deduped against the api_request log
        // event on request_id).  Its tool/hook spans are not turns either;
        // only claude_code.interaction is.
        const aiRequest = aiRequestFromSpan(spanName, merged, span);
        if (aiRequest && aiRequests.length < MAX_TURNS_PER_REQUEST) aiRequests.push(aiRequest);
        if (spanName?.startsWith("claude_code.") && spanName !== "claude_code.interaction") {
          if (!aiRequest) ignored += 1;
          continue;
        }
        const turn = turnFromSpanAttrs(merged, span, spanName, gatewayPlatform);
        if (!turn) {
          ignored += 1;
          continue;
        }
        if (turns.length < MAX_TURNS_PER_REQUEST) turns.push(turn);
        else ignored += 1;
      }
    }
  }
  return { turns, aiRequests, ignored };
}

/** Map a direct relay payload `{ turns: [...] }` to validated turn inputs. */
export function mapDirectTurnsRequest(body: unknown): MapTracesResult {
  const turns: AgentTurnInput[] = [];
  const aiRequests: AiRequestInput[] = [];
  let ignored = 0;
  const rawTurns = (body as { turns?: unknown })?.turns;
  if (!Array.isArray(rawTurns)) return { turns, aiRequests, ignored };
  for (const raw of rawTurns.slice(0, MAX_TURNS_PER_REQUEST + 100)) {
    if (turns.length >= MAX_TURNS_PER_REQUEST) {
      ignored += 1;
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      ignored += 1;
      continue;
    }
    const t = raw as Record<string, unknown> & { attributes?: unknown };
    const attrs: FlatAttributes = {};
    if (t.attributes && typeof t.attributes === "object" && !Array.isArray(t.attributes)) {
      for (const [k, v] of Object.entries(t.attributes)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") attrs[k] = v;
      }
    }
    const span: OtlpSpan = {
      startTimeUnixNano: t.startTimeUnixNano,
      endTimeUnixNano: t.endTimeUnixNano,
      status: typeof t.status === "object" && t.status !== null ? (t.status as OtlpSpan["status"]) : undefined,
    };
    // Top-level turn fields win over attributes; fold them in as attrs.
    const folded: Record<string, string | number | boolean | undefined> = { ...attrs };
    for (const [k, v] of [
      ["agent.platform", t.platform],
      ["seat", t.seat],
      ["repo", t.repo],
      ["gen_ai.conversation.id", t.conversationId],
      ["gen_ai.generation.id", t.generationId],
      ["gen_ai.request.model", t.model],
      ["gen_ai.usage.input_tokens", t.inputTokens],
      ["gen_ai.usage.output_tokens", t.outputTokens],
      ["gen_ai.usage.cache_tokens", t.cacheTokens],
      ["gen_ai.usage.cost", t.costUsd],
      ["duration_ms", t.durationMs],
      ["error", t.error],
      ["gen_ai.input.messages", t.promptText],
      ["gen_ai.output.messages", t.responseText],
    ] as const) {
      if (v !== undefined && v !== null && (typeof v === "string" ? v.trim() : true)) {
        folded[k] = v as string | number | boolean;
      }
    }
    if (t.toolNames !== undefined) folded["gen_ai.tool.names"] = undefined;
    const merged = { ...folded };
    const toolNames = cleanToolNames(t.toolNames ?? t.toolName);
    if (toolNames) merged["gen_ai.tool.names"] = toolNames.join("\n");
    const turn = turnFromSpanAttrs(merged, span);
    if (!turn) {
      ignored += 1;
      continue;
    }
    if (toolNames) {
      turn.toolNames = toolNames;
      turn.toolCount = toolNames.length;
    }
    // Direct turns carry an explicit occurredAt when present.
    if (typeof t.occurredAt === "string" && Number.isFinite(Date.parse(t.occurredAt))) {
      turn.occurredAt = new Date(t.occurredAt);
      turn.contentExpiresAt = contentExpiry(turn.occurredAt);
    }
    turns.push(turn);
  }
  return { turns, aiRequests, ignored };
}

export const _internal = { turnFromSpanAttrs, truncate };
