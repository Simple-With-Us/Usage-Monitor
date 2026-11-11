#!/usr/bin/env node
// Collects MiniMax Token Plan quota windows from the official mmx CLI.
// Quota percentages are actual plan telemetry.  They are not token counts,
// API-equivalent cost, or proof of cash billing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { postUsageBatches } from "./lib/session-token-collectors.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";

const execFileAsync = promisify(execFile);
const PRODUCER_ID = "minimax-code";
const INGEST_URL = process.env.USAGE_MONITOR_INGEST_URL || "https://usage.jays.services/api/ingest/usage";
const DRY = process.argv.includes("--dry-run");

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function isoFromEpoch(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return new Date(number > 1e12 ? number : number * 1000).toISOString();
}

export function quotaEventsFromMiniMax(payload, observedAt = new Date()) {
  const rows = Array.isArray(payload?.model_remains) ? payload.model_remains : [];
  const events = [];
  const observedIso = observedAt.toISOString();
  for (const row of rows) {
    const model = typeof row?.model_name === "string" ? row.model_name.trim() : "";
    if (!model) continue;
    for (const window of [
      {
        name: "rolling",
        remaining: row.current_interval_remaining_percent,
        end: row.end_time,
        duration: "rolling",
      },
      {
        name: "weekly",
        remaining: row.current_weekly_remaining_percent,
        end: row.weekly_end_time,
        duration: "week",
      },
    ]) {
      const remaining = finitePercent(window.remaining);
      if (remaining == null) continue;
      const resetAt = isoFromEpoch(window.end, observedAt.toISOString());
      events.push({
        eventId: `minimax-quota:${model}:${window.name}:${resetAt}:${observedIso}`,
        provider: "minimax",
        service: "minimax-code",
        producerKeyRef: model,
        label: `${model} (${window.name})`,
        metricType: "quota",
        limit: 100,
        credits: remaining,
        billingMode: "actual",
        confidence: "actual",
        occurredAt: observedIso,
        metadata: {
          model,
          quotaWindow: window.duration,
          resetAt,
          scale: "percent_0_100",
          percentUsed: Number((100 - remaining).toFixed(2)),
        },
      });
    }
  }
  return events;
}

function log(message) {
  console.log(`[minimax-usage-collector] ${message}`);
}

async function main() {
  const mmx = process.env.MMX_BIN || "/opt/homebrew/bin/mmx";
  const { stdout } = await execFileAsync(
    mmx,
    ["quota", "show", "--output", "json", "--non-interactive"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
  );
  const payload = JSON.parse(stdout);
  if (payload?.base_resp?.status_code !== 0) throw new Error("MiniMax quota request failed");
  const events = quotaEventsFromMiniMax(payload);
  log(`parsed ${events.length} quota event(s)`);
  if (events.length === 0) return;
  const token = resolveCollectorToken(["MINIMAX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
  const ack = await postUsageBatches({
    events,
    ingestUrl: INGEST_URL,
    ingestToken: token,
    producerId: PRODUCER_ID,
    dryRun: DRY,
    log,
  });
  log(`ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`);
  if (ack.rejected > 0) throw new Error(`Ingest reported rejections: ${ack.rejected}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[minimax-usage-collector] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
