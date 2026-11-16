#!/usr/bin/env node
// Exact Kimi Code per-turn token collector.
//
// Kimi persists durable `usage.record` events under
// ~/.kimi-code/sessions/*/*/agents/*/wire.jsonl.  Only turn-scope rows are
// deltas; session-scope rows are cumulative and are deliberately ignored.

import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const canonical = isSafePendingFile(sessionKey) && parts.length === 5 && parts[2] === "agents";
  return {
    sessionKey,
    sessionId: canonical ? parts[1] : undefined,
    agentId: canonical ? parts[3] : undefined,
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
      ![1, 2].includes(entry?.version) ||
      (entry.version === 2 && !/^[0-9a-f]{64}$/.test(entry.sourceFingerprint)) ||
      !isSafePendingFile(entry?.file) ||
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
      pending.set(entry.file, {
        since: entry.since,
        markerNames: new Set([dirent.name]),
        boundaryMarkerName: dirent.name,
        sourceFingerprint: entry.version === 2 ? entry.sourceFingerprint : undefined,
      });
    } else {
      known.markerNames.add(dirent.name);
      if (
        Date.parse(entry.since) < Date.parse(known.since) ||
        (entry.since === known.since && dirent.name < known.boundaryMarkerName)
      ) {
        known.since = entry.since;
        known.boundaryMarkerName = dirent.name;
      }
      if (entry.version !== 2 || known.sourceFingerprint !== entry.sourceFingerprint) known.sourceFingerprint = undefined;
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

function isSafePendingFile(file) {
  if (
    typeof file !== "string" || !file || isAbsolute(file) ||
    /^[a-z]:/i.test(file) || file.includes("\\") || file.includes("\0")
  ) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return parts.at(-1) === "wire.jsonl";
}

export async function writeKimiPendingMarker(stateRoot, file, since, sourceFingerprint) {
  if (!isSafePendingFile(file)) throw new Error("Kimi pending-session marker has an invalid source path");
  const directory = `${collectorStatePath(PRODUCER_ID, stateRoot, "pending")}.d`;
  await mkdir(directory, { recursive: true });
  const generation = randomUUID();
  const name = pendingMarkerName(file, since, generation);
  const path = join(directory, name);
  const tempPath = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(
    tempPath,
    `${JSON.stringify({ version: sourceFingerprint ? 2 : 1, file, since, generation, sourceFingerprint })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(tempPath, path);
  return name;
}

function kimiSourceFingerprint(sourceStat) {
  if (!sourceStat.isFile()) throw new Error("Kimi wire is not a regular file");
  return createHash("sha256")
    .update([sourceStat.dev, sourceStat.ino, sourceStat.size, sourceStat.mtimeNs, sourceStat.ctimeNs].join("\0"))
    .digest("hex");
}

export async function deferPendingSession(stateRoot, file, since, known, sourceFingerprint, {
  dryRun, scanStatus, writePendingMarker, acknowledgePendingMarkers,
}) {
  if (dryRun) return known ?? { since, markerNames: new Set() };
  if (
    known?.markerNames.size && known.sourceFingerprint === sourceFingerprint &&
    Date.parse(known.since) <= Date.parse(since)
  ) {
    if (known.markerNames.size === 1) return known;
    // Compact duplicate durable generations without writing another one.
    const redundant = new Set(known.markerNames);
    redundant.delete(known.boundaryMarkerName);
    try {
      await acknowledgePendingMarkers(stateRoot, { resolvedPendingMarkers: new Map([[file, redundant]]) });
      return { ...known, markerNames: new Set([known.boundaryMarkerName]) };
    } catch {
      scanStatus.complete = false;
      return known;
    }
  }
  // A resolver may acknowledge the observed generations.  Only changed sources
  // need a fresh generation to protect rows that resolver has not read.
  const markerNames = new Set(known?.markerNames);
  let newMarker;
  try {
    newMarker = await writePendingMarker(stateRoot, file, since, sourceFingerprint);
    await acknowledgePendingMarkers(stateRoot, { resolvedPendingMarkers: new Map([[file, markerNames]]) });
    return { since, markerNames: new Set([newMarker]), boundaryMarkerName: newMarker, sourceFingerprint };
  } catch {
    scanStatus.complete = false;
    if (!newMarker) return known ?? { since, markerNames };
    markerNames.add(newMarker);
    const newMarkerIsBoundary = !known?.boundaryMarkerName ||
      Date.parse(since) < Date.parse(known.since) ||
      (since === known.since && newMarker < known.boundaryMarkerName);
    return {
      ...known,
      since: newMarkerIsBoundary ? since : known.since,
      markerNames,
      boundaryMarkerName: newMarkerIsBoundary ? newMarker : known.boundaryMarkerName,
      sourceFingerprint: !known || known.sourceFingerprint === sourceFingerprint ? sourceFingerprint : undefined,
    };
  }
}

async function readKimiWire(file, sessionsRoot, onReadError, afterOpen) {
  let handle;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(sessionsRoot), realpath(file)]);
    if (realFile !== resolve(realRoot, relative(sessionsRoot, file))) throw new Error("Kimi wire path is not canonical");
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error("Kimi wire is not a regular file");
    await afterOpen?.(file);
    const text = await handle.readFile("utf8");
    let currentRoot;
    let currentFile;
    let currentStat;
    try {
      [currentRoot, currentFile, currentStat] = await Promise.all([realpath(sessionsRoot), realpath(file), stat(file, { bigint: true })]);
    } catch {
      throw new Error("Kimi wire path changed while reading");
    }
    if (
      currentRoot !== realRoot || currentFile !== realFile ||
      currentFile !== resolve(currentRoot, relative(sessionsRoot, file)) ||
      !currentStat.isFile() || currentStat.dev !== opened.dev || currentStat.ino !== opened.ino ||
      currentStat.size !== opened.size || currentStat.mtimeNs !== opened.mtimeNs || currentStat.ctimeNs !== opened.ctimeNs
    ) throw new Error("Kimi wire path changed while reading");
    return { text, sourceFingerprint: kimiSourceFingerprint(currentStat) };
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
  resolveWireIdentity = kimiWireIdentity,
  readSessionDirectory,
  writePendingMarker = writeKimiPendingMarker,
  acknowledgePendingMarkers = acknowledgeKimiEvents,
} = {}) {
  const normalizedHome = resolve(home);
  const sessionsRoot = join(normalizedHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const pending = await readPendingSessions(stateRoot);
  const markerOptions = { dryRun, scanStatus, writePendingMarker, acknowledgePendingMarkers };
  const workDirBySession = await readSessionIndex(normalizedHome, {
    onReadError: () => {},
  });
  // Missing attribution is deferred per source file.  This lets the global
  // checkpoint move while retaining the exact rows for replay when the index
  // is repaired.
  const files = await walkFiles(sessionsRoot, {
    name: "wire.jsonl",
    reportMissing: true,
    readDirectory: readSessionDirectory,
    onTraversalError: () => {
      scanStatus.complete = false;
    },
  });
  files.sort();
  const filesToRead = new Map();
  const discoveredFiles = new Set();
  for (const file of files) {
    const relativeFile = relative(sessionsRoot, file).split(sep).join("/");
    if (!isSafePendingFile(relativeFile)) {
      scanStatus.complete = false;
      continue;
    }
    discoveredFiles.add(file);
    const identity = resolveWireIdentity(sessionsRoot, file);
    const isPendingFile = pending.has(relativeFile);
    if (!identity.sessionId && isPendingFile) continue;
    // First-seen unknown layouts need a durable boundary even when their mtime
    // predates the checkpoint.  Existing markers preserve the whole source.
    const fresh = !identity.sessionId || await fileMayContainEventsSince(file, since, {
      onStatError: (error) => {
        if (!(isPendingFile && error?.code === "ENOENT")) scanStatus.complete = false;
      },
    });
    if (fresh) {
      filesToRead.set(file, {
        since: since?.toISOString?.() ?? new Date(0).toISOString(),
        hasPendingMarker: isPendingFile,
      });
    }
  }
  for (const [relativeFile, pendingEntry] of pending) {
    if (!isSafePendingFile(relativeFile)) {
      throw new Error("Kimi pending-session marker contains an unsafe source path");
    }
    const file = resolve(sessionsRoot, relativeFile);
    const rel = relative(sessionsRoot, file);
    if (rel.startsWith(`..${sep}`) || rel === "..") {
      throw new Error("Kimi pending-session marker resolves outside the sessions directory");
    }
    if (!discoveredFiles.has(file)) continue;
    const identity = resolveWireIdentity(sessionsRoot, file);
    const requestedSince = since?.toISOString?.() ?? EARLIEST_REPLAY_SINCE;
    const replaySince = Date.parse(requestedSince) < Date.parse(pendingEntry.since)
      ? requestedSince : pendingEntry.since;
    if (!identity.sessionId || !projectNameFromDirectory(workDirBySession?.get(identity.sessionId))) {
      try {
        const fingerprint = kimiSourceFingerprint(await lstat(file, { bigint: true }));
        pending.set(relativeFile, await deferPendingSession(
          stateRoot, relativeFile, replaySince, pendingEntry, fingerprint, markerOptions,
        ));
      } catch (error) {
        if (error?.code === "ENOENT" && Date.parse(replaySince) < Date.parse(pendingEntry.since)) {
          pending.set(relativeFile, await deferPendingSession(
            stateRoot, relativeFile, replaySince, pendingEntry, undefined, markerOptions,
          ));
        } else if (error?.code !== "ENOENT") {
          scanStatus.complete = false;
        }
      }
      filesToRead.delete(file);
      continue;
    }
    if (Date.parse(replaySince) < Date.parse(pendingEntry.since)) {
      pending.set(relativeFile, await deferPendingSession(
        stateRoot, relativeFile, replaySince, pendingEntry, pendingEntry.sourceFingerprint, markerOptions,
      ));
    }
    filesToRead.set(file, { since: replaySince, hasPendingMarker: true });
  }
  const events = [];
  const resolvedPendingFiles = new Set();
  for (const [filePath, fileEntry] of filesToRead) {
    const replaySinceIso = fileEntry.since;
    const source = await readKimiWire(filePath, sessionsRoot, (error) => {
      if (!(fileEntry.hasPendingMarker && (error?.code === "ENOENT" || error?.code === "ELOOP"))) scanStatus.complete = false;
    }, afterWireOpen);
    if (source === null) continue;
    const { text, sourceFingerprint } = source;
    const identity = resolveWireIdentity(sessionsRoot, filePath);
    const workDir = identity.sessionId ? workDirBySession?.get(identity.sessionId) : undefined;
    const project = projectNameFromDirectory(workDir);
    const incompleteTrailingRecord = hasIncompleteTrailingRecord(text);
    if (!identity.sessionId || !project) {
      const file = relative(sessionsRoot, filePath).split(sep).join("/");
      const known = pending.get(file);
      // A first unknown-layout source can predate the global checkpoint.  Its
      // future parser must be able to recover every row, including older ones.
      const deferredSince = incompleteTrailingRecord || (!identity.sessionId && !known)
        ? EARLIEST_REPLAY_SINCE
        : known && Date.parse(known.since) < Date.parse(replaySinceIso)
          ? known.since
          : replaySinceIso;
      pending.set(file, await deferPendingSession(
        stateRoot, file, deferredSince, known, sourceFingerprint, markerOptions,
      ));
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
    const relativeFile = relative(sessionsRoot, filePath).split(sep).join("/");
    if (incompleteTrailingRecord) {
      // A partial last row can become valid after the checkpoint advances.
      // Its timestamp is unknowable until the JSON is complete, so retain the
      // whole source rather than filtering a later completion at today's
      // checkpoint boundary.
      pending.set(relativeFile, await deferPendingSession(
        stateRoot, relativeFile, EARLIEST_REPLAY_SINCE, pending.get(relativeFile), sourceFingerprint, markerOptions,
      ));
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
