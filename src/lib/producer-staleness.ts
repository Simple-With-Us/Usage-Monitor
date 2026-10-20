import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { sendPushoverNotification } from "@/lib/r2-usage";

/**
 * Per-producer-stream staleness alert (UM-1594).
 *
 * A collector can fail for weeks (UM-1469 sat at HTTP 409 from Sep 17 to Oct 15)
 * while every dashboard simply shows the last good number.  This watches the
 * streams that SHOULD be flowing and sends one Pushover per day when any goes
 * quiet for longer than its allowance.
 *
 * A stream is one (sourceApp, metricType) pair, judged by the newest row's
 * occurredAt.  Allowances are deliberately generous for token-usage streams,
 * which are legitimately silent when nobody is using that tool, and tight for
 * quota streams, which are polled on a timer and should never go quiet.
 * Streams that were retired or renamed are not listed:
 *  - agent-bar -> codecaps (renamed).
 *  - github-copilot: retired.  No ~/.copilot directory or LaunchAgent on the
 *    Mac, and no rows since Sep 24.
 *  - fx: unwatched.  No rows since Sep 16 (the newest event time seen in prod
 *    on Oct 20), collector installed, not watched until usage resumes.  A rule
 *    now would page every day forever.  Add `{ sourceApp: "fx", metricType:
 *    "usage", maxAgeHours: 96 }` when the owner starts using fx again.
 *
 * Allowances for the newer usage streams were measured against prod on
 * 2026-10-20 (UM-1616), as the longest silence between consecutive rows over
 * the weeks the stream has existed:
 *  - deepseek-dsh: used on 36 of the last 60 days.  Longest silences since
 *    Sep 9 are about 108h (Sep 9 to Sep 13) and 88h (Oct 6 to Oct 9), so 120h.
 *  - opencode: first rows Oct 10, so only 10 days of history.  Longest silence
 *    is about 50h over the Oct 17-18 weekend.  96h leaves room for a long
 *    weekend and still fires within four days of a dead collector.
 */
export interface ProducerStreamRule {
  sourceApp: string;
  metricType: string;
  /** Silent longer than this many hours counts as stale. */
  maxAgeHours: number;
}

export const PRODUCER_STREAM_RULES: readonly ProducerStreamRule[] = [
  // Session-token collectors (every 15 min); quiet only when the tool is idle.
  { sourceApp: "openai-codex", metricType: "usage", maxAgeHours: 72 },
  { sourceApp: "grok-build", metricType: "usage", maxAgeHours: 96 },
  { sourceApp: "claude-code", metricType: "usage", maxAgeHours: 48 },
  { sourceApp: "botfleet", metricType: "usage", maxAgeHours: 96 },
  { sourceApp: "deepseek-dsh", metricType: "usage", maxAgeHours: 120 },
  { sourceApp: "opencode", metricType: "usage", maxAgeHours: 96 },
  // Timer-driven quota collectors: a gap here is always a broken collector.
  { sourceApp: "openai-codex", metricType: "quota", maxAgeHours: 6 },
  { sourceApp: "grok-build", metricType: "quota", maxAgeHours: 6 },
  { sourceApp: "minimax-code", metricType: "quota", maxAgeHours: 6 },
  { sourceApp: "antigravity-cli", metricType: "quota", maxAgeHours: 10 },
  { sourceApp: "codecaps", metricType: "quota", maxAgeHours: 6 },
  { sourceApp: "claude-code", metricType: "quota", maxAgeHours: 48 },
];

export const PRODUCER_STALENESS_FLAG_FILENAME = "producer-staleness-last-alert.json";
const CHECK_MIN_INTERVAL_MS = 60 * 60 * 1000;

export interface StaleProducerStream extends ProducerStreamRule {
  /** ISO timestamp of the newest row, or null when the stream has no rows. */
  lastSeenAt: string | null;
  ageHours: number | null;
}

export interface ProducerStalenessResult {
  checkedAt: string;
  stale: StaleProducerStream[];
  alertSent: boolean;
  skipped?: "throttled" | "disabled";
}

export function assessStreamAge(
  rule: ProducerStreamRule,
  lastSeen: Date | null,
  now: Date
): StaleProducerStream | null {
  if (!lastSeen) {
    return { ...rule, lastSeenAt: null, ageHours: null };
  }
  const ageHours = (now.getTime() - lastSeen.getTime()) / 3_600_000;
  if (ageHours <= rule.maxAgeHours) return null;
  return {
    ...rule,
    lastSeenAt: lastSeen.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

export async function findStaleProducerStreams(
  now: Date = new Date(),
  rules: readonly ProducerStreamRule[] = PRODUCER_STREAM_RULES
): Promise<StaleProducerStream[]> {
  const stale: StaleProducerStream[] = [];
  for (const rule of rules) {
    const latest = await prisma.externalUsageEvent.findFirst({
      where: { sourceApp: rule.sourceApp, metricType: rule.metricType },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });
    const finding = assessStreamAge(rule, latest?.occurredAt ?? null, now);
    if (finding) stale.push(finding);
  }
  return stale;
}

export function formatStaleStreamsMessage(stale: readonly StaleProducerStream[]): {
  title: string;
  body: string;
} {
  const lines = stale.map((s) =>
    s.lastSeenAt
      ? `${s.sourceApp} ${s.metricType}: quiet ${s.ageHours}h (limit ${s.maxAgeHours}h), last ${s.lastSeenAt}`
      : `${s.sourceApp} ${s.metricType}: no rows at all`
  );
  return {
    title: `Usage Monitor: ${stale.length} producer stream${stale.length === 1 ? "" : "s"} quiet`,
    body: lines.join("\n"),
  };
}

let lastCheckAtMs = 0;
let inMemoryFlag: { date: string; signature: string } | null = null;

function flagPath(): string {
  const base =
    process.env.USAGE_MONITOR_DATA_DIR?.trim() ||
    process.env.DATABASE_URL?.replace(/^file:/, "").replace(/\/[^/]+$/, "") ||
    process.cwd();
  return path.join(base, PRODUCER_STALENESS_FLAG_FILENAME);
}

function readFlag(): { date: string; signature: string } | null {
  if (inMemoryFlag) return inMemoryFlag;
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath(), "utf8")) as {
      date?: string;
      signature?: string;
    };
    if (typeof parsed.date === "string" && typeof parsed.signature === "string") {
      inMemoryFlag = { date: parsed.date, signature: parsed.signature };
    }
  } catch {
    // absent file is normal
  }
  return inMemoryFlag;
}

function writeFlag(date: string, signature: string): void {
  inMemoryFlag = { date, signature };
  try {
    fs.writeFileSync(flagPath(), JSON.stringify({ date, signature, sentAt: new Date().toISOString() }), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.error("[producer-staleness] Failed saving last alert flag:", error);
  }
}

export function resetProducerStalenessForTests(): void {
  lastCheckAtMs = 0;
  inMemoryFlag = null;
}

/**
 * Maintenance stage: at most one DB sweep per hour, and at most one Pushover
 * per UTC day for an unchanged set of stale streams.  A newly stale stream
 * re-alerts the same day; a recovered stream just drops out of the set.
 */
export async function runProducerStalenessCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<ProducerStalenessResult> {
  const checkedAt = now.toISOString();
  if (process.env.USAGE_PRODUCER_STALENESS_DISABLED === "1") {
    return { checkedAt, stale: [], alertSent: false, skipped: "disabled" };
  }
  if (now.getTime() - lastCheckAtMs < CHECK_MIN_INTERVAL_MS) {
    return { checkedAt, stale: [], alertSent: false, skipped: "throttled" };
  }
  lastCheckAtMs = now.getTime();

  const stale = await findStaleProducerStreams(now);
  if (stale.length === 0) return { checkedAt, stale, alertSent: false };

  const today = checkedAt.slice(0, 10);
  const signature = stale
    .map((s) => `${s.sourceApp}:${s.metricType}`)
    .sort()
    .join(",");
  const last = readFlag();
  if (last && last.date === today && last.signature === signature) {
    return { checkedAt, stale, alertSent: false };
  }

  const { title, body } = formatStaleStreamsMessage(stale);
  const result = await sendPushoverNotification(title, body, 0, fetchImpl, { subject: "um" });
  if (result.ok) writeFlag(today, signature);
  return { checkedAt, stale, alertSent: result.ok };
}
