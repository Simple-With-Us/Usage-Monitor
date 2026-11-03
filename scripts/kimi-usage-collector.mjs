#!/usr/bin/env node
// Exact Kimi Code per-turn token collector.
//
// Kimi persists durable `usage.record` events under
// ~/.kimi-code/sessions/*/*/agents/*/wire.jsonl.  Only turn-scope rows are
// deltas; session-scope rows are cumulative and are deliberately ignored.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { flushCollectorSentry } from "./lib/collector-sentry-bridge.mjs";
import {
  KIMI_PRODUCER_ID,
  parseKimiSessionIndexJsonl,
  parseKimiUsageJsonl,
  projectNameFromDirectory,
} from "./lib/kimi-zcode-telemetry.mjs";
import { filterEventsSince, postUsageBatches } from "./lib/session-token-collectors.mjs";
import {
  canAdvanceCollectorCheckpoint,
  expandHome,
  fileMayContainEventsSince,
  isBotFleetSessionPath,
  readIfFresh,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const PRODUCER_ID = KIMI_PRODUCER_ID;
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";
const DEBUG = process.argv.includes("--debug");

function log(message) {
  console.log(`[kimi-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[kimi-usage-collector] ${message}`);
  process.exit(code);
}

export function defaultKimiCodeHome(env = process.env) {
  return expandHome(env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"));
}

export function kimiWireIdentity(sessionsRoot, filePath) {
  const sessionKey = sessionKeyFor(sessionsRoot, filePath);
  const parts = sessionKey.split("/");
  const agentsIndex = parts.lastIndexOf("agents");
  return {
    sessionKey,
    sessionId: agentsIndex >= 2 ? parts[agentsIndex - 1] : undefined,
    agentId: agentsIndex >= 0 ? parts[agentsIndex + 1] : undefined,
  };
}

async function readSessionIndex(home) {
  try {
    return parseKimiSessionIndexJsonl(await readFile(join(home, "session_index.jsonl"), "utf8"));
  } catch {
    return new Map();
  }
}

export async function collectKimiEvents({
  home = defaultKimiCodeHome(),
  since,
  scanStatus = { complete: true },
  env = process.env,
} = {}) {
  const sessionsRoot = join(home, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const workDirBySession = await readSessionIndex(home);
  const files = await walkFiles(sessionsRoot, {
    name: "wire.jsonl",
    onTraversalError: () => {
      scanStatus.complete = false;
    },
  });
  files.sort();
  const events = [];
  for (const filePath of files) {
    const fresh = await fileMayContainEventsSince(filePath, since, {
      onStatError: () => {
        scanStatus.complete = false;
      },
    });
    if (!fresh) continue;
    const text = await readIfFresh(filePath, {
      onReadError: () => {
        scanStatus.complete = false;
      },
    });
    if (text === null) continue;
    const identity = kimiWireIdentity(sessionsRoot, filePath);
    const workDir = identity.sessionId ? workDirBySession.get(identity.sessionId) : undefined;
    events.push(
      ...filterEventsSince(
        parseKimiUsageJsonl(text, {
          ...identity,
          project: projectNameFromDirectory(workDir),
          botFleetManaged: typeof workDir === "string" && isBotFleetSessionPath(workDir, env),
        }),
        since,
      ),
    );
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
  const home = defaultKimiCodeHome();
  const sourceAvailable = existsSync(join(home, "sessions"));
  const scanStatus = { complete: true };
  const events = await collectKimiEvents({ home, since: args.since, scanStatus });
  log(
    `parsed ${events.length} event(s) since ${args.since.toISOString()}${args.resumedFromState ? " (incremental)" : ""}`,
  );
  if (DEBUG) {
    const models = [...new Set(events.map((event) => event.producerKeyRef).filter(Boolean))];
    log(`models: ${models.join(", ") || "(none)"}`);
  }
  if (!sourceAvailable) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: args.dryRun, log });
    log(`source directory is absent under ${home}; checkpoint unchanged`);
    return;
  }
  if (events.length === 0) {
    await flushCollectorSentry({ producerId: PRODUCER_ID, dryRun: args.dryRun, log });
    log("nothing to send");
    if (canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
    return;
  }
  const token = resolveCollectorToken([
    "KIMI_CODE_INGEST_TOKEN",
    "KIMI_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl: INGEST_URL,
      ingestToken: token,
      producerId: PRODUCER_ID,
      dryRun: args.dryRun,
      log,
    });
    log(
      `ingest ack: ${JSON.stringify({ received: ack.received, persisted: ack.persisted, rejected: ack.rejected, dryRun: ack.dryRun ?? false })}`,
    );
    if (ack.rejected > 0) fail(`Ingest reported rejections: ${ack.rejected}`);
    if (canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete })) {
      await recordCollectorSuccess(PRODUCER_ID, passStartedAt);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
