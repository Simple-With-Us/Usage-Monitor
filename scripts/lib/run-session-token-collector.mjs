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
  { stateRoot, now = new Date(), defaultLookbackDays, stateOverlapMinutes } = {},
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
      // The replay overlap catches writes that land after the checkpoint.  It
      // is a per-collector cost: a collector whose source produces tens of
      // thousands of rows a day cannot afford to re-send a whole day on every
      // pass, so a producer with a high event volume uses a shorter overlap.
      const overlapMinutes =
        stateOverlapMinutes === undefined ? COLLECTOR_STATE_OVERLAP_MINUTES : stateOverlapMinutes;
      const since = new Date(
        successfulThrough.getTime() - overlapMinutes * 60_000,
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

/** The Codex conversation id from a rollout's `session_meta` row, which is
 *  the thread id an app-server client such as BotFleet sees. */
export function codexSessionId(text) {
  for (const line of text.split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "session_meta") continue;
      const id = row.payload?.id;
      if (typeof id === "string" && id.trim()) return id.trim();
      // A session_meta row without an id: keep looking for one that has it.
    } catch {
      // Keep looking for a valid session_meta row.
    }
  }
  return undefined;
}

/** Add correlation metadata to already-built events.  The eventId is not
 *  touched, and the monitor ignores a correlation key that only one side of a
 *  replay carries, so tagging an event the monitor already stored is safe. */
export function withCorrelationMetadata(events, metadata) {
  const entries = Object.entries(metadata).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return events;
  const extra = Object.fromEntries(entries);
  return events.map((event) => ({ ...event, metadata: { ...(event.metadata ?? {}), ...extra } }));
}

/** BotFleet emits its child-turn usage separately under producer `botfleet`.
 * Ingest idempotency is namespaced by producer and cannot collapse the same
 * turn across both producers, so these rollouts are either excluded
 * (USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1) or tagged for the monitor's
 * exact BotFleet coverage check. */
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

/** The metadata a collector stamps on a session it recognises as BotFleet's
 *  child, when it sends the session instead of dropping it.  The monitor drops
 *  such a row at ingest only when a stored `botfleet` turn names the same
 *  child session (src/lib/botfleet-coverage.ts), so a turn BotFleet never
 *  reported is kept rather than lost. */
export const BOTFLEET_LAUNCHER_METADATA = Object.freeze({ "agent.launcher": "botfleet" });

/** Claude Code names a project folder after its cwd with every character
 *  outside [A-Za-z0-9] replaced by "-", so `~/.botfleet/workspaces/x` becomes
 *  `-Users-jay--botfleet-workspaces-x`.  Only that exact form, as the name of
 *  a folder directly under `projects/`, counts; the slug is lossy, so a
 *  configured root is matched against the transcript's real cwd instead. */
const CLAUDE_BOTFLEET_PROJECT_FOLDER = /\/projects\/[^/]*--botfleet-workspaces-[^/]+\//;

/** Extra BotFleet workspace roots, for a BotFleet whose data dir is not
 *  `~/.botfleet` (BotFleet-server sets OMB_DATA_DIR, so its workspaces live in
 *  `<data>/workspaces`).  Comma-separated absolute paths. */
export function botFleetWorkspaceRoots(env = process.env) {
  return String(env.BOTFLEET_WORKSPACES_DIRS ?? "")
    .split(",")
    .map((root) => root.trim().replace(/\/+$/, ""))
    .filter((root) => root.startsWith("/"));
}

export function isBotFleetSessionPath(path, env = process.env) {
  if (
    path.includes("/.botfleet/workspaces/") ||
    path.includes(".botfleet-workspaces-") ||
    CLAUDE_BOTFLEET_PROJECT_FOLDER.test(path)
  ) {
    return true;
  }
  return botFleetWorkspaceRoots(env).some((root) => path.startsWith(`${root}/`));
}
