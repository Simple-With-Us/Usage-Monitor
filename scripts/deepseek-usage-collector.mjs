#!/usr/bin/env node
// Local collector for DeepSeek Harness (DSH) session archives.
//
// Reads ~/.dsh/sessions and ~/.clutch/dsh/sessions session.jsonl.zstd and
// session.v3.jsonl.zstd assistant/message records and sends exact
// input/output/cache-read token counts plus model attribution, provider,
// harness, billing mode and per-step duration.
// BotFleet-managed child sessions can be excluded after BotFleet's durable
// sender is deployed.  API-equivalent analytics only.
//
// Usage:
//   node scripts/deepseek-usage-collector.mjs [--dry-run] [--debug] [--days N] [--since ISO]

// Env:
//   USAGE_INGEST_TOKEN or DEEPSEEK_INGEST_TOKEN
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   DSH_HOME (default ~/.dsh)
//   CLUTCH_DSH_HOME (default ~/.clutch/dsh)
//   ZSTD_BIN (default /opt/homebrew/bin/zstd)


import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DEEPSEEK_PRODUCER_ID,
  DSH_LEGACY_PRODUCER_INSTANCE_ID,
  filterEventsSince,
  parseDeepSeekSessionJsonl,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import {
  botFleetChildExclusionEnabled,
  canAdvanceCollectorCheckpoint,
  expandHome,
  isBotFleetSessionPath,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const execFileAsync = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const PRODUCER_ID = process.env.DEEPSEEK_PRODUCER_ID || DEEPSEEK_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[deepseek-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[deepseek-usage-collector] ${message}`);
  process.exit(code);
}

async function decompress(path) {
  const zstdBin = process.env.ZSTD_BIN || "/opt/homebrew/bin/zstd";
  const { stdout } = await execFileAsync(zstdBin, ["-dc", path], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

function defaultHomes() {
  return [
    {
      home: expandHome(process.env.DSH_HOME || join(homedir(), ".dsh")),
      harness: "dsh",
    },
    {
      // Clutch bundles DSH and keeps its own session store.
      home: expandHome(process.env.CLUTCH_DSH_HOME || join(homedir(), ".clutch", "dsh")),
      harness: "clutch",
    },
  ];
}

const SESSION_FILE_NAMES = new Set(["session.jsonl.zstd", "session.v3.jsonl.zstd"]);

export async function collectDeepSeekEvents({
  homes,
  dshHome,
  since,
  scanStatus,
} = {}) {
  const markIncomplete = () => {
    if (scanStatus) scanStatus.complete = false;
  };
  const roots = homes ?? (dshHome ? [{ home: dshHome, harness: "dsh" }] : defaultHomes());
  // v1 (session.jsonl.zstd) archives are read before their v3 twins so the
  // pre-v3 event shape wins for messages that production already holds.
  const seenMessageIds = new Set();
  const events = [];
  for (const { home, harness } of roots) {
    const files = await walkFiles(join(home, "sessions"), {
      suffix: ".jsonl.zstd",
      onTraversalError: markIncomplete,
    });
    const archives = files
      .filter((file) => SESSION_FILE_NAMES.has(basename(file)))
      .sort((a, b) => {
        const av3 = basename(a) === "session.v3.jsonl.zstd" ? 1 : 0;
        const bv3 = basename(b) === "session.v3.jsonl.zstd" ? 1 : 0;
        return av3 - bv3 || (a < b ? -1 : a > b ? 1 : 0);
      });
    const freshDirs = new Set();
    const stats = new Map();
    for (const file of archives) {
      try {
        const fileStat = await stat(file);
        stats.set(file, fileStat);
        if (!since || fileStat.mtime >= since) freshDirs.add(dirname(file));
      } catch {
        markIncomplete();
      }
    }
    for (const file of archives) {
      if (botFleetChildExclusionEnabled() && isBotFleetSessionPath(file)) continue;
      // Read a stale v1 archive only when its v3 twin is fresh, so message
      // ids already ingested from the v1 shape are not re-emitted from v3.
      if (!stats.has(file) || !freshDirs.has(dirname(file))) continue;
      try {
        const text = await decompress(file);
        const isV1 = basename(file) === "session.jsonl.zstd";
        const parsed = parseDeepSeekSessionJsonl(text, {
          sessionKey: sessionKeyFor(home, dirname(file)),
          legacySessionKey: isV1 ? sessionKeyFor(home, file) : undefined,
          seenMessageIds,
          harness,
        });
        events.push(...filterEventsSince(parsed, since));
      } catch (error) {
        if (scanStatus) scanStatus.complete = false;
        if (DEBUG) log(`skipped unreadable archive (${error instanceof Error ? error.name : "error"})`);
      }
    }
  }
  return events;
}

async function main() {
  const passStartedAt = new Date();
  let args;
  try {
    args = await resolveCollectorArgs(process.argv, PRODUCER_ID, { now: passStartedAt });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const scanStatus = { complete: true };
  const events = await collectDeepSeekEvents({ since: args.since, scanStatus });
  log(`parsed ${events.length} token event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`);
  if (DEBUG) {
    const models = new Set(events.map((event) => event.producerKeyRef).filter(Boolean));
    log(`models: ${[...models].join(", ") || "(none)"}`);
  }
  if (events.length === 0) {
    log("nothing to send");
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken([
    "DEEPSEEK_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
  try {
    // Pre-v3 shaped events replay under the instance id they were first
    // stored with; everything else uses this machine's id.
    const legacyEvents = events.filter((event) => !event.metadata?.harness);
    const currentEvents = events.filter((event) => event.metadata?.harness);
    const acks = [];
    for (const [batchEvents, producerInstanceId] of [
      [legacyEvents, DSH_LEGACY_PRODUCER_INSTANCE_ID],
      [currentEvents, undefined],
    ]) {
      if (batchEvents.length === 0) continue;
      acks.push(
        await postUsageBatches({
          events: batchEvents,
          ingestUrl: INGEST_URL,
          ingestToken: token,
          producerId: PRODUCER_ID,
          producerInstanceId,
          dryRun: DRY || args.dryRun,
          log,
        }),
      );
    }
    const ack = acks.reduce(
      (sum, part) => ({
        received: sum.received + part.received,
        persisted: sum.persisted + part.persisted,
        rejected: sum.rejected + part.rejected,
        dryRun: sum.dryRun || Boolean(part.dryRun),
      }),
      { received: 0, persisted: 0, rejected: 0, dryRun: false },
    );
    log(`ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`);
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
    if (!DRY && canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
