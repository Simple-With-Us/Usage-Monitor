import { basename } from "node:path";

import { shaEventId, tokenEventsFromBreakdown } from "./session-token-collectors.mjs";

export const KIMI_PRODUCER_ID = "kimi-code";
export const ZCODE_PRODUCER_ID = "zcode";

const TERMINAL_ZCODE_STATUSES = new Set(["completed", "error", "cancelled"]);

function tokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function timestampIso(value) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  const milliseconds = parsed > 1e12 ? parsed : parsed * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function categoricalErrorType(value) {
  const candidate = nonEmptyString(value);
  return candidate && /^[a-z][a-z0-9_.-]{0,79}$/i.test(candidate) ? candidate : undefined;
}

function numericMetadata(key, value) {
  if (value === null || value === undefined || value === "") return {};
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? { [key]: number } : {};
}

/** Kimi's `usage.record` turn rows are request deltas.  Session-scope rows are
 * cumulative and must not be emitted beside the turn rows. */
export function parseKimiUsageJsonl(
  text,
  { sessionKey = "kimi", sessionId, agentId, project, botFleetManaged = false } = {},
) {
  const events = [];
  for (const sourceLine of text.split("\n")) {
    const line = sourceLine.trim();
    if (!line.startsWith("{")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "usage.record" || row.usageScope !== "turn") continue;
    const model = nonEmptyString(row.model);
    const occurredAtIso = timestampIso(row.time);
    const usage = row.usage;
    if (!model || !occurredAtIso || !usage || typeof usage !== "object") continue;
    const recordId = shaEventId(["kimi-wire-record", line]);
    const breakdown = {
      input: tokenCount(usage.inputOther),
      output: tokenCount(usage.output),
      cacheRead: tokenCount(usage.inputCacheRead),
      cacheCreation: tokenCount(usage.inputCacheCreation),
    };
    const tokenBreakdownComplete = Object.hasOwn(usage, "inputCacheRead") && Object.hasOwn(usage, "inputCacheCreation");
    if (!Object.values(breakdown).some(Boolean)) continue;
    const resolvedAgentId = nonEmptyString(row.agentId) ?? nonEmptyString(agentId);
    const parsed = tokenEventsFromBreakdown({
      producerId: KIMI_PRODUCER_ID,
      provider: "moonshot",
      service: "kimi-code",
      sessionKey,
      occurredAtIso,
      model,
      breakdown,
      extraId: recordId,
      collectorCallId: recordId,
      extraMetadata: {
        harness: "kimi-code",
        usageScope: "turn",
        tokenBreakdownComplete,
        ...(nonEmptyString(sessionId) ? { "session.id": sessionId.trim() } : {}),
        ...(resolvedAgentId ? { "agent.id": resolvedAgentId } : {}),
        ...(botFleetManaged ? { "agent.launcher": "botfleet" } : {}),
      },
    });
    for (const event of parsed) {
      event.confidence = "actual";
      if (nonEmptyString(project)) event.project = project.trim();
    }
    events.push(...parsed);
  }
  return events;
}

/** Session-index rows map opaque storage keys back to the working directory. */
export function parseKimiSessionIndexJsonl(text) {
  const workDirBySession = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const row = JSON.parse(trimmed);
      const sessionId = nonEmptyString(row?.sessionId);
      const workDir = nonEmptyString(row?.workDir);
      if (sessionId && workDir) workDirBySession.set(sessionId, workDir);
    } catch {
      // A partial trailing index row does not invalidate earlier complete rows.
    }
  }
  return workDirBySession;
}

export function projectNameFromDirectory(directory) {
  const value = nonEmptyString(directory);
  if (!value) return undefined;
  const name = basename(value.replaceAll("\\", "/"));
  return name && name !== "." && name !== "/" ? name : undefined;
}

export function zcodeProviderName(providerId) {
  const raw = nonEmptyString(providerId)?.toLowerCase() ?? "";
  if (
    raw === "z.ai" ||
    raw === "zai" ||
    raw === "zcode" ||
    raw === "zhipu" ||
    raw === "zhipuai" ||
    raw.includes("bigmodel") ||
    /(^|[-_.])glm([-_.]|$)/.test(raw)
  ) {
    return "zcode";
  }
  if (raw === "google") return "google-antigravity";
  if (raw === "kimi" || raw === "kimi-code" || raw === "moonshotai") return "moonshot";
  return raw || "zcode";
}

/** ZCode input is inclusive of cache reads and cache creation.  If a provider
 * reports an inconsistent breakdown, retain its total input and omit the
 * untrustworthy split instead of either dropping or double-counting tokens. */
export function zcodeTokenBreakdown(row) {
  const inputTotal = tokenCount(row?.input_tokens);
  const cacheRead = tokenCount(row?.cache_read_input_tokens);
  const cacheCreation = tokenCount(row?.cache_creation_input_tokens);
  const cacheTotal = cacheRead + cacheCreation;
  const cacheBreakdownValid = inputTotal === 0 || cacheTotal <= inputTotal;
  return {
    breakdown: {
      input: cacheBreakdownValid ? Math.max(0, inputTotal - cacheTotal) : inputTotal,
      output: tokenCount(row?.output_tokens),
      cacheRead: cacheBreakdownValid ? cacheRead : 0,
      cacheCreation: cacheBreakdownValid ? cacheCreation : 0,
    },
    cacheBreakdownValid,
  };
}

export function parseZcodeModelUsageRows(rows) {
  const events = [];
  for (const row of rows) {
    const id = nonEmptyString(row?.id);
    const sessionId = nonEmptyString(row?.session_id);
    const model = nonEmptyString(row?.model_id);
    const status = nonEmptyString(row?.status);
    if (!id || !sessionId || !model || !status || !TERMINAL_ZCODE_STATUSES.has(status)) continue;
    const occurredAtIso = timestampIso(row.completed_at) ?? timestampIso(row.started_at);
    if (!occurredAtIso) continue;
    const { breakdown, cacheBreakdownValid } = zcodeTokenBreakdown(row);
    if (!Object.values(breakdown).some(Boolean)) continue;
    const providerId = nonEmptyString(row.provider_id);
    const reasoningTokens = tokenCount(row.reasoning_tokens);
    const project = projectNameFromDirectory(row.directory);
    const parsed = tokenEventsFromBreakdown({
      producerId: ZCODE_PRODUCER_ID,
      provider: zcodeProviderName(providerId),
      service: "zcode-cli",
      sessionKey: sessionId,
      occurredAtIso,
      model,
      breakdown,
      extraId: id,
      collectorCallId: id,
      extraMetadata: {
        harness: "zcode",
        "session.id": sessionId,
        status,
        ...(providerId ? { providerId } : {}),
        ...(nonEmptyString(row.project_id) ? { sourceProjectId: row.project_id.trim() } : {}),
        ...(nonEmptyString(row.query_source) ? { querySource: row.query_source.trim() } : {}),
        ...numericMetadata("attemptIndex", row.attempt_index),
        ...(nonEmptyString(row.task_type) ? { taskType: row.task_type.trim() } : {}),
        ...(nonEmptyString(row.agent) ? { agent: row.agent.trim() } : {}),
        ...(nonEmptyString(row.mode) ? { mode: row.mode.trim() } : {}),
        ...(nonEmptyString(row.variant) ? { variant: row.variant.trim() } : {}),
        ...(categoricalErrorType(row.error_type) ? { errorType: categoricalErrorType(row.error_type) } : {}),
        ...numericMetadata("durationMs", row.duration_ms),
        ...numericMetadata("timeToFirstTokenMs", row.time_to_first_token_ms),
        ...numericMetadata("toolCallCount", row.tool_call_count),
        ...numericMetadata("retryCount", row.retry_count),
        ...(row.retryable === 1 || row.retryable === true ? { retryable: true } : {}),
        ...(row.cancelled_by_user === 1 || row.cancelled_by_user === true
          ? { cancelledByUser: true }
          : {}),
        ...(row.context_exceeded === 1 || row.context_exceeded === true
          ? { contextExceeded: true }
          : {}),
        ...numericMetadata("providerTotalTokens", row.provider_total_tokens),
        ...numericMetadata("computedTotalTokens", row.computed_total_tokens),
        ...(!cacheBreakdownValid ? { cacheBreakdownValid: false } : {}),
      },
    });
    for (const event of parsed) {
      event.confidence = "actual";
      if (project) event.project = project;
      if (event.metadata?.tokenType === "output" && reasoningTokens > 0) {
        event.metadata.reasoningTokens = reasoningTokens;
      }
    }
    events.push(...parsed);
  }
  return events;
}
