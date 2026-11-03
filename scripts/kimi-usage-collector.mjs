#!/usr/bin/env node
// Exact Kimi Code per-turn token collector.
//
// Kimi persists durable `usage.record` events under
// ~/.kimi-code/sessions/*/*/agents/*/wire.jsonl.  Only turn-scope rows are
// deltas; session-scope rows are cumulative and are deliberately ignored.

import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  collectorStatePath,
  configureCollectorSentryToken,
  expandHome,
  fileMayContainEventsSince,
  isBotFleetSessionPath,
  recordCollectorSuccess,
  resolveCollectorArgs,
  resolveCollectorToken,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";

const PRODUCER_ID = KIMI_PRODUCER_ID;
const EARLIEST_REPLAY_SINCE = new Date(0).toISOString();
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

async function readSessionIndex(home, { onReadError } = {}) {
  try {
    return parseKimiSessionIndexJsonl(await readFile(join(home, "session_index.jsonl"), "utf8"));
  } catch (error) {
    onReadError?.(error);
    return null;
  }
}

export async function readPendingSessions(stateRoot, { readMarker = readFile } = {}) {
  const directory = `${collectorStatePath(PRODUCER_ID, stateRoot, "pending")}.d`;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const pending = new Map();
  for (const dirent of entries) {
    if (!dirent.name.endsWith(".json")) continue;
    if (!dirent.isFile()) throw new Error("Kimi pending-session marker is not a regular file");
    const markerPath = join(directory, dirent.name);
    // A concurrently removed generation may contain the earliest boundary.
    // Fail this pass rather than interpreting a partial snapshot as complete.
    const entry = JSON.parse(await readMarker(markerPath, "utf8"));
    if (
      entry?.version !== 1 ||
      !isCanonicalPendingFile(entry?.file) ||
      typeof entry?.since !== "string" ||
      Number.isNaN(Date.parse(entry.since)) ||
      typeof entry?.generation !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.generation)
    ) {
      throw new Error("Kimi pending-session marker has an invalid shape");
    }
    const expectedName = pendingMarkerName(entry.file, entry.since, entry.generation);
    if (dirent.name !== expectedName) throw new Error("Kimi pending-session marker name does not match its content");
    const known = pending.get(entry.file);
    if (!known) {
      pending.set(entry.file, { since: entry.since, markerNames: new Set([dirent.name]) });
    } else {
      known.markerNames.add(dirent.name);
      if (Date.parse(entry.since) < Date.parse(known.since)) known.since = entry.since;
    }
  }
  return pending;
}

function hasIncompleteTrailingRecord(text) {
  const lastLine = text.trimEnd().split("\n").at(-1)?.trim();
  if (!lastLine) return false;
  try {
    JSON.parse(lastLine);
    return false;
  } catch {
    return true;
  }
}

function pendingMarkerName(file, since, generation) {
  const digest = createHash("sha256").update(`${file}\0${since}\0${generation}`).digest("hex");
  return `${digest}.json`;
}

function isCanonicalPendingFile(file) {
  if (typeof file !== "string" || !file || isAbsolute(file) || file.includes("\\")) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return parts.length === 5 && parts[2] === "agents" && parts[4] === "wire.jsonl";
}

export async function writeKimiPendingMarker(stateRoot, file, since) {
  if (!isCanonicalPendingFile(file)) throw new Error("Kimi pending-session marker has an invalid source path");
  const directory = `${collectorStatePath(PRODUCER_ID, stateRoot, "pending")}.d`;
  await mkdir(directory, { recursive: true });
  const generation = randomUUID();
  const name = pendingMarkerName(file, since, generation);
  const path = join(directory, name);
  const tempPath = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(
    tempPath,
    `${JSON.stringify({ version: 1, file, since, generation })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(tempPath, path);
  return name;
}

async function readKimiWire(file, sessionsRoot, onReadError, afterOpen) {
  let handle;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(sessionsRoot), realpath(file)]);
    if (realFile !== resolve(realRoot, relative(sessionsRoot, file))) throw new Error("Kimi wire path is not canonical");
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Kimi wire is not a regular file");
    await afterOpen?.(file);
    const text = await handle.readFile("utf8");
    let currentRoot;
    let currentFile;
    let currentStat;
    try {
      [currentRoot, currentFile, currentStat] = await Promise.all([realpath(sessionsRoot), realpath(file), stat(file)]);
    } catch {
      throw new Error("Kimi wire path changed while reading");
    }
    if (
      currentRoot !== realRoot || currentFile !== realFile ||
      currentFile !== resolve(currentRoot, relative(sessionsRoot, file)) ||
      !currentStat.isFile() || currentStat.dev !== opened.dev || currentStat.ino !== opened.ino
    ) throw new Error("Kimi wire path changed while reading");
    return text;
  } catch (error) {
    onReadError(error);
    return null;
  } finally {
    await handle?.close();
  }
}

export async function acknowledgeKimiEvents(stateRoot, scanStatus, { dryRun = false } = {}) {
  if (dryRun) return;
  const resolvedMarkers = scanStatus?.resolvedPendingMarkers;
  if (!resolvedMarkers?.size) return;
  const directory = `${collectorStatePath(PRODUCER_ID, stateRoot, "pending")}.d`;
  for (const names of resolvedMarkers.values()) {
    for (const name of names) {
      try {
        await rm(join(directory, name));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

export async function finishKimiPass({
  args,
  passStartedAt,
  scanStatus,
  stateRoot,
  recordSuccess = recordCollectorSuccess,
} = {}) {
  const canAdvance = canAdvanceCollectorCheckpoint(args, { scanComplete: scanStatus.complete });
  if (canAdvance) await recordSuccess(PRODUCER_ID, passStartedAt, { stateRoot });
  if (canAdvance || (args.explicitSince && !args.dryRun && scanStatus.complete)) {
    await acknowledgeKimiEvents(stateRoot, scanStatus, { dryRun: args.dryRun });
  }
}

export async function collectKimiEvents({
  home = defaultKimiCodeHome(),
  stateRoot,
  since,
  scanStatus = { complete: true },
  env = process.env,
  dryRun = false,
  afterWireOpen,
} = {}) {
  const normalizedHome = resolve(home);
  const sessionsRoot = join(normalizedHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const pending = await readPendingSessions(stateRoot);
  const workDirBySession = await readSessionIndex(normalizedHome, {
    onReadError: () => {},
  });
  // Missing attribution is deferred per source file.  This lets the global
  // checkpoint move while retaining the exact rows for replay when the index
  // is repaired.
  const files = await walkFiles(sessionsRoot, {
    name: "wire.jsonl",
    onTraversalError: () => {
      scanStatus.complete = false;
    },
  });
  files.sort();
  const filesToRead = new Map();
  const discoveredFiles = new Set();
  for (const file of files) {
    const relativeFile = relative(sessionsRoot, file).replaceAll("\\", "/");
    if (!isCanonicalPendingFile(relativeFile)) continue;
    discoveredFiles.add(file);
    const isPendingFile = pending.has(relativeFile);
    const fresh = await fileMayContainEventsSince(file, since, {
      onStatError: (error) => {
        if (!(isPendingFile && error?.code === "ENOENT")) scanStatus.complete = false;
      },
    });
    if (fresh) {
      filesToRead.set(file, {
        since: since?.toISOString?.() ?? new Date(0).toISOString(),
        pending: isPendingFile,
      });
    }
  }
  for (const [relativeFile, pendingEntry] of pending) {
    if (!isCanonicalPendingFile(relativeFile)) {
      throw new Error("Kimi pending-session marker contains a noncanonical source path");
    }
    const file = resolve(sessionsRoot, relativeFile);
    const rel = relative(sessionsRoot, file);
    if (rel.startsWith(`..${sep}`) || rel === "..") {
      throw new Error("Kimi pending-session marker resolves outside the sessions directory");
    }
    if (!discoveredFiles.has(file)) continue;
    const identity = kimiWireIdentity(sessionsRoot, file);
    if (!identity.sessionId || !projectNameFromDirectory(workDirBySession?.get(identity.sessionId))) continue;
    const freshEntry = filesToRead.get(file);
    let replaySince = pendingEntry.since;
    if (freshEntry && Date.parse(freshEntry.since) < Date.parse(replaySince)) {
      replaySince = freshEntry.since;
      if (!dryRun) {
        pendingEntry.markerNames.add(await writeKimiPendingMarker(stateRoot, relativeFile, replaySince));
      }
      pendingEntry.since = replaySince;
    }
    filesToRead.set(file, { since: replaySince, pending: true });
  }
  const events = [];
  const resolvedPendingFiles = new Set();
  for (const [filePath, fileEntry] of filesToRead) {
    const replaySinceIso = fileEntry.since;
    const text = await readKimiWire(filePath, sessionsRoot, (error) => {
      if (!(fileEntry.pending && (error?.code === "ENOENT" || error?.code === "ELOOP"))) scanStatus.complete = false;
    }, afterWireOpen);
    if (text === null) continue;
    const identity = kimiWireIdentity(sessionsRoot, filePath);
    const workDir = identity.sessionId ? workDirBySession?.get(identity.sessionId) : undefined;
    const project = projectNameFromDirectory(workDir);
    const incompleteTrailingRecord = hasIncompleteTrailingRecord(text);
    if (!identity.sessionId || !project) {
      const file = relative(sessionsRoot, filePath).replaceAll("\\", "/");
      const known = pending.get(file);
      const deferredSince = incompleteTrailingRecord
        ? EARLIEST_REPLAY_SINCE
        : known && Date.parse(known.since) < Date.parse(replaySinceIso)
          ? known.since
          : replaySinceIso;
      // A resolver may acknowledge every generation observed by this scan.  A
      // fresh generation protects rows deferred while that resolver is running.
      let markerNames = new Set(known?.markerNames);
      if (!dryRun) {
        const newMarker = await writeKimiPendingMarker(stateRoot, file, deferredSince);
        await acknowledgeKimiEvents(stateRoot, { resolvedPendingMarkers: new Map([[file, markerNames]]) });
        markerNames = new Set([newMarker]);
      }
      pending.set(file, { since: deferredSince, markerNames });
      continue;
    }
    events.push(
      ...filterEventsSince(
        parseKimiUsageJsonl(text, {
          ...identity,
          project,
          botFleetManaged: typeof workDir === "string" && isBotFleetSessionPath(workDir, env),
        }),
        new Date(replaySinceIso),
      ),
    );
    const relativeFile = relative(sessionsRoot, filePath).replaceAll("\\", "/");
    if (incompleteTrailingRecord) {
      // A partial last row can become valid after the checkpoint advances.
      // Its timestamp is unknowable until the JSON is complete, so retain the
      // whole source rather than filtering a later completion at today's
      // checkpoint boundary.
      if (!dryRun) {
        const known = pending.get(relativeFile);
        const markerNames = new Set(known?.markerNames);
        const marker = await writeKimiPendingMarker(stateRoot, relativeFile, EARLIEST_REPLAY_SINCE);
        await acknowledgeKimiEvents(stateRoot, { resolvedPendingMarkers: new Map([[relativeFile, markerNames]]) });
        pending.set(relativeFile, { since: EARLIEST_REPLAY_SINCE, markerNames: new Set([marker]) });
      }
    } else if (pending.has(relativeFile)) {
      resolvedPendingFiles.add(relativeFile);
    }
  }
  scanStatus.resolvedPendingMarkers = new Map(
    [...resolvedPendingFiles].map((file) => [file, pending.get(file).markerNames]),
  );
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
  configureCollectorSentryToken(["KIMI_CODE_TELEMETRY_HUB_TOKEN"]);
  const sourceAvailable = existsSync(join(home, "sessions"));
  const scanStatus = { complete: true };
  const events = await collectKimiEvents({ home, since: args.since, scanStatus, dryRun: args.dryRun });
  if (!scanStatus.complete) log("WARNING: source scan incomplete; checkpoint unchanged");
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
    await finishKimiPass({ args, passStartedAt, scanStatus });
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
    await finishKimiPass({ args, passStartedAt, scanStatus });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
