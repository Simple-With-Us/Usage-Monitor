#!/usr/bin/env node
// Parsers for local coding-agent session logs → Usage Monitor ingest events.
//
// Codex: ~/.codex/sessions/**/*.jsonl event_msg/token_count last_token_usage
//   (ccusage Codex data source).  Skip token_count rows whose
//   total_token_usage did not advance — Codex re-emits the previous
//   last_token_usage on rate-limit-only updates (openai/codex#14489,
//   ccusage#876).  Line-numbered eventIds would persist each replay.
// Grok Build: ~/.grok/sessions/**/updates.jsonl sessionUpdate=turn_completed
//   + usage.modelUsage (ccusage Grok data source).
// Copilot CLI: ~/.copilot/session-state/*/events.jsonl session.shutdown
//   data.modelMetrics[model].usage (ccusage Copilot data source).  Totals are
//   cumulative across resume/shutdown; emit the delta since the previous
//   metrics snapshot so re-ingest cannot double-count.  inputTokens is
//   inclusive of cacheReadTokens AND cacheWriteTokens (tokenuse; ccusage#1174
//   23399 ≈ 10069+13324).  Codex-style splitInclusiveCache only subtracts
//   cacheRead, which would price cache writes as full input.
//
// Tokens are posted as billingMode=estimated. Grok costUsdTicks (1e-10 USD)
// are posted as estimated cost events. Neither is cash.

import { createHash } from "node:crypto";
import { hostname } from "node:os";

export const GROK_COST_USD_TICKS = 1e10;
export const MAX_EVENTS_PER_BATCH = 100;

export const CODEX_PRODUCER_ID = "openai-codex";
export const GROK_PRODUCER_ID = "grok-build";
export const COPILOT_PRODUCER_ID = "github-copilot";
export const ANTIGRAVITY_PRODUCER_ID = "antigravity-cli";
export const ANTIGRAVITY_STATUSLINE_PRODUCER_ID = "antigravity-statusline";
export const CLAUDE_PRODUCER_ID = "claude-code";
export const DEEPSEEK_PRODUCER_ID = "deepseek-dsh";
export const CURSOR_PRODUCER_ID = "cursor-agent";
export const MUSE_PRODUCER_ID = "muse";
export const OPENCODE_PRODUCER_ID = "opencode";
export const FX_PRODUCER_ID = "fx";

/** DSH events at or before this instant keep the pre-v3 event shape (provider
 *  "deepseek", bare metadata, confidence "estimated", file-based session key) so replaying archives
 *  that were already ingested in September dedupes instead of returning
 *  HTTP 409 idempotency_conflict.  Production rows stop at 1788920242939. */
export const DSH_LEGACY_EVENT_CUTOFF_MS = 1788920300000;
/** Those production rows were posted while the Mac's hostname was
 *  "jays.services"; the instance id is part of the stored metadata, so a
 *  replay must send the same value. */
export const DSH_LEGACY_PRODUCER_INSTANCE_ID = "jays.services";

const TOKEN_TYPES = ["input", "output", "cacheRead", "cacheCreation"];

export function splitInclusiveCache({
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
}) {
  const inTok = finiteCount(input);
  const cached = finiteCount(cacheRead);
  const uncached = cached > inTok ? inTok : Math.max(0, inTok - cached);
  return {
    input: uncached,
    output: finiteCount(output),
    cacheRead: cached > inTok ? 0 : cached,
    cacheCreation: finiteCount(cacheCreation),
  };
}

function finiteCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const CODEX_TOTAL_KEYS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
];

function codexTotalSignature(usage) {
  if (!usage || typeof usage !== "object") return null;
  return CODEX_TOTAL_KEYS.map((key) => String(finiteCount(usage[key]))).join("|");
}

function shaEventId(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isoTimestamp(value, fallbackIso) {
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallbackIso;
}

export function tokenEventsFromBreakdown({
  producerId,
  provider,
  service,
  sessionKey,
  occurredAtIso,
  model,
  breakdown,
  extraId,
  extraMetadata,
}) {
  const events = [];
  for (const tokenType of TOKEN_TYPES) {
    const quantity = breakdown[tokenType];
    if (!quantity) continue;
    events.push({
      eventId: shaEventId([
        producerId,
        sessionKey,
        extraId ?? occurredAtIso,
        model ?? "",
        tokenType,
        String(quantity),
      ]),
      provider,
      service,
      producerKeyRef: model || undefined,
      label: `token:${tokenType}`,
      metricType: "usage",
      unit: "token",
      quantity,
      billingMode: "estimated",
      confidence: "estimated",
      occurredAt: occurredAtIso,
      metadata: {
        tokenType,
        ...(model ? { model } : {}),
        ...(extraMetadata ?? {}),
      },
    });
  }
  return events;
}

export function estimatedCostEvent({
  producerId,
  provider,
  service,
  sessionKey,
  occurredAtIso,
  model,
  costUsd,
  extraId,
}) {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return {
    eventId: shaEventId([
      producerId,
      sessionKey,
      extraId ?? occurredAtIso,
      model ?? "",
      "cost",
      costUsd.toFixed(10),
    ]),
    provider,
    service,
    producerKeyRef: model || undefined,
    label: "api-equivalent",
    metricType: "cost",
    unit: "usd",
    costUsd,
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: occurredAtIso,
    metadata: {
      ...(model ? { model } : {}),
    },
  };
}

export function parseCodexJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  let lastModel = null;
  let lastTotalSignature = null;
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : {};
    const payloadModel =
      typeof payload.model === "string"
        ? payload.model
        : typeof payload.model_provider === "string" && typeof payload.model === "string"
          ? payload.model
          : null;
    if (obj.type === "turn_context" || obj.type === "session_meta") {
      const model =
        (typeof payload.model === "string" && payload.model.trim()) ||
        (typeof obj.model === "string" && obj.model.trim()) ||
        null;
      if (model) lastModel = model;
    }
    if (typeof payloadModel === "string" && payloadModel.trim()) {
      lastModel = payloadModel.trim();
    }
    if (obj.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info && typeof payload.info === "object" ? payload.info : {};
    const last = info.last_token_usage;
    if (!last || typeof last !== "object") continue;
    const totalSignature = codexTotalSignature(info.total_token_usage);
    if (totalSignature && totalSignature === lastTotalSignature) continue;
    if (totalSignature) lastTotalSignature = totalSignature;
    const model =
      (typeof info.model === "string" && info.model.trim()) || lastModel;
    const occurredAtIso = isoTimestamp(obj.timestamp ?? payload.timestamp, fallbackIso);
    const breakdown = splitInclusiveCache({
      input: last.input_tokens,
      output: last.output_tokens,
      cacheRead: last.cached_input_tokens,
      cacheCreation: last.cache_write_input_tokens,
    });
    events.push(
      ...tokenEventsFromBreakdown({
        producerId: CODEX_PRODUCER_ID,
        provider: "openai",
        service: "codex-cli",
        sessionKey: sessionKey ?? "codex",
        occurredAtIso,
        model,
        breakdown,
        extraId: `L${lineNo}`,
      })
    );
  }
  return events;
}

function grokUsageFromUpdate(update) {
  if (!update || typeof update !== "object") return [];
  const usage = update.usage;
  if (!usage || typeof usage !== "object") return [];
  const modelUsage = usage.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    return Object.entries(modelUsage).map(([model, row]) => ({
      model,
      usage: row && typeof row === "object" ? row : {},
    }));
  }
  return [{ model: null, usage }];
}

export function parseGrokUpdatesJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const method = obj.method;
    if (method !== "session/update" && method !== "_x.ai/session/update") continue;
    const params = obj.params && typeof obj.params === "object" ? obj.params : {};
    const update = params.update && typeof params.update === "object" ? params.update : {};
    if (update.sessionUpdate !== "turn_completed") continue;
    const occurredAtIso = isoTimestamp(obj.timestamp, fallbackIso);
    const rows = grokUsageFromUpdate(update);
    for (const { model, usage } of rows) {
      const breakdown = splitInclusiveCache({
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cachedReadTokens,
        cacheCreation: usage.cacheCreationTokens,
      });
      events.push(
        ...tokenEventsFromBreakdown({
          producerId: GROK_PRODUCER_ID,
          provider: "xai",
          service: "grok-cli",
          sessionKey: sessionKey ?? "grok",
          occurredAtIso,
          model,
          breakdown,
          extraId: `L${lineNo}:${model ?? "_"}`,
        })
      );
      const ticks = Number(usage.costUsdTicks);
      const costUsd =
        Number.isFinite(ticks) && ticks > 0 ? ticks / GROK_COST_USD_TICKS : 0;
      const costEvent = estimatedCostEvent({
        producerId: GROK_PRODUCER_ID,
        provider: "xai",
        service: "grok-cli",
        sessionKey: sessionKey ?? "grok",
        occurredAtIso,
        model,
        costUsd,
        extraId: `L${lineNo}:${model ?? "_"}:cost`,
      });
      if (costEvent) events.push(costEvent);
    }
  }
  return events;
}

function copilotUsageFromMetricsRow(row) {
  if (!row || typeof row !== "object") return null;
  const usage =
    row.usage && typeof row.usage === "object" ? row.usage : row;
  if (!usage || typeof usage !== "object") return null;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheCreation: usage.cacheWriteTokens,
  };
}

/** Copilot inputTokens includes cache reads and cache writes.  Peel writes
 *  first so splitInclusiveCache's Codex-style read subtract sees the rest. */
function splitCopilotInclusiveCache(raw) {
  return splitInclusiveCache({
    ...raw,
    input: finiteCount(raw.input) - finiteCount(raw.cacheCreation),
  });
}

function tokenBreakdownDelta(current, previous) {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheCreation: Math.max(0, current.cacheCreation - previous.cacheCreation),
  };
}

function breakdownHasTokens(breakdown) {
  return Boolean(
    breakdown.input || breakdown.output || breakdown.cacheRead || breakdown.cacheCreation
  );
}


export function parseClaudeSessionJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage || obj?.usage;
    if (!usage || typeof usage !== "object") continue;
    const rawModel = (typeof obj.message?.model === "string" && obj.message.model.trim()) || "claude-3-7-sonnet";
    const model = rawModel;
    const occurredAtIso = isoTimestamp(obj.timestamp, fallbackIso);
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens || 0;
    const speed = usage.speed || obj.speed || "standard";
    const effort = obj.effort || "standard";

    const breakdown = splitInclusiveCache({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheCreation: usage.cache_creation_input_tokens,
    });

    events.push(
      ...tokenEventsFromBreakdown({
        producerId: CLAUDE_PRODUCER_ID,
        provider: "anthropic",
        service: "claude-code",
        sessionKey: sessionKey ?? "claude",
        occurredAtIso,
        model,
        breakdown,
        extraId: `L${lineNo}:${model}`,
      })
    );
  }
  return events;
}

export function parseAntigravityStatuslineJsonl(text, { fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "antigravity.statusline.usage") continue;
    const sessionHash = typeof row.sessionHash === "string" ? row.sessionHash : "";
    const signature = typeof row.signature === "string" ? row.signature : "";
    const model = typeof row.model === "string" ? row.model.trim() : "";
    if (!sessionHash || !signature || !model || !row.usage || typeof row.usage !== "object") continue;
    const breakdown = {
      input: finiteCount(row.usage.input),
      output: finiteCount(row.usage.output),
      cacheRead: finiteCount(row.usage.cacheRead),
      cacheCreation: finiteCount(row.usage.cacheCreation),
    };
    const breakdownComplete = row.breakdownComplete === true;
    const parsed = tokenEventsFromBreakdown({
      producerId: ANTIGRAVITY_STATUSLINE_PRODUCER_ID,
      provider: "google-antigravity",
      service: "antigravity-cli",
      sessionKey: sessionHash,
      occurredAtIso: isoTimestamp(row.occurredAt, fallbackIso),
      model: breakdownComplete ? model : "unknown-antigravity-model",
      breakdown,
      extraId: signature,
    });
    for (const event of parsed) {
      event.confidence = "actual";
      if (!breakdownComplete) {
        event.metadata.observedCurrentModel = model;
        event.metadata.modelAttributionComplete = false;
        if (event.metadata?.tokenType === "input") {
          event.label = "token:inputUnsplit";
          delete event.metadata.tokenType;
          event.metadata.tokenBreakdownComplete = false;
        }
      }
    }
    events.push(...parsed);
  }
  return events;
}

/** DSH and Clutch run several upstream providers.  Map the harness's
 *  `source.provider` to the UM provider string and a billing mode. */
export function dshProviderInfo(rawProvider) {
  const id = typeof rawProvider === "string" ? rawProvider.trim().toLowerCase() : "";
  if (!id || id.startsWith("deepseek")) {
    return { provider: "deepseek", billingMode: "payg", legacyEligible: true };
  }
  if (id.startsWith("minimax")) {
    return { provider: "minimax", billingMode: "subscription", legacyEligible: false };
  }
  if (id === "meta" || id.startsWith("muse")) {
    return { provider: "muse-code", billingMode: "subscription", legacyEligible: false };
  }
  return { provider: id, billingMode: "payg", legacyEligible: false };
}

function dshStepDurationMs(messageTimeMs, stepStartMs, stream) {
  const MAX_MS = 6 * 60 * 60 * 1000;
  if (Number.isFinite(stepStartMs)) {
    const d = messageTimeMs - stepStartMs;
    if (d >= 0 && d <= MAX_MS) return d;
  }
  if (Array.isArray(stream)) {
    let first = Infinity;
    for (const entry of stream) {
      const t = Number(entry?.time ?? entry?.time0);
      if (Number.isFinite(t) && t < first) first = t;
    }
    const d = messageTimeMs - first;
    if (Number.isFinite(d) && d >= 0 && d <= MAX_MS) return d;
  }
  return null;
}

/**
 * Parse one DSH / Clutch session archive.
 *
 * Options:
 *   sessionKey            event-id namespace for this archive.  Callers pass the
 *                         session DIRECTORY key so session.jsonl and
 *                         session.v3.jsonl twins of one session share ids.
 *   legacySessionKey      the pre-v3 file-based key.  When set, DeepSeek
 *                         messages at or before DSH_LEGACY_EVENT_CUTOFF_MS keep
 *                         the exact pre-v3 event shape under this key.
 *   seenMessageIds        optional Set shared across archives; a message id
 *                         already seen is skipped (v1/v3 twins hold copies).
 *   harness               "dsh" or "clutch" (diagnostic metadata).
 */
export function parseDeepSeekSessionJsonl(
  text,
  { sessionKey, fallbackOccurredAt, legacySessionKey, seenMessageIds, harness } = {},
) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  const lines = text.split("\n");
  const stepStarts = new Map();
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "step/start" && obj.data) {
      stepStarts.set(`${obj.data.turn}:${obj.data.step}`, Number(obj.time));
      continue;
    }
    const dshData = obj?.data && typeof obj.data === "object" ? obj.data : null;
    const isDshAssistantMessage = obj?.type === "assistant/message" && dshData;
    const usage = isDshAssistantMessage
      ? dshData.usage
      : obj?.usage || obj?.metrics?.usage;
    if (!usage || typeof usage !== "object") continue;
    const source = isDshAssistantMessage && dshData.message?.source && typeof dshData.message.source === "object"
      ? dshData.message.source
      : {};
    const messageId =
      isDshAssistantMessage && typeof dshData.message?.id === "string" && dshData.message.id
        ? dshData.message.id
        : null;
    if (messageId && seenMessageIds) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    const model =
      (typeof source.model === "string" && source.model.trim()) ||
      (typeof obj.model === "string" && obj.model.trim()) ||
      "deepseek-chat";
    const occurredAtIso = isoTimestamp(
      isDshAssistantMessage ? obj.time : obj.timestamp || obj.created_at,
      fallbackIso,
    );
    const breakdown = isDshAssistantMessage
      ? {
          // DSH exposes cache reads separately; inputTokens is already the
          // uncached input count and can be lower than cacheReadTokens.
          input: finiteCount(usage.inputTokens),
          output: finiteCount(usage.outputTokens),
          cacheRead: finiteCount(usage.cacheReadTokens),
          cacheCreation: finiteCount(usage.cacheCreationTokens || usage.cacheWriteTokens),
        }
      : splitInclusiveCache({
          input: usage.prompt_tokens || usage.input_tokens || 0,
          output: usage.completion_tokens || usage.output_tokens || 0,
          cacheRead: usage.prompt_cache_hit_tokens || usage.cache_read_input_tokens || 0,
          cacheCreation: usage.prompt_cache_miss_tokens || 0,
        });
    const info = dshProviderInfo(isDshAssistantMessage ? source.provider : "deepseek");
    const messageTimeMs = Date.parse(occurredAtIso);
    const legacy =
      Boolean(legacySessionKey) &&
      info.legacyEligible &&
      Number.isFinite(messageTimeMs) &&
      messageTimeMs <= DSH_LEGACY_EVENT_CUTOFF_MS;
    const extraId = messageId || `L${lineNo}:${model}`;
    let extraMetadata;
    if (!legacy && isDshAssistantMessage) {
      const durationMs = dshStepDurationMs(
        Number(obj.time),
        stepStarts.get(`${dshData.turn}:${dshData.step}`),
        dshData.stream,
      );
      extraMetadata = {
        harness: harness || "dsh",
        billingMode: info.billingMode,
        ...(typeof source.provider === "string" && source.provider
          ? { providerId: source.provider.slice(0, 80) }
          : {}),
        ...(durationMs !== null ? { durationMs } : {}),
      };
    }
    const parsed = tokenEventsFromBreakdown({
        producerId: DEEPSEEK_PRODUCER_ID,
        provider: legacy ? "deepseek" : info.provider,
        service: "deepseek-harness",
        sessionKey: (legacy ? legacySessionKey : sessionKey) ?? "deepseek",
        occurredAtIso,
        model,
        breakdown,
        extraId,
        extraMetadata,
      });
    // DeepSeek outputTokens already includes reasoning tokens.  Keep the
    // separate count as diagnostic metadata without double-counting it.
    const reasoningTokens = finiteCount(usage.reasoningTokens);
    for (const event of parsed) {
      // The September rows were stored with confidence "estimated"; a replay
      // that says "actual" is a content difference and returns HTTP 409.
      if (!legacy) event.confidence = "actual";
      if (reasoningTokens > 0) {
        if (event.metadata?.tokenType === "output") {
          event.metadata.reasoningTokens = reasoningTokens;
        }
      }
    }
    events.push(...parsed);
  }
  return events;
}

export function parseCursorSessionJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj?.usage || obj?.tokenCount;
    if (!usage) continue;
    const model = (typeof obj.model === "string" && obj.model.trim()) || "cursor-default";
    const occurredAtIso = isoTimestamp(obj.timestamp, fallbackIso);
    const breakdown = splitInclusiveCache({
      input: typeof usage === "number" ? usage : usage.inputTokens || 0,
      output: typeof usage === "object" ? usage.outputTokens || 0 : 0,
      cacheRead: typeof usage === "object" ? usage.cachedTokens || 0 : 0,
      cacheCreation: 0,
    });
    events.push(
      ...tokenEventsFromBreakdown({
        producerId: CURSOR_PRODUCER_ID,
        provider: "cursor",
        service: "cursor-cloud",
        sessionKey: sessionKey ?? "cursor",
        occurredAtIso,
        model,
        breakdown,
        extraId: `L${lineNo}:${model}`,
      })
    );
  }
  return events;
}

export function parseCopilotEventsJsonl(text, { sessionKey, fallbackOccurredAt } = {}) {
  const fallbackIso = fallbackOccurredAt ?? new Date(0).toISOString();
  const lastByModel = new Map();
  const events = [];
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "session.shutdown") continue;
    const data = obj.data && typeof obj.data === "object" ? obj.data : {};
    const metrics = data.modelMetrics;
    if (!metrics || typeof metrics !== "object") continue;
    const occurredAtIso = isoTimestamp(obj.timestamp, fallbackIso);
    const shutdownId =
      (typeof obj.id === "string" && obj.id.trim()) || `L${lineNo}`;
    for (const [modelName, row] of Object.entries(metrics)) {
      const model = typeof modelName === "string" ? modelName.trim() : "";
      if (!model) continue;
      const raw = copilotUsageFromMetricsRow(row);
      if (!raw) continue;
      const current = splitCopilotInclusiveCache(raw);
      const previous = lastByModel.get(model) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      };
      const breakdown = tokenBreakdownDelta(current, previous);
      lastByModel.set(model, current);
      if (!breakdownHasTokens(breakdown)) continue;
      events.push(
        ...tokenEventsFromBreakdown({
          producerId: COPILOT_PRODUCER_ID,
          provider: "github-copilot",
          service: "copilot-cli",
          sessionKey: sessionKey ?? "copilot",
          occurredAtIso,
          model,
          breakdown,
          extraId: `${shutdownId}:${model}`,
        })
      );
    }
  }
  return events;
}

/** opencode providerID -> UM provider string and billing mode. */
export function opencodeProviderInfo(providerId, modelId) {
  const id = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (id.startsWith("minimax")) return { provider: "minimax", billingMode: "subscription" };
  if (id === "meta" || id.startsWith("muse")) return { provider: "muse-code", billingMode: "subscription" };
  if (id === "opencode") {
    return { provider: "opencode", billingMode: "free" };
  }
  if (id === "deepseek") return { provider: "deepseek", billingMode: "payg" };
  if (id === "anthropic" || id === "openai" || id === "google" || id === "xai") {
    return { provider: id === "google" ? "google-ai" : id, billingMode: "payg" };
  }
  return { provider: id || "opencode", billingMode: "payg" };
}

/**
 * Parse opencode `session_message` rows (assistant messages only).
 * Row shape: { id, session_id, data } where data is the JSON string (or object)
 * holding time.{created,streamed,completed}, model.{id,providerID,variant},
 * cost, tokens.{input,output,reasoning,cache.{read,write}}.
 *
 * opencode's tokens.output EXCLUDES reasoning (143 rows have reasoning greater
 * than output) and tokens.input is uncached, so reasoning is billed at the
 * output rate: fold it into the output row (UM prices only input, output,
 * cacheRead and cacheCreation) and keep the split in metadata.
 * Rows without time.completed are still streaming and are skipped, because a
 * changing quantity under one event id would return HTTP 409.
 */
export function parseOpencodeMessageRows(rows) {
  const events = [];
  for (const row of rows) {
    let data = row?.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    if (!data || typeof data !== "object") continue;
    const tokens = data.tokens;
    const time = data.time;
    if (!tokens || typeof tokens !== "object" || !time || !Number.isFinite(Number(time.completed))) continue;
    const messageId = typeof row.id === "string" && row.id ? row.id : null;
    const sessionId = typeof row.session_id === "string" && row.session_id ? row.session_id : null;
    if (!messageId || !sessionId) continue;
    const model = typeof data.model?.id === "string" ? data.model.id.trim() : "";
    const providerId = typeof data.model?.providerID === "string" ? data.model.providerID : "";
    const info = opencodeProviderInfo(providerId, model);
    const output = finiteCount(tokens.output);
    const reasoning = finiteCount(tokens.reasoning);
    const breakdown = {
      input: finiteCount(tokens.input),
      output: output + reasoning,
      cacheRead: finiteCount(tokens.cache?.read),
      cacheCreation: finiteCount(tokens.cache?.write),
    };
    const created = Number(time.created);
    const completed = Number(time.completed);
    const durationMs =
      Number.isFinite(created) && completed >= created && completed - created <= 6 * 3600 * 1000
        ? completed - created
        : null;
    const cost = Number(data.cost);
    const events_ = tokenEventsFromBreakdown({
      producerId: OPENCODE_PRODUCER_ID,
      provider: info.provider,
      service: "opencode",
      sessionKey: sessionId,
      occurredAtIso: new Date(completed).toISOString(),
      model: model || undefined,
      breakdown,
      extraId: messageId,
      extraMetadata: {
        harness: "opencode",
        billingMode: info.billingMode,
        ...(providerId ? { providerId: providerId.slice(0, 80) } : {}),
        ...(durationMs !== null ? { durationMs } : {}),
        ...(typeof data.agent === "string" && data.agent ? { agent: data.agent.slice(0, 80) } : {}),
        ...(typeof data.model?.variant === "string" && data.model.variant
          ? { variant: data.model.variant.slice(0, 80) }
          : {}),
        ...(typeof data.finish === "string" && data.finish ? { finish: data.finish.slice(0, 80) } : {}),
        ...(Number.isFinite(cost) && cost > 0 ? { reportedCostUsd: Number(cost.toFixed(9)) } : {}),
      },
    });
    for (const event of events_) {
      event.confidence = "actual";
      if (event.metadata?.tokenType === "output" && reasoning > 0) {
        event.metadata.reasoningTokens = reasoning;
        event.metadata.outputTokensExcludingReasoning = output;
      }
    }
    events.push(...events_);
  }
  return events;
}

/** fx model ids carry a vendor prefix ("grok/grok-4.6", "xai/grok-4.1-fast"). */
export function fxModelName(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * Parse ~/.fx/usage.jsonl.  Only `kind: "generation"` facts count; `pending`,
 * `incident` and `coverage` rows are bookkeeping.  Fact ids (gen_...) are
 * unique, so they are the stable event key.  xAI semantics: input_tokens is
 * inclusive of cache reads and output_tokens includes reasoning.
 */
export function parseFxUsageJsonl(text) {
  const events = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.kind !== "generation") continue;
    const fact = obj.fact;
    if (!fact || typeof fact !== "object" || typeof fact.id !== "string" || !fact.id) continue;
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    const occurredAtIso = isoTimestamp(Number(fact.created_at_ms), null);
    if (!occurredAtIso) continue;
    const model = fxModelName(fact.model);
    const breakdown = splitInclusiveCache({
      input: fact.input_tokens,
      output: fact.output_tokens,
      cacheRead: fact.cache_read_tokens,
      cacheCreation: fact.cache_write_tokens,
    });
    const reasoning = finiteCount(fact.reasoning_tokens);
    const searches = finiteCount(fact.billable_web_search_calls);
    const parsed = tokenEventsFromBreakdown({
      producerId: FX_PRODUCER_ID,
      provider: "xai",
      service: "fx",
      sessionKey: "fx",
      occurredAtIso,
      model: model || undefined,
      breakdown,
      extraId: fact.id,
      extraMetadata: {
        harness: "fx",
        billingMode: "payg",
        ...(typeof fact.model === "string" && fact.model !== model ? { rawModel: fact.model.slice(0, 120) } : {}),
        ...(searches > 0 ? { billableWebSearchCalls: searches } : {}),
      },
    });
    for (const event of parsed) {
      event.confidence = "actual";
      if (event.metadata?.tokenType === "output" && reasoning > 0) {
        event.metadata.reasoningTokens = reasoning;
      }
    }
    events.push(...parsed);
  }
  return events;
}

export function chunkEvents(events, size = MAX_EVENTS_PER_BATCH) {
  const chunks = [];
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size));
  }
  return chunks;
}

export function filterEventsSince(events, since) {
  if (!since) return events;
  const t = since.getTime();
  return events.filter((event) => {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at >= t;
  });
}

export async function postUsageBatches({
  events,
  ingestUrl,
  ingestToken,
  producerId,
  producerInstanceId,
  dryRun = false,
  log = console.log,
}) {
  const bodyFor = (batch) => ({
    schemaVersion: 2,
    producerId,
    producerInstanceId:
      producerInstanceId || process.env.USAGE_MACHINE_ID?.trim() || hostname(),
    events: batch,
  });
  if (dryRun) {
    log(`--dry-run; would send ${events.length} event(s) as ${chunkEvents(events).length} batch(es)`);
    return { received: 0, persisted: 0, rejected: 0, dryRun: true, events };
  }
  if (!ingestToken) {
    throw new Error("Missing ingest token");
  }
  let received = 0;
  let persisted = 0;
  let rejected = 0;
  let conflicted = 0;
  const batches = chunkEvents(events);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const parsed = await postBatchIsolatingConflicts({
      ingestUrl,
      ingestToken,
      bodyFor,
      events: batch,
      log,
    });
    received += parsed.received;
    persisted += parsed.persisted;
    rejected += parsed.rejected;
    conflicted += parsed.conflicted;
    // Authenticated ingest allows 10 req / 1s.  A 400-day backfill is 100+
    // batches; blasting them trips 429 and aborts the rest of history.
    if (i < batches.length - 1) {
      await sleep(120);
    }
  }
  if (conflicted > 0) {
    log(`WARNING: ${conflicted} event(s) skipped as idempotency conflicts (already stored with different content)`);
  }
  return { received, persisted, rejected, conflicted };
}

/**
 * The ingest endpoint answers 409 idempotency_conflict for the WHOLE batch when
 * any one event collides with a stored row that has different content (UM-1469:
 * a hostname rename did this to every replayed event, and the collector, which
 * only advances its checkpoint after a clean ack, re-sent the same poisoned
 * batch for a month).  A conflict means the row is already stored, so the right
 * response is to isolate the colliding event(s) by halving the batch, log each
 * key loudly, and let everything else land.
 */
async function postBatchIsolatingConflicts({ ingestUrl, ingestToken, bodyFor, events, log }) {
  try {
    const parsed = await postUsageBatchWithRetry({
      ingestUrl,
      ingestToken,
      body: bodyFor(events),
      log,
    });
    return {
      received: parsed.received,
      persisted: parsed.persisted,
      rejected: parsed.rejected,
      conflicted: 0,
    };
  } catch (error) {
    if (error?.code !== "idempotency_conflict") throw error;
    if (events.length === 1) {
      log(
        `skipping event ${events[0].eventId} (${events[0].label ?? events[0].metricType}): ${error.message}`
      );
      return { received: 1, persisted: 0, rejected: 0, conflicted: 1 };
    }
    const mid = Math.ceil(events.length / 2);
    const total = { received: 0, persisted: 0, rejected: 0, conflicted: 0 };
    for (const half of [events.slice(0, mid), events.slice(mid)]) {
      const part = await postBatchIsolatingConflicts({
        ingestUrl,
        ingestToken,
        bodyFor,
        events: half,
        log,
      });
      total.received += part.received;
      total.persisted += part.persisted;
      total.rejected += part.rejected;
      total.conflicted += part.conflicted;
      await sleep(120);
    }
    return total;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postUsageBatchWithRetry({ ingestUrl, ingestToken, body, log }) {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    let text;
    let parsed = null;
    try {
      response = await fetch(ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-usage-telemetry-version": "2",
          authorization: `Bearer ${ingestToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    } catch (networkError) {
      const waitMs = Math.min(60_000, Math.pow(2, attempt) * 1000);
      log(
        `ingest network error (${networkError instanceof Error ? networkError.name : "unknown"}) on attempt ${attempt}/${maxAttempts}; retry in ${waitMs}ms`
      );
      if (attempt === maxAttempts) {
        throw networkError;
      }
      await sleep(waitMs);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(parsed?.error?.retryAfterSeconds);
      const waitMs = Math.min(
        60_000,
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000
      );
      log(
        `ingest HTTP ${response.status} (attempt ${attempt}/${maxAttempts}); retry in ${waitMs}ms`
      );
      if (attempt === maxAttempts) {
        throw new Error(`Ingest rejected the batch (HTTP ${response.status}) after ${maxAttempts} attempts`);
      }
      await sleep(waitMs);
      continue;
    }
    if (!response.ok && response.status !== 202) {
      const detail = parsed?.error?.message ? `: ${String(parsed.error.message).slice(0, 300)}` : "";
      const failure = new Error(`Ingest rejected the batch (HTTP ${response.status})${detail}`);
      failure.status = response.status;
      failure.code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
      throw failure;
    }
    if (!isCompleteUsageIngestAck(parsed, body.events.length)) {
      const waitMs = Math.min(60_000, Math.pow(2, attempt) * 1000);
      log(`ingest returned an ambiguous acknowledgement on attempt ${attempt}/${maxAttempts}; retry in ${waitMs}ms`);
      if (attempt === maxAttempts) {
        throw new Error("Ingest returned an ambiguous acknowledgement after 8 attempts");
      }
      await sleep(waitMs);
      continue;
    }
    return parsed;
  }
  throw new Error("Ingest retry loop exhausted");
}

export function isCompleteUsageIngestAck(ack, expectedReceived) {
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return false;
  const counts = [ack.received, ack.persisted, ack.duplicates, ack.pruned, ack.rejected];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) return false;
  return ack.received === expectedReceived &&
    ack.persisted + ack.duplicates + ack.pruned + ack.rejected === ack.received;
}
