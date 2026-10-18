import {
  AGENT_SEAT_CATALOG,
  isAgentPlatformId,
  resolveAgentSeat,
  type AgentSeatSource,
  type AgentSeatSubscriptionInput,
} from "@/lib/agent-seat-plans";
import { getExternalEventRawCutoff, startOfUtcDay } from "@/lib/data-retention";
import { getLatestMacHealth } from "@/lib/mac-health";
import { prisma } from "@/lib/prisma";
import { isDeepSeekPaygModel, sumDeepSeekPaygEvents, type DeepSeekPaygEvent } from "@/lib/pricing/deepseek-payg";
import { CURSOR_ADMIN_SOURCE_APP } from "@/lib/cursor-admin-poller";
import { deriveTokenCostUsd, getModelPricing } from "@/lib/pricing/model-pricing";
import { SUBSCRIPTION_ANALYTICS_SOURCE_APPS } from "@/lib/subscription-analytics";
import {
  isReliableTokenTelemetryKind,
  resolveTelemetryAccuracy,
  telemetryIncompleteNoteFor,
  type TelemetryAccuracy,
  type TokenTelemetryKind,
} from "@/lib/agent-telemetry-accuracy";

export interface AgentPlatformMeta {
  id: string;
  name: string;
  provider: string;
  description: string;
  dataCapability: string;
  fidelityTier: "realtime_otlp" | "session_jsonl" | "process_only" | "unavailable";
  tokenTelemetryKind: TokenTelemetryKind;
  notes: string;
  defaultMonthlySeatCostUsd: number;
  listMonthlySeatCostUsd?: number;
  bundledOffsetUsd?: number;
  bundledOffsetLabel?: string;
  unavailableReason?: string;
}

export const AGENT_PLATFORMS: readonly AgentPlatformMeta[] = [
  {
    id: "claude-code",
    name: "Claude Code / Desktop",
    provider: "Anthropic",
    description: "Claude Code CLI, Claude Desktop, and Monet multi-agent sync.",
    dataCapability: "Full real-time OTLP telemetry (/api/otlp/v1/metrics)",
    fidelityTier: "realtime_otlp",
    tokenTelemetryKind: "otlp",
    notes: "Native OTLP metrics stream reports per-turn tokens (input, output, cache-read, cache-creation) and cost estimates directly from Claude processes.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["claude-code"].listMonthlyUsd,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    provider: "OpenAI",
    description: "Codex CLI & autonomous coding cloud agent.",
    dataCapability: "Incremental session JSONL delta parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests token usage snapshots from ~/.codex/sessions/**/*.jsonl. Deduplicates consecutive token_count replays automatically.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["openai-codex"].listMonthlyUsd,
  },
  {
    id: "cursor-agent",
    name: "Cursor",
    provider: "Cursor",
    description: "Cursor AI editor & background agent process.",
    dataCapability: "Live process detection. Token telemetry is not available.",
    fidelityTier: "process_only",
    tokenTelemetryKind: "none",
    notes: "Cursor keeps usage local to its IDE client and does not expose an unauthenticated local token ledger.  Process status is live.  Usage is not reported.",
    defaultMonthlySeatCostUsd: 0,
    listMonthlySeatCostUsd: AGENT_SEAT_CATALOG["cursor-agent"].listMonthlyUsd,
    bundledOffsetUsd: AGENT_SEAT_CATALOG["cursor-agent"].listMonthlyUsd,
    bundledOffsetLabel: "SuperGrok Heavy",
    unavailableReason:
      "Cursor does not expose a local token ledger.  Process status is live.  Usage is not reported.",
  },
  {
    id: "grok-build",
    name: "Grok Build & Leader",
    provider: "xAI",
    description: "Grok CLI, Grok Leader PM2 service, and Grok ACP agent.",
    dataCapability: "Turn-completed token & costUsdTicks parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests turn_completed events from ~/.grok/sessions/**/updates.jsonl with model breakdown and high-precision cost ticks.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["grok-build"].listMonthlyUsd,
  },
  {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    provider: "Google",
    description: "Antigravity pair-programming agent & agy-acp PM2 service.",
    dataCapability: "Exact cumulative status-line tokens plus /usage quota windows",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes:
      "The CLI status line reports exact cumulative input and output.  Model attribution and cache read/write are accepted only when the current-request counters reconcile to the cumulative delta; mixed or missed history stays unpriced with an unknown model.",
    defaultMonthlySeatCostUsd: AGENT_SEAT_CATALOG["antigravity-cli"].billedMonthlyUsd ?? 70,
    listMonthlySeatCostUsd: AGENT_SEAT_CATALOG["antigravity-cli"].listMonthlyUsd,
    bundledOffsetUsd: 30,
    bundledOffsetLabel: "Google One",
  },
  {
    id: "antigravity-ide",
    name: "Antigravity Desktop",
    provider: "Google",
    description: "Antigravity native desktop coding app.",
    dataCapability: "Quota windows only. Exact desktop turn-token export is not available.",
    fidelityTier: "unavailable",
    tokenTelemetryKind: "none",
    notes:
      "The native desktop app does not expose the CLI status-line token stream.  Its local brain transcripts are not used as token estimates.",
    defaultMonthlySeatCostUsd: 0,
    unavailableReason:
      "Antigravity Desktop does not expose exact turn-token telemetry.  This is not zero usage.",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    provider: "GitHub",
    description: "GitHub Copilot CLI & IDE assistant.",
    dataCapability: "Session shutdown modelMetrics delta parsing",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes: "Ingests session.shutdown modelMetrics from ~/.copilot/session-state/ with inclusive cache token splitting.",
    defaultMonthlySeatCostUsd: 0,
  },
  {
    id: "minimax-code",
    name: "MiniMax Code",
    provider: "MiniMax",
    description: "MiniMax Code CLI / agent seat.",
    dataCapability: "Exact Token Plan quota windows; process detection; no per-turn token feed",
    fidelityTier: "unavailable",
    tokenTelemetryKind: "none",
    notes: "The official mmx CLI exposes exact rolling and weekly remaining-percent quota.  Token usage is not reported because MiniMax has no exact local per-turn feed.",
    defaultMonthlySeatCostUsd: 0,
    unavailableReason:
      "MiniMax Code has no exact local per-turn token feed.  This is not zero usage.",
  },
  {
    id: "deepseek-dsh",
    name: "DeepSeek Harness",
    provider: "DeepSeek",
    description: "DeepSeek Harness CLI and ACP seat.",
    dataCapability: "Exact assistant-message token usage from compressed DSH sessions",
    fidelityTier: "session_jsonl",
    tokenTelemetryKind: "session_jsonl",
    notes:
      "Ingests exact input, output, cache-read, and reasoning detail from standalone DSH session archives.  BotFleet child exclusion activates only after durable BotFleet delivery is deployed.",
    defaultMonthlySeatCostUsd: 0,
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    provider: "Moonshot AI",
    description: "Kimi Code CLI and ACP seat.",
    dataCapability: "Live process detection. Exact token telemetry is not available.",
    fidelityTier: "unavailable",
    tokenTelemetryKind: "none",
    notes:
      "Kimi Code's local wire log exposes request models and a turn-counting estimate, but no provider input/output usage ledger.  Usage is not reported.",
    defaultMonthlySeatCostUsd: 0,
    unavailableReason:
      "Kimi Code does not expose exact local token usage.  This is not zero usage.",
  },
];

const TOKEN_TELEMETRY_KIND_BY_APP = new Map(
  AGENT_PLATFORMS.map((meta) => [meta.id, meta.tokenTelemetryKind] as const),
);

export function platformIdForSourceApp(sourceApp: string): string {
  const normalized = sourceApp.trim().toLowerCase();
  if (normalized === CURSOR_ADMIN_SOURCE_APP) return "cursor-agent";
  return normalized === "antigravity-statusline" ? "antigravity-cli" : normalized;
}

/** Claude Code OTLP cost wins over token-catalog PAYG when both exist. */
export function preferPlatformEstimatedCostUsd(
  platformId: string,
  tokenDerivedUsd: number,
  reportedUsd: number,
): number {
  if (platformId === "claude-code" && reportedUsd > 0) {
    return reportedUsd;
  }
  return Math.max(tokenDerivedUsd, reportedUsd);
}

export function isReliableTokenSourceApp(sourceApp: string): boolean {
  const normalized = sourceApp.trim().toLowerCase();
  if (normalized === CURSOR_ADMIN_SOURCE_APP) return true;
  // Historical antigravity-cli token rows came from transcript character
  // estimates.  Only the separate status-line producer carries exact counts.
  if (normalized === "antigravity-cli") return false;
  const appKey = platformIdForSourceApp(normalized);
  const kind = TOKEN_TELEMETRY_KIND_BY_APP.get(appKey);
  if (!kind) return true;
  return isReliableTokenTelemetryKind(kind);
}

export interface AgentPlatformStatus {
  id: string;
  name: string;
  provider: string;
  isRunningOnMac: boolean;
  macStatus: "running" | "idle" | "stopped" | "unknown";
  dataCapability: string;
  fidelityTier: "realtime_otlp" | "session_jsonl" | "process_only" | "unavailable";
  notes: string;
  monthlySeatCostUsd: number;
  billedMonthlySeatCostUsd: number;
  seatPlanName: string;
  seatPlanNote: string | null;
  seatPlanSource: AgentSeatSource;
  listMonthlySeatCostUsd: number;
  bundledOffsetUsd: number | null;
  bundledOffsetLabel: string | null;
  seatCostNote: string | null;
  telemetryAccuracy: TelemetryAccuracy;
  telemetryAccuracyLabel: string;
  telemetryAccuracyNote: string;
  usageIsReliable: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiEquivalentCostUsd: number;
  apiEquivalentCostComplete: boolean;
  /** Token x catalog PAYG estimate (always token-derived when usage is reliable). */
  tokenDerivedCostUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  netSavingsUsd: number;
  modelsUsed: Array<{
    model: string;
    tokens: number;
    percentOfPlatform: number;
    apiEquivalentCostUsd: number;
    apiEquivalentCostKnown: boolean;
  }>;
}

export interface AgentsOverviewResponse {
  ok: boolean;
  windowDays: number;
  windowLabel: string;
  generatedAt: string;
  macHostname: string;
  macChip: string;
  summary: {
    activeAgentCount: number;
    totalAgentCount: number;
    totalTokens: number;
    totalApiEquivalentCostUsd: number;
    apiEquivalentCostComplete: boolean;
    unpricedModelCount: number;
    totalSubscriptionCostUsd: number;
    totalNetSavingsUsd: number;
    savingsMultiplier: number;
    topModel: string | null;
    telemetryIncomplete: boolean;
    telemetryIncompleteNote: string | null;
    unreliablePlatformIds: string[];
  };
  burn5h: {
    tokens5h: number;
    costEstimate5hUsd: number;
    costEstimateComplete: boolean;
    burnRateTokensPerHour: number;
    burnRateUsdPerHour: number;
  };
  platforms: AgentPlatformStatus[];
  modelDistribution: Array<{
    model: string;
    provider: string;
    tokens: number;
    percent: number;
    apiEquivalentCostUsd: number;
    apiEquivalentCostKnown: boolean;
  }>;
}

export async function computeAgentsOverview(windowDays: number = 30): Promise<AgentsOverviewResponse> {
  const now = new Date();
  const since = windowDays >= 3650 ? new Date(0) : new Date(now.getTime() - windowDays * 86_400_000);
  const windowLabel =
    windowDays <= 1
      ? "Last 24 Hours"
      : windowDays <= 7
      ? "Last 7 Days"
      : windowDays <= 30
      ? "Last 30 Days"
      : "All Time";

  const window5hStart = new Date(now.getTime() - 5 * 3_600_000);
  const otherSeats = SUBSCRIPTION_ANALYTICS_SOURCE_APPS.filter(
    (app) => app !== "claude-code"
  );
  const seatsFilter = [...otherSeats, "cursor-agent"];

  const eventWhereOr = [
    { sourceApp: "claude-code", service: "claude-code" },
    { sourceApp: { in: seatsFilter } },
    { sourceApp: CURSOR_ADMIN_SOURCE_APP },
  ];

  // Same split as summarizeExternalUsageEvents: raw events from the retention
  // cutoff forward, daily rollups only for days before that cutoff.  Adding
  // both for the same days double-counted tokens after a collector backfill.
  const rawCutoff = getExternalEventRawCutoff(now);
  const rawSince = since > rawCutoff ? since : rawCutoff;
  const queryRollups = since < rawCutoff;
  const rollupDayGte = startOfUtcDay(since);

  const emptyRollup = Promise.resolve(
    [] as Array<{
      sourceApp: string;
      provider: string;
      keyRef: string | null;
      label?: string | null;
      _sum: { totalQuantity?: number | null; totalCostUsd?: number | null };
    }>
  );

  const [
    macHealth,
    tokenGroups,
    costGroups,
    token5hGroups,
    cost5hGroups,
    rollupTokenGroups,
    rollupCostGroups,
    earliestEvent,
    subscriptionRows,
    observedCodexPlan,
    deepseekTokenRows,
    cursorAdminRows,
  ] = await Promise.all([
    getLatestMacHealth().catch(() => null),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef", "label"],
      where: {
        OR: eventWhereOr,
        metricType: "usage",
        unit: "token",
        occurredAt: { gte: rawSince },
      },
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef"],
      where: {
        OR: eventWhereOr,
        metricType: "cost",
        occurredAt: { gte: rawSince },
      },
      _sum: { costUsd: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef", "label"],
      where: {
        OR: eventWhereOr,
        metricType: "usage",
        unit: "token",
        occurredAt: { gte: window5hStart },
      },
      _sum: { quantity: true },
    }),
    prisma.externalUsageEvent.groupBy({
      by: ["sourceApp", "provider", "keyRef"],
      where: {
        OR: eventWhereOr,
        metricType: "cost",
        occurredAt: { gte: window5hStart },
      },
      _sum: { costUsd: true },
    }),
    queryRollups
      ? prisma.externalUsageEventDailyRollup.groupBy({
          by: ["sourceApp", "provider", "keyRef", "label"],
          where: {
            OR: eventWhereOr,
            metricType: "usage",
            unit: "token",
            day: { gte: rollupDayGte, lt: rawCutoff },
          },
          _sum: { totalQuantity: true },
        })
      : emptyRollup,
    queryRollups
      ? prisma.externalUsageEventDailyRollup.groupBy({
          by: ["sourceApp", "provider", "keyRef"],
          where: {
            OR: eventWhereOr,
            metricType: "cost",
            day: { gte: rollupDayGte, lt: rawCutoff },
          },
          _sum: { totalCostUsd: true },
        })
      : emptyRollup,
    windowDays > 30
      ? prisma.externalUsageEvent.findFirst({
          where: { OR: eventWhereOr },
          orderBy: { occurredAt: "asc" },
          select: { occurredAt: true },
        })
      : null,
    prisma.subscription.findMany({
      where: { currency: "USD" },
      select: {
        status: true,
        name: true,
        costUsd: true,
        currency: true,
        interval: true,
        intervalCount: true,
        provider: { select: { name: true, displayName: true } },
      },
    }),
    prisma.externalUsageEvent.findFirst({
      where: {
        sourceApp: "openai-codex",
        metricType: "quota_sync",
        label: "observed-plan",
      },
      orderBy: { occurredAt: "desc" },
      select: { keyRef: true },
    }),
    // DeepSeek Flash / V4 Pro rates depend on the event's UTC hour.  Grouped
    // sums cannot price them.  These rows are the raw events inside the
    // retention window; daily rollups have no hour and stay unpriced.
    prisma.externalUsageEvent.findMany({
      where: {
        AND: [
          { OR: eventWhereOr },
          { metricType: "usage" },
          { unit: "token" },
          { occurredAt: { gte: rawSince } },
          {
            OR: [
              { keyRef: { contains: "deepseek-v4" } },
              { keyRef: { contains: "deepseek-flash" } },
            ],
          },
        ],
      },
      select: {
        sourceApp: true,
        keyRef: true,
        label: true,
        quantity: true,
        occurredAt: true,
      },
    }),
    prisma.externalUsageEvent.findMany({
      where: {
        sourceApp: CURSOR_ADMIN_SOURCE_APP,
        metricType: "cost",
        occurredAt: { gte: rawSince },
      },
      select: {
        keyRef: true,
        quantity: true,
        unit: true,
        costUsd: true,
        metadata: true,
        occurredAt: true,
      },
    }),
  ]);

  const hasCursorAdminBilling = cursorAdminRows.length > 0;

  const skipOverlappingSeatEvent = (sourceApp: string): boolean =>
    hasCursorAdminBilling && sourceApp.trim().toLowerCase() === "cursor-agent";

  const observedByPlatform: Partial<Record<string, { planType: string }>> = {};
  if (observedCodexPlan?.keyRef?.trim()) {
    observedByPlatform["openai-codex"] = { planType: observedCodexPlan.keyRef.trim() };
  }

  const seatSubscriptions: AgentSeatSubscriptionInput[] = subscriptionRows.map((row) => ({
    status: row.status,
    name: row.name,
    costUsd: row.costUsd,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.intervalCount,
    providerName: row.provider.name,
    providerDisplayName: row.provider.displayName,
  }));

  const agentProcesses = macHealth?.mac?.agentProcesses || {};
  const macProcesses = macHealth?.mac?.processes || {};

  const tokensByPlatformAndModel = new Map<string, Map<string, AgentTokenBreakdown>>();
  const reportedCostByPlatform = new Map<string, number>();

  for (const row of costGroups) {
    if (!isReliableTokenSourceApp(row.sourceApp)) continue;
    if (skipOverlappingSeatEvent(row.sourceApp)) continue;
    const app = platformIdForSourceApp(row.sourceApp);
    const current = reportedCostByPlatform.get(app) || 0;
    reportedCostByPlatform.set(app, current + (row._sum.costUsd || 0));
  }
  for (const row of rollupCostGroups) {
    if (!isReliableTokenSourceApp(row.sourceApp)) continue;
    if (skipOverlappingSeatEvent(row.sourceApp)) continue;
    const app = platformIdForSourceApp(row.sourceApp);
    const current = reportedCostByPlatform.get(app) || 0;
    reportedCostByPlatform.set(app, current + (row._sum.totalCostUsd || 0));
  }
  let grandTotalTokens = 0;
  const tokensByModel = new Map<string, { provider: string; tokens: number; apiCost: number; apiCostKnown: boolean }>();

  const allTokenRows = [
    ...tokenGroups.map((g) => ({
      sourceApp: g.sourceApp,
      provider: g.provider,
      keyRef: g.keyRef,
      label: g.label,
      quantity: g._sum.quantity,
    })),
    ...rollupTokenGroups.map((g) => ({
      sourceApp: g.sourceApp,
      provider: g.provider,
      keyRef: g.keyRef,
      label: g.label,
      quantity: g._sum.totalQuantity,
    })),
  ];

  for (const group of allTokenRows) {
    if (!isReliableTokenSourceApp(group.sourceApp)) continue;
    if (skipOverlappingSeatEvent(group.sourceApp)) continue;
    const app = platformIdForSourceApp(group.sourceApp);
    const model = group.keyRef || "unknown-model";
    const qty = Math.max(0, group.quantity || 0);
    grandTotalTokens += qty;

    if (!tokensByPlatformAndModel.has(app)) {
      tokensByPlatformAndModel.set(app, new Map());
    }
    const modelMap = tokensByPlatformAndModel.get(app)!;
    if (!modelMap.has(model)) {
      modelMap.set(model, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        unknown: 0,
        incompleteInput: false,
        total: 0,
      });
    }
    const breakdown = modelMap.get(model)!;
    breakdown.total += qty;

    const label = group.label?.toLowerCase() || "";
    if (label.includes("inputunsplit")) {
      breakdown.incompleteInput = true;
      breakdown.unknown += qty;
    } else if (label.includes("input")) {
      breakdown.input += qty;
    } else if (label.includes("output")) {
      breakdown.output += qty;
    } else if (label.includes("cacheread") || label.includes("cache_read") || label.includes("cache_hit")) {
      breakdown.cacheRead += qty;
    } else if (label.includes("cachecreation") || label.includes("cache_creation") || label.includes("cache_write")) {
      breakdown.cacheCreation += qty;
    } else {
      breakdown.unknown += qty;
    }

    // Model distribution
    const existingModel = tokensByModel.get(model) || {
      provider: group.provider,
      tokens: 0,
      apiCost: 0,
      apiCostKnown: true,
    };
    existingModel.tokens += qty;
    tokensByModel.set(model, existingModel);
  }

  foldCursorAdminTokenRows(cursorAdminRows, tokensByPlatformAndModel, tokensByModel, {
    onTokens: (qty) => {
      grandTotalTokens += qty;
    },
  });

  // Calculate API-equivalent pricing per platform & model
  let totalApiEquivalentCost = 0;
  let totalSubscriptionCost = 0;
  let activeAgentCount = 0;

  let effectiveDays = windowDays;
  if (windowDays >= 3650) {
    if (earliestEvent?.occurredAt) {
      const elapsedDays = Math.ceil(
        (now.getTime() - earliestEvent.occurredAt.getTime()) / 86_400_000
      );
      effectiveDays = Math.max(30, elapsedDays);
    } else {
      effectiveDays = 30;
    }
  }

  const platforms: AgentPlatformStatus[] = AGENT_PLATFORMS.map((meta) => {
    const appKey = meta.id.toLowerCase();
    const isRunning =
      agentProcesses[appKey] === "running" ||
      (appKey === "deepseek-dsh" && agentProcesses.deepseek === "running") ||
      (appKey === "kimi-code" && agentProcesses.kimi === "running") ||
      (appKey === "grok-build" && (macProcesses["grok-leader"] === "running" || agentProcesses["grok-build"] === "running")) ||
      (appKey === "claude-code" && (macProcesses["claude-remote-control"] === "running" || agentProcesses["claude-code"] === "running"));

    if (isRunning) activeAgentCount++;

    const modelMap = tokensByPlatformAndModel.get(appKey) || new Map();
    let platformTotalTokens = 0;
    let platformInput = 0;
    let platformOutput = 0;
    let platformCacheRead = 0;
    let platformCacheCreation = 0;
    let platformApiCost = 0;
    let platformApiCostComplete = true;

    const modelsUsed: AgentPlatformStatus["modelsUsed"] = [];

    for (const [modelName, breakdown] of modelMap.entries()) {
      platformTotalTokens += breakdown.total;
      platformInput += breakdown.input;
      platformOutput += breakdown.output;
      platformCacheRead += breakdown.cacheRead;
      platformCacheCreation += breakdown.cacheCreation;

      // Price the model tokens.  DeepSeek PAYG uses each raw event's UTC
      // hour.  A grouped sum would hide the peak/off-peak split.
      const deepseekPriced = isDeepSeekPaygModel(modelName)
        ? sumDeepSeekPaygEvents(
            deepseekPaygEventsFor(deepseekTokenRows, { appKey, model: modelName }),
          )
        : null;
      const modelPricing = deepseekPriced ? null : getModelPricing(modelName);
      const priced = deepseekPriced
        ? null
        : modelPricing
          ? deriveTokenCostUsd(modelPricing.pricing, {
              input: breakdown.input,
              output: breakdown.output,
              cacheRead: breakdown.cacheRead,
              cacheCreation: breakdown.cacheCreation,
            })
          : null;

      const modelCost = deepseekPriced?.costUsd ?? priced?.costUsd ?? 0;
      const deepseekCoversGrouped =
        deepseekPriced != null && deepseekPriced.seenQuantity + 1e-6 >= breakdown.total;
      const modelCostKnown = deepseekPriced
        ? deepseekPriced.complete &&
          deepseekCoversGrouped &&
          !breakdown.incompleteInput &&
          breakdown.unknown === 0
        : Boolean(priced?.complete) && !breakdown.incompleteInput && breakdown.unknown === 0;
      if (!modelCostKnown && breakdown.total > 0) platformApiCostComplete = false;
      platformApiCost += modelCost;

      modelsUsed.push({
        model: modelName,
        tokens: breakdown.total,
        percentOfPlatform: 0, // computed below
        apiEquivalentCostUsd: Number(modelCost.toFixed(4)),
        apiEquivalentCostKnown: modelCostKnown,
      });

      // Add to overall model distribution
      const globalModel = tokensByModel.get(modelName);
      if (globalModel) {
        globalModel.apiCost += modelCost;
        globalModel.apiCostKnown = globalModel.apiCostKnown && modelCostKnown;
      }
    }

    // Compute model percentage of platform
    for (const item of modelsUsed) {
      item.percentOfPlatform = platformTotalTokens > 0 ? (item.tokens / platformTotalTokens) * 100 : 0;
    }
    modelsUsed.sort((a, b) => b.tokens - a.tokens);

    const reportedCost = reportedCostByPlatform.get(appKey) || 0;
    const estimatedCost = preferPlatformEstimatedCostUsd(
      appKey,
      platformApiCost,
      reportedCost,
    );
    const seat = isAgentPlatformId(meta.id)
      ? resolveAgentSeat(meta.id, seatSubscriptions, observedByPlatform[meta.id] ?? null)
      : {
          planName: `${meta.name} seat`,
          listMonthlyUsd: meta.listMonthlySeatCostUsd ?? meta.defaultMonthlySeatCostUsd,
          billedMonthlyUsd: meta.defaultMonthlySeatCostUsd,
          source: "catalog" as const,
          note: null,
        };
    const bundledOffset = meta.bundledOffsetUsd ?? null;
    const bundledOffsetLabel = meta.bundledOffsetLabel ?? null;
    const listSeat = Math.max(seat.listMonthlyUsd, meta.listMonthlySeatCostUsd ?? 0);
    const billedSeat = seat.billedMonthlyUsd;
    const monthlySeat =
      bundledOffset != null && bundledOffset > 0 ? billedSeat : listSeat;
    const seatCostNote =
      bundledOffset != null && bundledOffset > 0
        ? `$${listSeat}/mo plan.  $${bundledOffset} of that was already ${bundledOffsetLabel ?? "bundled"}, so $${monthlySeat} net for the AI.`
        : seat.note;
    const proratedSubscriptionCost =
      (billedSeat / 30) * Math.min(windowDays, effectiveDays);

    const tokenTelemetryKind =
      appKey === "cursor-agent" && hasCursorAdminBilling
        ? "billing_api"
        : meta.tokenTelemetryKind;
    const fidelityTier =
      appKey === "cursor-agent" && hasCursorAdminBilling
        ? "session_jsonl"
        : meta.fidelityTier;
    const dataCapability =
      appKey === "cursor-agent" && hasCursorAdminBilling
        ? "Cursor team Admin API (filtered usage events)"
        : meta.dataCapability;

    const accuracy = resolveTelemetryAccuracy({
      name: meta.name,
      tokenTelemetryKind,
      totalTokens: platformTotalTokens,
      isRunningOnMac: Boolean(isRunning),
      unavailableReason: meta.unavailableReason,
    });

    const displayTokens = accuracy.usageIsReliable ? platformTotalTokens : 0;
    const displayApiCost = accuracy.usageIsReliable ? platformApiCost : 0;
    const displayReported = accuracy.usageIsReliable ? reportedCost : 0;
    const displayEstimated = accuracy.usageIsReliable ? estimatedCost : 0;
    const netSavings = Math.max(0, displayEstimated - proratedSubscriptionCost);

    totalApiEquivalentCost += displayEstimated;
    totalSubscriptionCost += proratedSubscriptionCost;

    return {
      id: meta.id,
      name: meta.name,
      provider: meta.provider,
      isRunningOnMac: Boolean(isRunning),
      macStatus: isRunning ? "running" : "idle",
      dataCapability,
      fidelityTier,
      notes: meta.notes,
      monthlySeatCostUsd: monthlySeat,
      billedMonthlySeatCostUsd: billedSeat,
      seatPlanName: seat.planName,
      seatPlanNote: seat.note,
      seatPlanSource: seat.source,
      listMonthlySeatCostUsd: listSeat,
      bundledOffsetUsd: bundledOffset,
      bundledOffsetLabel,
      seatCostNote,
      telemetryAccuracy: accuracy.accuracy,
      telemetryAccuracyLabel: accuracy.label,
      telemetryAccuracyNote: accuracy.note,
      usageIsReliable: accuracy.usageIsReliable,
      totalTokens: displayTokens,
      inputTokens: accuracy.usageIsReliable ? platformInput : 0,
      outputTokens: accuracy.usageIsReliable ? platformOutput : 0,
      cacheReadTokens: accuracy.usageIsReliable ? platformCacheRead : 0,
      cacheCreationTokens: accuracy.usageIsReliable ? platformCacheCreation : 0,
      apiEquivalentCostUsd: Number(displayApiCost.toFixed(2)),
      apiEquivalentCostComplete:
        accuracy.usageIsReliable && platformApiCostComplete,
      tokenDerivedCostUsd: Number(
        (accuracy.usageIsReliable ? platformApiCost : 0).toFixed(2),
      ),
      reportedCostUsd: Number(displayReported.toFixed(2)),
      estimatedCostUsd: Number(displayEstimated.toFixed(2)),
      netSavingsUsd: Number(netSavings.toFixed(2)),
      modelsUsed: accuracy.usageIsReliable ? modelsUsed : [],
    };
  });

  const modelDistribution = Array.from(tokensByModel.entries())
    .map(([model, data]) => ({
      model,
      provider: data.provider,
      tokens: data.tokens,
      percent: grandTotalTokens > 0 ? (data.tokens / grandTotalTokens) * 100 : 0,
      apiEquivalentCostUsd: Number(data.apiCost.toFixed(2)),
      apiEquivalentCostKnown: data.apiCostKnown,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const topModel = modelDistribution[0]?.model || null;
  const totalNetSavings = Math.max(0, totalApiEquivalentCost - totalSubscriptionCost);
  const savingsMultiplier = totalSubscriptionCost > 0 ? totalApiEquivalentCost / totalSubscriptionCost : 1;
  const unreliablePlatforms = platforms.filter((p) => !p.usageIsReliable);
  const unpricedModelCount = modelDistribution.filter(
    (model) => !model.apiEquivalentCostKnown,
  ).length;
  const telemetryIncompleteNote = telemetryIncompleteNoteFor(
    unreliablePlatforms.map((p) => p.name),
  );

  // 5-hour rolling burn numbers
  let tokens5h = 0;
  let derivedCost5hComplete = true;
  let deepseekTokens5h = 0;
  const derivedCost5hByPlatform = new Map<string, number>();
  const reportedCost5hByPlatform = new Map<string, number>();

  for (const g of token5hGroups) {
    if (!isReliableTokenSourceApp(g.sourceApp)) continue;
    if (skipOverlappingSeatEvent(g.sourceApp)) continue;
    const qty = Math.max(0, g._sum.quantity || 0);
    tokens5h += qty;
    const model = g.keyRef || "";
    const label = g.label?.toLowerCase() || "";
    if (label.includes("inputunsplit") && qty > 0) derivedCost5hComplete = false;
    if (isDeepSeekPaygModel(model)) {
      deepseekTokens5h += qty;
      continue;
    }
    const modelPricing = getModelPricing(model);
    const isCacheWrite =
      label.includes("cachecreation") || label.includes("cache_creation") || label.includes("cache_write");
    const breakdown = label.includes("output")
      ? { output: qty }
      : label.includes("cacheread") || label.includes("cache_read") || label.includes("cache_hit")
        ? { cacheRead: qty }
        : isCacheWrite
          ? /(1h|onehour)/.test(label)
            ? { cacheCreation1h: qty }
            : { cacheCreation: qty }
          : { input: qty };
    const priced = modelPricing
      ? deriveTokenCostUsd(modelPricing.pricing, breakdown)
      : null;
    if (!priced?.complete && qty > 0) derivedCost5hComplete = false;
    const app = platformIdForSourceApp(g.sourceApp);
    const current = derivedCost5hByPlatform.get(app) || 0;
    derivedCost5hByPlatform.set(app, current + (priced?.costUsd || 0));
  }

  if (deepseekTokens5h > 0) {
    const deepseek5h = sumDeepSeekPaygEvents(
      deepseekPaygEventsFor(deepseekTokenRows, { since: window5hStart }),
    );
    const app = "deepseek-dsh";
    const current = derivedCost5hByPlatform.get(app) || 0;
    derivedCost5hByPlatform.set(app, current + deepseek5h.costUsd);
    if (!deepseek5h.complete || deepseek5h.seenQuantity + 1e-6 < deepseekTokens5h) {
      derivedCost5hComplete = false;
    }
  }

  for (const g of cost5hGroups) {
    if (!isReliableTokenSourceApp(g.sourceApp)) continue;
    if (skipOverlappingSeatEvent(g.sourceApp)) continue;
    const cost = Math.max(0, g._sum.costUsd || 0);
    const app = platformIdForSourceApp(g.sourceApp);
    const current = reportedCost5hByPlatform.get(app) || 0;
    reportedCost5hByPlatform.set(app, current + cost);
  }

  for (const row of cursorAdminRows) {
    if (row.occurredAt.getTime() < window5hStart.getTime()) continue;
    const app = platformIdForSourceApp(CURSOR_ADMIN_SOURCE_APP);
    tokens5h += cursorAdminTokenBreakdown(row).total;
    const priced = cursorAdminRowDerivedCost(row);
    if (priced && !priced.complete) derivedCost5hComplete = false;
    if (priced) {
      const derivedCurrent = derivedCost5hByPlatform.get(app) || 0;
      derivedCost5hByPlatform.set(app, derivedCurrent + priced.costUsd);
    }
  }

  const costEstimate5hUsd = [...new Set([
    ...derivedCost5hByPlatform.keys(),
    ...reportedCost5hByPlatform.keys(),
  ])].reduce(
    (sum, app) =>
      sum +
      preferPlatformEstimatedCostUsd(
        app,
        derivedCost5hByPlatform.get(app) || 0,
        reportedCost5hByPlatform.get(app) || 0,
      ),
    0,
  );
  const burnRateTokensPerHour = Math.round(tokens5h / 5);
  const burnRateUsdPerHour = Number((costEstimate5hUsd / 5).toFixed(2));

  return {
    ok: true,
    windowDays,
    windowLabel,
    generatedAt: now.toISOString(),
    macHostname: macHealth?.mac?.hostname || "jays.services",
    macChip: macHealth?.mac?.chipName || "Apple M5",
    summary: {
      activeAgentCount,
      totalAgentCount: AGENT_PLATFORMS.length,
      totalTokens: grandTotalTokens,
      totalApiEquivalentCostUsd: Number(totalApiEquivalentCost.toFixed(2)),
      apiEquivalentCostComplete:
        unpricedModelCount === 0 && unreliablePlatforms.length === 0,
      unpricedModelCount,
      totalSubscriptionCostUsd: Number(totalSubscriptionCost.toFixed(2)),
      totalNetSavingsUsd: Number(totalNetSavings.toFixed(2)),
      savingsMultiplier: Number(savingsMultiplier.toFixed(1)),
      topModel,
      telemetryIncomplete: unreliablePlatforms.length > 0,
      telemetryIncompleteNote,
      unreliablePlatformIds: unreliablePlatforms.map((p) => p.id),
    },
    burn5h: {
      tokens5h,
      costEstimate5hUsd: Number(costEstimate5hUsd.toFixed(2)),
      costEstimateComplete:
        derivedCost5hComplete && unreliablePlatforms.length === 0,
      burnRateTokensPerHour: Math.round(burnRateTokensPerHour),
      burnRateUsdPerHour: Number(burnRateUsdPerHour.toFixed(2)),
    },
    platforms,
    modelDistribution,
  };
}

type CursorAdminUsageRow = {
  keyRef: string | null;
  quantity: number | null;
  unit: string | null;
  metadata: unknown;
  occurredAt: Date;
};

function cursorAdminMetadataNumber(metadata: unknown, key: string): number {
  if (!metadata || typeof metadata !== "object") return 0;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function cursorAdminTokenBreakdown(row: CursorAdminUsageRow): {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
} {
  const input = cursorAdminMetadataNumber(row.metadata, "inputTokens");
  const output = cursorAdminMetadataNumber(row.metadata, "outputTokens");
  const cacheRead = cursorAdminMetadataNumber(row.metadata, "cacheReadTokens");
  const cacheCreation = cursorAdminMetadataNumber(row.metadata, "cacheWriteTokens");
  const fromMeta = input + output + cacheRead + cacheCreation;
  const total =
    fromMeta > 0
      ? fromMeta
      : row.unit === "token"
        ? Math.max(0, row.quantity || 0)
        : 0;
  return {
    model: row.keyRef || "unknown-model",
    input,
    output,
    cacheRead,
    cacheCreation,
    total,
  };
}

type AgentTokenBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unknown: number;
  incompleteInput: boolean;
  total: number;
};

function foldCursorAdminTokenRows(
  rows: readonly CursorAdminUsageRow[],
  tokensByPlatformAndModel: Map<string, Map<string, AgentTokenBreakdown>>,
  tokensByModel: Map<string, { provider: string; tokens: number; apiCost: number; apiCostKnown: boolean }>,
  opts: { onTokens?: (quantity: number) => void; since?: Date } = {},
): void {
  const app = platformIdForSourceApp(CURSOR_ADMIN_SOURCE_APP);
  for (const row of rows) {
    if (opts.since && row.occurredAt.getTime() < opts.since.getTime()) continue;
    const breakdown = cursorAdminTokenBreakdown(row);
    if (breakdown.total <= 0) continue;
    opts.onTokens?.(breakdown.total);

    if (!tokensByPlatformAndModel.has(app)) {
      tokensByPlatformAndModel.set(app, new Map());
    }
    const modelMap = tokensByPlatformAndModel.get(app)!;
    if (!modelMap.has(breakdown.model)) {
      modelMap.set(breakdown.model, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        unknown: 0,
        incompleteInput: false,
        total: 0,
      });
    }
    const modelBreakdown = modelMap.get(breakdown.model)!;
    modelBreakdown.input += breakdown.input;
    modelBreakdown.output += breakdown.output;
    modelBreakdown.cacheRead += breakdown.cacheRead;
    modelBreakdown.cacheCreation += breakdown.cacheCreation;
    if (fromMetaIsMissing(breakdown)) {
      modelBreakdown.unknown += breakdown.total;
    }
    modelBreakdown.total += breakdown.total;

    const existingModel = tokensByModel.get(breakdown.model) || {
      provider: "cursor",
      tokens: 0,
      apiCost: 0,
      apiCostKnown: true,
    };
    existingModel.tokens += breakdown.total;
    tokensByModel.set(breakdown.model, existingModel);
  }
}

function fromMetaIsMissing(breakdown: {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}): boolean {
  return (
    breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheCreation <= 0 &&
    breakdown.total > 0
  );
}

function cursorAdminRowDerivedCost(
  row: CursorAdminUsageRow,
): { costUsd: number; complete: boolean } | null {
  const breakdown = cursorAdminTokenBreakdown(row);
  if (breakdown.total <= 0) return null;
  const modelPricing = getModelPricing(breakdown.model);
  if (!modelPricing) {
    return { costUsd: 0, complete: false };
  }
  const priced = deriveTokenCostUsd(modelPricing.pricing, {
    input: breakdown.input,
    output: breakdown.output,
    cacheRead: breakdown.cacheRead,
    cacheCreation: breakdown.cacheCreation,
  });
  const complete =
    priced.complete &&
    !fromMetaIsMissing(breakdown) &&
    breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheCreation ===
      breakdown.total;
  return { costUsd: priced.costUsd, complete };
}

type DeepSeekTokenRow = {
  sourceApp: string;
  keyRef: string | null;
  label: string | null;
  quantity: number | null;
  occurredAt: Date;
};

function deepseekPaygEventsFor(
  rows: readonly DeepSeekTokenRow[],
  opts: { appKey?: string; model?: string; since?: Date },
): DeepSeekPaygEvent[] {
  const events: DeepSeekPaygEvent[] = [];
  for (const row of rows) {
    if (!row.keyRef || !isDeepSeekPaygModel(row.keyRef)) continue;
    if (!isReliableTokenSourceApp(row.sourceApp)) continue;
    if (opts.appKey && platformIdForSourceApp(row.sourceApp) !== opts.appKey) continue;
    if (opts.model && row.keyRef !== opts.model) continue;
    if (opts.since && row.occurredAt.getTime() < opts.since.getTime()) continue;
    events.push({
      model: row.keyRef,
      occurredAt: row.occurredAt,
      label: row.label,
      quantity: row.quantity,
    });
  }
  return events;
}
