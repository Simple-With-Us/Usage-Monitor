import { normalizeMonthlyUsd, type SubscriptionInterval } from "@/lib/subscriptions";

/**
 * Coding-seat cash comes from receipts / active Subscription rows, not from
 * a guessed catalog.  Observed login claims (Codex JWT chatgpt_plan_type)
 * name the SKU.  Public list prices for that SKU are labels, not billed cash,
 * until a receipt lands.  Owner 2026-09-03: do not invent ChatGPT Pro $200
 * when login says Plus; Copilot is unpaid; Cursor Ultra is included with
 * SuperGrok Heavy; MiniMax waits on a receipt.
 */

export type AgentPlatformId =
  | "claude-code"
  | "openai-codex"
  | "cursor-agent"
  | "grok-build"
  | "antigravity-cli"
  | "github-copilot"
  | "minimax-code";

export type AgentSeatSource =
  | "receipt"
  | "observed"
  | "included"
  | "catalog"
  | "unknown";

export interface AgentSeatCatalogEntry {
  planName: string;
  listMonthlyUsd: number;
  billedMonthlyUsd?: number;
  billedNote?: string;
  /** $0 cash; list price is a perk of another seat. */
  includedWith?: string;
}

export interface AgentSeatSubscriptionInput {
  status: string;
  name: string;
  costUsd: number;
  currency?: string | null;
  interval: string;
  intervalCount: number;
  providerName: string;
  providerDisplayName: string;
}

export interface ObservedAgentPlan {
  planType: string;
}

export interface ResolvedAgentSeat {
  planName: string;
  listMonthlyUsd: number;
  billedMonthlyUsd: number;
  source: AgentSeatSource;
  note: string | null;
}

/** Public ChatGPT SKU list prices.  Used only after login names the SKU. */
export const CHATGPT_SKU_LIST: Record<string, { planName: string; listMonthlyUsd: number }> = {
  free: { planName: "ChatGPT Free", listMonthlyUsd: 0 },
  go: { planName: "ChatGPT Go", listMonthlyUsd: 8 },
  plus: { planName: "ChatGPT Plus", listMonthlyUsd: 20 },
  pro: { planName: "ChatGPT Pro", listMonthlyUsd: 200 },
  team: { planName: "ChatGPT Team", listMonthlyUsd: 25 },
  business: { planName: "ChatGPT Business", listMonthlyUsd: 25 },
  enterprise: { planName: "ChatGPT Enterprise", listMonthlyUsd: 0 },
};

export const AGENT_SEAT_CATALOG: Record<AgentPlatformId, AgentSeatCatalogEntry> = {
  "claude-code": {
    planName: "Claude Max 20x",
    listMonthlyUsd: 200,
  },
  "openai-codex": {
    planName: "ChatGPT",
    listMonthlyUsd: 0,
    billedNote: "ChatGPT plan is observed from Codex login.  Billed cash waits on a receipt.",
  },
  "cursor-agent": {
    planName: "Cursor Ultra",
    listMonthlyUsd: 200,
    billedMonthlyUsd: 0,
    includedWith: "SuperGrok Heavy",
    billedNote:
      "Cursor Ultra (list $200) is included with SuperGrok Heavy.  Not billed separately.",
  },
  "grok-build": {
    planName: "SuperGrok Heavy",
    listMonthlyUsd: 300,
    billedMonthlyUsd: 100,
    billedNote: "Promo billed $100 for one more month.  List price is $300.",
  },
  "antigravity-cli": {
    planName: "Google AI Ultra",
    listMonthlyUsd: 100,
    billedMonthlyUsd: 70,
    billedNote:
      "$100/mo Google AI Ultra.  $30 of that was already Google One, so $70 net for the AI.",
  },
  "github-copilot": {
    planName: "Not billed",
    listMonthlyUsd: 0,
    billedMonthlyUsd: 0,
    billedNote: "No GitHub Copilot subscription.",
  },
  "minimax-code": {
    planName: "MiniMax Code",
    listMonthlyUsd: 0,
    billedMonthlyUsd: 0,
    billedNote: "MiniMax Code billed cash waits on a receipt.",
  },
};

const PLATFORM_MATCHERS: Record<AgentPlatformId, (haystack: string) => boolean> = {
  "claude-code": (h) => /\banthropic\b|\bclaude\b/.test(h),
  "openai-codex": (h) =>
    /\bcodex\b|\bchatgpt\b/.test(h) ||
    (/\bopenai\b/.test(h) && /\b(plus|pro|team|enterprise|go)\b/.test(h)),
  "cursor-agent": (h) => /\bcursor\b/.test(h),
  "grok-build": (h) =>
    /\bsupergrok\b/.test(h) ||
    (/\bgrok\b/.test(h) && !/\bapi\b/.test(h)) ||
    (/\bxai\b/.test(h) && /\b(super|heavy|plus|premium)\b/.test(h)),
  "antigravity-cli": (h) => /\bantigravity\b/.test(h),
  "github-copilot": (h) => /\bcopilot\b/.test(h),
  "minimax-code": (h) => /\bminimax\b/.test(h),
};

export function isAgentPlatformId(value: string): value is AgentPlatformId {
  return Object.prototype.hasOwnProperty.call(AGENT_SEAT_CATALOG, value);
}

export function chatgptSkuForPlanType(planType: string | null | undefined): {
  planName: string;
  listMonthlyUsd: number;
} | null {
  if (!planType) return null;
  const key = planType.trim().toLowerCase();
  return CHATGPT_SKU_LIST[key] ?? null;
}

function haystackFor(sub: AgentSeatSubscriptionInput): string {
  return `${sub.providerName} ${sub.providerDisplayName} ${sub.name}`.toLowerCase();
}

function monthlyFromSub(sub: AgentSeatSubscriptionInput): number | null {
  if (sub.status.trim().toLowerCase() !== "active") return null;
  if ((sub.currency ?? "USD").trim().toUpperCase() !== "USD") return null;
  if (!Number.isFinite(sub.costUsd) || sub.costUsd < 0) return null;
  const interval = sub.interval.trim().toLowerCase();
  if (
    interval !== "weekly" &&
    interval !== "monthly" &&
    interval !== "quarterly" &&
    interval !== "annual"
  ) {
    return null;
  }
  const monthly = normalizeMonthlyUsd(
    sub.costUsd,
    interval as SubscriptionInterval,
    sub.intervalCount
  );
  return Number.isFinite(monthly) && monthly >= 0 ? monthly : null;
}

/**
 * Receipt / active Subscription wins for billed cash, including a $20 Plus
 * row.  Observed Codex login names the ChatGPT SKU.  Catalog is only a
 * fallback for seats the owner already confirmed (Claude Max, SuperGrok
 * Heavy, Antigravity Ultra) or for $0 / included perks.
 */
export function resolveAgentSeat(
  platformId: AgentPlatformId,
  subscriptions: readonly AgentSeatSubscriptionInput[],
  observed: ObservedAgentPlan | null = null
): ResolvedAgentSeat {
  const catalog = AGENT_SEAT_CATALOG[platformId];
  const matcher = PLATFORM_MATCHERS[platformId];

  let bestMonthly = -1;
  let bestName: string | null = null;
  for (const sub of subscriptions) {
    const monthly = monthlyFromSub(sub);
    if (monthly == null) continue;
    if (!matcher(haystackFor(sub))) continue;
    if (monthly > bestMonthly) {
      bestMonthly = monthly;
      bestName = sub.name.trim() || null;
    }
  }

  if (bestMonthly >= 0) {
    const list = Math.max(catalog.listMonthlyUsd, bestMonthly);
    return {
      planName: bestName || catalog.planName,
      listMonthlyUsd: list,
      billedMonthlyUsd: bestMonthly,
      source: "receipt",
      note:
        bestMonthly + 0.5 < list
          ? catalog.billedNote ??
            `Receipt billed $${Math.round(bestMonthly)} this month.  List price is $${Math.round(list)}.`
          : null,
    };
  }

  if (catalog.includedWith) {
    return {
      planName: catalog.planName,
      listMonthlyUsd: catalog.listMonthlyUsd,
      billedMonthlyUsd: 0,
      source: "included",
      note: catalog.billedNote ?? `Included with ${catalog.includedWith}.  Not billed separately.`,
    };
  }

  if (platformId === "openai-codex") {
    const sku = chatgptSkuForPlanType(observed?.planType);
    if (sku) {
      return {
        planName: sku.planName,
        listMonthlyUsd: sku.listMonthlyUsd,
        billedMonthlyUsd: sku.listMonthlyUsd,
        source: "observed",
        note: `Observed ${sku.planName} from Codex login.  Confirm billed cash with a receipt.`,
      };
    }
    return {
      planName: catalog.planName,
      listMonthlyUsd: 0,
      billedMonthlyUsd: 0,
      source: "unknown",
      note: catalog.billedNote ?? null,
    };
  }

  if (catalog.listMonthlyUsd <= 0 && (catalog.billedMonthlyUsd ?? 0) <= 0) {
    return {
      planName: catalog.planName,
      listMonthlyUsd: 0,
      billedMonthlyUsd: 0,
      source: "unknown",
      note: catalog.billedNote ?? null,
    };
  }

  const list = catalog.listMonthlyUsd;
  const billed = catalog.billedMonthlyUsd ?? list;
  return {
    planName: catalog.planName,
    listMonthlyUsd: list,
    billedMonthlyUsd: billed,
    source: "catalog",
    note: billed + 0.5 < list ? catalog.billedNote ?? null : catalog.billedNote ?? null,
  };
}
