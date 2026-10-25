import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";

import { fleetSecretsGet } from "./fleet-secrets.mjs";

/**
 * Resolves an ingest token from the environment, then from the Mac-side
 * `fleet-secrets` CLI (OPS-818;  the retired flat key file is no longer read).
 *
 * Names are tried strictly in order, each in the environment and then through
 * `fleet-secrets get`, so a producer-scoped name kept in Infisical still beats
 * an unscoped USAGE_INGEST_TOKEN exported in the environment.  Pass
 * `fleetSecretsGet: () => null` for an environment-only lookup.
 */
export function resolveCollectorToken(
  tokenEnvVarNames = ["USAGE_INGEST_TOKEN"],
  { env = process.env, fleetSecretsGet: lookup = fleetSecretsGet } = {},
) {
  for (const name of tokenEnvVarNames) {
    const val = env[name]?.trim();
    if (val) return val;
    const fromFleet = lookup(name)?.trim();
    if (fromFleet) return fromFleet;
  }
  return null;
}

/** Default lookback when LaunchAgents omit --days/--since.  UTC month-start
 *  dropped June–August Codex sessions on 1 September (owner 2026-09-03). */
export const DEFAULT_COLLECTOR_LOOKBACK_DAYS = 180;
export const COLLECTOR_STATE_OVERLAP_MINUTES = 24 * 60;

/**
 * The state file for one collector.  `suffix` names a sibling file for state
 * that must outlive the checkpoint (the opencode project-name freeze lives in
 * one, because a lost checkpoint replays rows and a lost freeze would let a
 * renamed project change their content).
 */
export function collectorStatePath(producerId, stateRoot, suffix) {
  const safeProducerId = producerId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = stateRoot ?? join(homedir(), ".cache", "usage-monitor", "collector-state");
  const safeSuffix = suffix ? String(suffix).replace(/[^a-zA-Z0-9._-]/g, "_") : "";
  return join(root, safeSuffix ? `${safeProducerId}-${safeSuffix}.json` : `${safeProducerId}.json`);
}

/**
 * Recurring collectors keep a durable successful-through watermark and replay
 * 24 hours for delayed shutdown records and late writes.  Stable event ids
 * make that bounded catch-up overlap idempotent.
 * Explicit --days/--since remains an intentional backfill and bypasses state.
 */
export async function resolveCollectorArgs(
  argv,
  producerId,
  { stateRoot, now = new Date(), defaultLookbackDays } = {},
) {
  const args = parseCollectorArgs(argv, now, defaultLookbackDays === undefined ? {} : { defaultLookbackDays });
  if (args.explicitSince) return args;
  try {
    const raw = await readFile(collectorStatePath(producerId, stateRoot), "utf8");
    const state = JSON.parse(raw);
    if (state?.version !== 1 || state?.producerId !== producerId) return args;
    const successfulThrough = new Date(state.successfulThrough);
    if (
      !Number.isNaN(successfulThrough.getTime()) &&
      successfulThrough.getTime() <= now.getTime()
    ) {
      const since = new Date(
        successfulThrough.getTime() - COLLECTOR_STATE_OVERLAP_MINUTES * 60_000,
      );
      return { ...args, since, resumedFromState: true };
    }
  } catch {
    // Missing/corrupt state falls back to the bounded bootstrap lookback.
  }
  return args;
}

export async function recordCollectorSuccess(
  producerId,
  successfulThrough,
  { stateRoot } = {},
) {
  const path = collectorStatePath(producerId, stateRoot);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    tempPath,
    `${JSON.stringify({ version: 1, producerId, successfulThrough: successfulThrough.toISOString() })}\n`,
    { mode: 0o600 },
  );
  await rename(tempPath, path);
}

export function parseCollectorArgs(argv, now = new Date(), { defaultLookbackDays = DEFAULT_COLLECTOR_LOOKBACK_DAYS } = {}) {
  const dryRun = argv.includes("--dry-run");
  const debug = argv.includes("--debug");
  let days = null;
  let sinceIso = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = Number.parseInt(argv[i + 1], 10);
    }
    if (argv[i] === "--since" && argv[i + 1]) {
      sinceIso = argv[i + 1];
    }
  }
  let since = null;
  if (sinceIso) {
    since = new Date(sinceIso);
  } else if (Number.isFinite(days) && days > 0) {
    since = new Date(now.getTime() - days * 86_400_000);
  } else {
    since = new Date(now.getTime() - defaultLookbackDays * 86_400_000);
  }
  if (Number.isNaN(since.getTime())) {
    throw new Error(`Invalid --since ${sinceIso}`);
  }
  return {
    dryRun,
    debug,
    since,
    explicitSince: Boolean(sinceIso || (Number.isFinite(days) && days > 0)),
    resumedFromState: false,
  };
}

export async function walkFiles(root, { suffix, name, onTraversalError } = {}) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        onTraversalError?.(error);
      }
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (suffix && !entry.name.endsWith(suffix)) continue;
      if (name && entry.name !== name) continue;
      out.push(full);
    }
  }
  await walk(root);
  return out;
}

export async function readIfFresh(path, { onReadError } = {}) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    onReadError?.(error);
    return null;
  }
}

export async function fileMayContainEventsSince(path, since, { onStatError } = {}) {
  if (!since) return true;
  try {
    return (await stat(path)).mtime >= since;
  } catch (error) {
    onStatError?.(error);
    return false;
  }
}

export function canAdvanceCollectorCheckpoint(args, { scanComplete = true } = {}) {
  return !args.dryRun && !args.explicitSince && scanComplete;
}

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function sessionKeyFor(root, filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}

const ARCHIVED_SESSIONS_PREFIX = "archived_sessions/";

/**
 * Codex `archive` / `/archive` rename()s a rollout into
 * `archived_sessions/<filename>` (flattened; openai/codex archive_thread.rs).
 * eventId hashes sessionKey, so a raw relative path would persist the same
 * last_token_usage rows again on the next 15-min tick.  Reconstruct the live
 * `sessions/YYYY/MM/DD/<filename>` key from the ISO date in the filename
 * (same local timestamp Codex used for the date folder).
 */
export function codexSessionKeyFor(codexHome, filePath) {
  const rel = sessionKeyFor(codexHome, filePath);
  if (!rel.startsWith(ARCHIVED_SESSIONS_PREFIX)) return rel;
  const rest = rel.slice(ARCHIVED_SESSIONS_PREFIX.length);
  const fileName = rest.split("/").pop() || rest;
  const isoDate = fileName.match(/^rollout-(\d{4}-\d{2}-\d{2})T/);
  if (isoDate) {
    return `sessions/${isoDate[1].replaceAll("-", "/")}/${fileName}`;
  }
  if (rest.includes("/")) {
    return `sessions/${rest}`;
  }
  return `sessions/${fileName}`;
}

/** BotFleet emits its child-turn usage separately under producer `botfleet`.
 * Exclude those Codex rollouts here because ingest idempotency is namespaced
 * by producer and cannot collapse the same turn across both producers. */
export function isBotFleetManagedCodexSession(text) {
  for (const line of text.split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "session_meta") continue;
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      const originator = typeof payload.originator === "string" ? payload.originator : "";
      const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
      return (
        originator.trim().toLowerCase() === "botfleet" ||
        cwd.includes("/.botfleet/workspaces/") ||
        cwd.includes("/.botfleet-workspaces/")
      );
    } catch {
      // Keep looking for a valid session_meta row.
    }
  }
  return false;
}

export function botFleetChildExclusionEnabled(env = process.env) {
  return env.USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN === "1";
}

export function isBotFleetSessionPath(path) {
  return path.includes("/.botfleet/workspaces/") || path.includes(".botfleet-workspaces-");
}
