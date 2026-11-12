/**
 * Public OpenRouter credit + per-key limit probe for external uptime monitors.
 *
 * Owner-directed: Usage Monitor (not app /api/health) owns the real money check
 * via a Management key — account prepaid remaining (/credits) and every key's
 * spend limit_remaining (/keys). UptimeRobot watches a dedicated endpoint with
 * keyword `"openrouterCredits":{"ok":false`. Fail-open on read errors so we
 * never page on our own inability to reach OpenRouter.
 */

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { fetchUsage } from "@/lib/adapters/openrouter";

const DEFAULT_ACCOUNT_THRESHOLD_USD = 3;
const DEFAULT_KEY_LIMIT_THRESHOLD_USD = 3;
const DEFAULT_CACHE_MS = 10 * 60_000;

export type OpenRouterCreditReason =
  | "account_low"
  | "key_limit_reached"
  | "key_limit_low"
  | "not_management_key";

export interface OpenRouterCreditProbeResult {
  /** false ONLY when balance/limits were read and a real low/exhausted condition is present. */
  ok: boolean;
  /** false when no key is configured — no signal for the monitor to alert on. */
  configured: boolean;
  remainingUsd: number | null;
  totalUsd: number | null;
  usedUsd: number | null;
  thresholdUsd: number;
  keyLimitThresholdUsd: number;
  source: "management" | "inference" | "none";
  keysChecked: boolean;
  keysWithLimit: number;
  keysLimitReached: number;
  keysLimitLow: number;
  reasons: OpenRouterCreditReason[];
  checkedAt: string;
  error?: string;
}

let cache: { result: OpenRouterCreditProbeResult; atMs: number } | null = null;

function numEnv(name: string, fallback: number, min: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

function accountThresholdUsd(): number {
  return numEnv("OPENROUTER_LOW_CREDIT_USD", DEFAULT_ACCOUNT_THRESHOLD_USD, 0);
}

function keyLimitThresholdUsd(): number {
  return numEnv("OPENROUTER_KEY_LIMIT_LOW_USD", DEFAULT_KEY_LIMIT_THRESHOLD_USD, 0);
}

function cacheMs(): number {
  return numEnv("OPENROUTER_CREDIT_CHECK_INTERVAL_MS", DEFAULT_CACHE_MS, 30_000);
}

/** Test seam. */
export function __resetOpenRouterCreditProbeCache(): void {
  cache = null;
}

/**
 * Prefer OPENROUTER_MANAGEMENT_KEY / OPENROUTER_ADMIN_KEY, else a Provider
 * row labeled management/admin/provisioning, else oldest active openrouter key.
 * Same policy as openrouter-generation-verification.
 */
export async function resolveOpenRouterProbeKey(): Promise<string | null> {
  for (const envName of ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_ADMIN_KEY"] as const) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
  }

  const providers = await prisma.provider.findMany({
    where: { name: "openrouter", isActive: true, apiKey: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { apiKey: true, label: true, displayName: true },
  });
  if (providers.length === 0) return null;

  const preferred =
    providers.find((provider) =>
      /management|admin|provisioning/i.test(
        `${provider.label ?? ""} ${provider.displayName ?? ""}`
      )
    ) ?? providers[0];

  if (!preferred.apiKey) return null;
  try {
    return decrypt(preferred.apiKey);
  } catch {
    return null;
  }
}

type KeyLike = {
  name?: string | null;
  label?: string | null;
  disabled?: boolean;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
};

function isIgnoredKeyLabel(labelOrName?: string | null): boolean {
  if (!labelOrName) return false;
  const lower = labelOrName.toLowerCase();
  return (
    lower.includes("onboarding") ||
    lower.includes("test") ||
    lower.includes("demo") ||
    lower.includes("temp") ||
    lower.includes("sample")
  );
}

function evaluateKeys(
  keys: KeyLike[],
  keyFloor: number
): {
  keysWithLimit: number;
  keysLimitReached: number;
  keysLimitLow: number;
  reasons: OpenRouterCreditReason[];
} {
  let keysWithLimit = 0;
  let keysLimitReached = 0;
  let keysLimitLow = 0;
  const reasons = new Set<OpenRouterCreditReason>();

  for (const k of keys) {
    if (k.disabled) continue;
    if (isIgnoredKeyLabel(k.label) || isIgnoredKeyLabel(k.name)) continue;
    if (k.limitUsd == null || k.limitUsd <= 0) continue;
    if (k.limitRemainingUsd == null) continue;
    keysWithLimit += 1;
    const rem = k.limitRemainingUsd;
    if (rem <= 0) {
      keysLimitReached += 1;
      reasons.add("key_limit_reached");
    } else if (rem < keyFloor) {
      keysLimitLow += 1;
      reasons.add("key_limit_low");
    }
  }

  return {
    keysWithLimit,
    keysLimitReached,
    keysLimitLow,
    reasons: [...reasons],
  };
}

/**
 * Cached probe result. Never throws. Public surface must keep
 * `openrouterCredits.ok` as the first key of that object for UptimeRobot.
 */
export async function probeOpenRouterCredits(
  nowMs: number = Date.now()
): Promise<OpenRouterCreditProbeResult> {
  if (cache && nowMs - cache.atMs < cacheMs()) return cache.result;

  const accountThreshold = accountThresholdUsd();
  const keyFloor = keyLimitThresholdUsd();
  const checkedAt = new Date(nowMs).toISOString();

  const unconfigured = (): OpenRouterCreditProbeResult => ({
    ok: true,
    configured: false,
    remainingUsd: null,
    totalUsd: null,
    usedUsd: null,
    thresholdUsd: accountThreshold,
    keyLimitThresholdUsd: keyFloor,
    source: "none",
    keysChecked: false,
    keysWithLimit: 0,
    keysLimitReached: 0,
    keysLimitLow: 0,
    reasons: [],
    checkedAt,
  });

  const failOpen = (error: string): OpenRouterCreditProbeResult => {
    if (cache) return cache.result;
    return {
      ok: true,
      configured: true,
      remainingUsd: null,
      totalUsd: null,
      usedUsd: null,
      thresholdUsd: accountThreshold,
      keyLimitThresholdUsd: keyFloor,
      source: "none",
      keysChecked: false,
      keysWithLimit: 0,
      keysLimitReached: 0,
      keysLimitLow: 0,
      reasons: [],
      checkedAt,
      error,
    };
  };

  let apiKey: string | null;
  try {
    apiKey = await resolveOpenRouterProbeKey();
  } catch (error) {
    return failOpen(error instanceof Error ? error.message : "key resolve failed");
  }
  if (!apiKey) return unconfigured();

  try {
    const usage = await fetchUsage(apiKey);
    const raw = (usage.rawData ?? {}) as Record<string, unknown>;
    const capabilities = (raw.capabilities ?? {}) as Record<string, unknown>;
    const isManagement = capabilities.managementKeyConfirmed === true;
    const source: "management" | "inference" = isManagement ? "management" : "inference";

    // Account prepaid remaining — management keys populate balance/credits via /credits.
    let remainingUsd: number | null = usage.balance;
    let totalUsd: number | null = usage.credits;
    let usedUsd: number | null = null;
    if (totalUsd != null && remainingUsd != null) {
      usedUsd = Math.round((totalUsd - remainingUsd) * 1e6) / 1e6;
    }

    // Inference-only path: /key self-report may still have limitRemainingUsd on keyInfo.
    const keyInfo = (raw.keyInfo ?? {}) as Record<string, unknown>;
    if (remainingUsd == null && typeof keyInfo.limitRemainingUsd === "number") {
      // Not account balance — leave remaining null; per-key self-limit handled below.
    }

    const reasons: OpenRouterCreditReason[] = [];
    let keysChecked = false;
    let keysWithLimit = 0;
    let keysLimitReached = 0;
    let keysLimitLow = 0;

    if (isManagement && Array.isArray(raw.keys)) {
      keysChecked = true;
      const evald = evaluateKeys(raw.keys as KeyLike[], keyFloor);
      keysWithLimit = evald.keysWithLimit;
      keysLimitReached = evald.keysLimitReached;
      keysLimitLow = evald.keysLimitLow;
      reasons.push(...evald.reasons);
    } else if (!isManagement) {
      // Self-key limit only when we lack management enumeration.
      const selfRemaining =
        typeof keyInfo.limitRemainingUsd === "number" ? keyInfo.limitRemainingUsd : null;
      if (selfRemaining != null) {
        keysChecked = true;
        keysWithLimit = 1;
        if (selfRemaining <= 0) {
          keysLimitReached = 1;
          reasons.push("key_limit_reached");
        } else if (selfRemaining < keyFloor) {
          keysLimitLow = 1;
          reasons.push("key_limit_low");
        }
      }
    }

    if (remainingUsd != null && remainingUsd < accountThreshold) {
      reasons.push("account_low");
    }

    const result: OpenRouterCreditProbeResult = {
      ok: reasons.length === 0,
      configured: true,
      remainingUsd,
      totalUsd,
      usedUsd,
      thresholdUsd: accountThreshold,
      keyLimitThresholdUsd: keyFloor,
      source,
      keysChecked,
      keysWithLimit,
      keysLimitReached,
      keysLimitLow,
      reasons,
      checkedAt,
      ...(!isManagement && remainingUsd == null
        ? {
            error:
              "OpenRouter management key required for account-wide /credits; only this key's own limit was inspected",
          }
        : {}),
    };

    cache = { result, atMs: nowMs };
    return result;
  } catch (error) {
    return failOpen(error instanceof Error ? error.message : "openrouter probe failed");
  }
}

/**
 * Public JSON projection for UptimeRobot. `openrouterCredits.ok` is always the
 * first key of that object so the keyword `"openrouterCredits":{"ok":false` is stable.
 * USD figures are omitted from the public body (operator can use dashboard / poll).
 */
export function toPublicOpenRouterCreditProbe(
  probe: OpenRouterCreditProbeResult
): Record<string, unknown> {
  // Build openrouterCredits with ok first (insertion order).
  const openrouterCredits: Record<string, unknown> = {
    ok: probe.ok,
  };
  if (!probe.configured) {
    openrouterCredits.configured = false;
  } else {
    openrouterCredits.configured = true;
    openrouterCredits.thresholdUsd = probe.thresholdUsd;
    openrouterCredits.keyLimitThresholdUsd = probe.keyLimitThresholdUsd;
    openrouterCredits.source = probe.source;
    openrouterCredits.keysChecked = probe.keysChecked;
    openrouterCredits.keysWithLimit = probe.keysWithLimit;
    openrouterCredits.keysLimitReached = probe.keysLimitReached;
    openrouterCredits.keysLimitLow = probe.keysLimitLow;
    openrouterCredits.reasons = probe.reasons;
    openrouterCredits.checkedAt = probe.checkedAt;
    if (probe.error) openrouterCredits.error = probe.error;
  }

  return {
    // Top-level ok is the HTTP-level probe health (always true when we responded).
    // The money signal lives under openrouterCredits.ok for the keyword monitor.
    ok: true,
    service: "usage-monitor-openrouter-credits",
    openrouterCredits,
  };
}
