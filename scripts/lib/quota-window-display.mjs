/**
 * Shared quota window key + display labels (Jay-approved 2026-10-12).
 * Keep in sync with src/lib/quota-window-display.ts.
 */

const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
};

const UNIT_SUFFIX = { hour: "h", day: "d", week: "w", month: "mo" };

/** "five_hour" -> "5h", "seven_day" -> "7d".  Unknown keys return null. */
export function claudeAnthropicKeyToToken(key) {
  const match = /^([a-z]+)_(hour|day|week|month)s?/.exec(String(key));
  if (!match) return null;
  const count = WORD_NUMBERS[match[1]] ?? Number(match[1]);
  if (!Number.isFinite(count)) return null;
  return `${count}${UNIT_SUFFIX[match[2]]}`;
}

const CLAUDE_MODEL_SUFFIXES = ["opus", "sonnet", "haiku"];

/**
 * Normalize a Claude / Anthropic API window key to a stable merge key.
 * @returns {{ windowKey: string, rawKey: string }}
 */
export function normalizeQuotaWindowKeyFromAnthropicKey(key, suffixModel = null) {
  const rawKey = String(key);
  let baseKey = rawKey;
  let model = suffixModel;
  if (!model) {
    for (const suffix of CLAUDE_MODEL_SUFFIXES) {
      if (rawKey.endsWith(`_${suffix}`)) {
        model = suffix;
        baseKey = rawKey.slice(0, -(suffix.length + 1));
        break;
      }
    }
  }
  const token = claudeAnthropicKeyToToken(baseKey) ?? claudeAnthropicKeyToToken(rawKey);
  if (token === "5h" || token === "5-hour") {
    return { windowKey: "5h", rawKey };
  }
  if (token === "7d" || token === "weekly") {
    return { windowKey: "7d", rawKey };
  }
  if (token && /^\d+[hdwmo]+$/.test(token)) {
    return { windowKey: token, rawKey };
  }
  if (/^plan$/i.test(rawKey) || /^included[_\s-]?plan$/i.test(rawKey)) {
    return { windowKey: "plan", rawKey };
  }
  return { windowKey: `other:${rawKey}`, rawKey };
}

function inferResetPeriodLabel(resetAtIso, nowMs) {
  if (!resetAtIso) return "soon";
  const resetMs = Date.parse(resetAtIso);
  if (!Number.isFinite(resetMs)) return "soon";
  const diffHours = Math.max(0, (resetMs - nowMs) / 3_600_000);
  if (diffHours <= 6) return "5-hour";
  if (diffHours <= 36) return "1-day";
  if (diffHours <= 10 * 24) return "7-day";
  if (diffHours <= 35 * 24) return "1-month";
  return "later";
}

export function windowKeyToDisplayLabel(windowKey) {
  if (windowKey === "5h" || windowKey === "5-hour") return "5-hour";
  if (windowKey === "7d" || windowKey === "7d:opus" || windowKey === "weekly") return "7-day";
  if (windowKey === "monthly") return "1-month";
  if (windowKey === "plan") return "plan";
  const hours = /^(\d+)h$/.exec(windowKey);
  if (hours) return `${hours[1]}-hour`;
  const days = /^(\d+)d$/.exec(windowKey);
  if (days) return `${days[1]}-day`;
  const months = /^(\d+)mo$/.exec(windowKey);
  if (months) return `${months[1]}-month`;
  if (windowKey.startsWith("other:")) return "other-limit";
  return windowKey;
}

export function quotaWindowDisplayName({ windowKey, rawKey, resetAt = null, nowMs = Date.now() }) {
  if (windowKey.startsWith("other:")) {
    const period = inferResetPeriodLabel(resetAt, nowMs);
    return `other-limit · resets ${period}`;
  }
  const label = windowKeyToDisplayLabel(windowKey);
  if (label !== windowKey || windowKey === "5h" || windowKey === "7d") return label;
  if (rawKey && label === "other-limit") {
    return `other-limit · resets ${inferResetPeriodLabel(resetAt, nowMs)}`;
  }
  return label;
}

/** Normalize quotaWindow / bucketId / label into merge windowKey + rawKey. */
export function normalizeQuotaWindowKey({
  quotaWindow = null,
  bucketId = null,
  label = null,
  modelId = null,
} = {}) {
  const bucket = bucketId ? String(bucketId) : "";
  const colonIdx = bucket.indexOf(":");
  const bucketTail = colonIdx >= 0 ? bucket.slice(colonIdx + 1) : bucket;
  if (bucketTail && bucketTail.includes("_")) {
    return normalizeQuotaWindowKeyFromAnthropicKey(bucketTail, modelId);
  }
  const qw = quotaWindow ? String(quotaWindow).trim().toLowerCase() : "";
  if (qw === "5h" || qw === "5-hour") return { windowKey: "5h", rawKey: qw || "five_hour" };
  if (qw === "7d" || qw === "weekly") {
    return { windowKey: "7d", rawKey: qw };
  }
  if (qw) return { windowKey: qw, rawKey: qw };
  const labelStr = label ? String(label).trim() : "";
  if (/^5h\b/i.test(labelStr) || /5[- ]?hour/i.test(labelStr)) {
    return { windowKey: "5h", rawKey: "five_hour" };
  }
  if (/^7d\b/i.test(labelStr) || /\bweekly\b/i.test(labelStr)) {
    return { windowKey: "7d", rawKey: "seven_day" };
  }
  if (/included plan/i.test(labelStr) || /^plan$/i.test(labelStr)) {
    return { windowKey: "plan", rawKey: "plan" };
  }
  if (bucketTail) return normalizeQuotaWindowKeyFromAnthropicKey(bucketTail, modelId);
  return { windowKey: "other:unknown", rawKey: labelStr || "unknown" };
}

export function rollupQuotaWindowKey(windowKey) {
  if (windowKey === "7d:opus") return "7d";
  return windowKey;
}

export function antigravityQuotaPool({ label = null, modelId = null, bucketId = null, modelGroup = null } = {}) {
  const hay = [label, modelId, bucketId, modelGroup].filter(Boolean).join(" ").toLowerCase();
  if (hay.includes("gemini")) return "gemini";
  return "third-party";
}

export function antigravityPlatformCardTitle(pool) {
  return pool === "gemini" ? "Antigravity · Gemini" : "Antigravity · Third-Party";
}
