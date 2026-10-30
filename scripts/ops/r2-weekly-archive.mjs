#!/usr/bin/env node
/**
 * Weekly Cloudflare R2 archive — a second-vendor disaster-recovery copy.
 *
 * Why this exists (owner directive, 2026-08-12)
 * ---------------------------------------------
 * Backblaze B2 is the continuous Litestream replica (1h sync). R2 was frozen to
 * a read-only historic archive during the 2026-08-05 free-tier incident, which
 * left the fleet with a single live backup vendor. This restores a second copy
 * on R2 at a cadence the free tier can absorb: ONE verified snapshot per week
 * instead of continuous LTX churn.
 *
 * Deliberately NOT a second Litestream replica:
 *   - Litestream 0.5 supports exactly one replica per database, so pointing it
 *     at R2 would mean giving up the B2 replica.
 *   - Running a second Litestream process against the same DB corrupts its
 *     shadow-WAL bookkeeping.
 *   - Litestream has no "sync once and exit" mode; every start re-LISTs and
 *     re-PUTs, which is exactly the Class A burn that caused the incident.
 * A single self-contained snapshot object is cheaper (a handful of Class A ops
 * per week against a 1,000,000/month limit) and far easier to restore from.
 *
 * Safety contract — nothing is deleted until a replacement is PROVEN good:
 *   1. Consistent snapshot via SQLite's Online Backup API (no writer downtime).
 *   2. Local PRAGMA integrity_check.
 *   3. gzip, then upload with a real signed payload hash (a truncated body is
 *      rejected by R2 rather than silently stored).
 *   4. Download the object back, re-hash it, decompress it, and run
 *      integrity_check on the DECOMPRESSED copy. That is a genuine weekly
 *      restore drill, not a "the PUT returned 200" check.
 *   5. ONLY after step 4 passes, prune older generations beyond the keep count.
 * Any failure leaves every pre-existing archive untouched.
 *
 * Usage:
 *   node scripts/ops/r2-weekly-archive.mjs [--dry-run] [--keep N] [--verbose]
 */

import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backup, DatabaseSync } from "node:sqlite";

import { listObjects, s3Request } from "../lib/s3-sigv4.mjs";

const DEFAULTS = {
  dbPath: "/data/prod.db",
  bucket: "usage-monitor-prod-v3",
  prefix: "weekly/",
  region: "auto",
  // Jay 2026-10-29 fleet policy: keep the newest 2 weekly generations (at most
  // ~2 weeks, ~100 MB compressed against a 10 GiB free tier), matching the privacy-policy
  // copy in src/app/privacy/page.tsx. Prune still runs only after the fresh
  // upload is verified. R2_ARCHIVE_KEEP_GENERATIONS / --keep override this.
  keepGenerations: 2,
  // Jay 2026-10-30: "the 2 weeks counts from day 1". Hard cap on top of
  // keepGenerations: after a verified upload, any archive more than 14 days
  // older than the fresh one is pruned, so a skipped/failed week or a raised
  // R2_ARCHIVE_KEEP_GENERATIONS can never keep a copy past 2 weeks.
  maxAgeDays: 14,
  statusPath: "/data/.r2-archive-status.json",
  // Pages per sqlite3_backup_step(); matches the pre-migration backup default.
  backupRatePages: 100,
  // A SIGKILLed run skips the `finally` cleanup and leaves its whole work dir
  // behind — multi-GB on the volume the app gates on for free space. The next
  // run reclaims those leftovers, but only ones old enough that no run can
  // still be using them (an overlapping invocation's dir is still being
  // written to).
  staleWorkDirMs: 24 * 60 * 60 * 1000,
};

function log(message) {
  console.log(`[r2-weekly-archive] ${message}`);
}

function parseArgs(argv) {
  const options = { dryRun: false, keep: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--keep") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--keep requires a positive integer");
      }
      options.keep = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * R2 archive credentials are deliberately their OWN env vars, never
 * `LITESTREAM_S3_*` — those point at Backblaze B2 now, and silently signing an
 * R2 request with B2 keys produces a 401 that reads like a revoked token.
 */
export function resolveArchiveConfig(env = process.env, overrides = {}) {
  const endpoint = (env.R2_ARCHIVE_ENDPOINT || "").trim();
  const accessKeyId = (env.R2_ARCHIVE_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (env.R2_ARCHIVE_SECRET_ACCESS_KEY || "").trim();
  const missing = [];
  if (!endpoint) missing.push("R2_ARCHIVE_ENDPOINT");
  if (!accessKeyId) missing.push("R2_ARCHIVE_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_ARCHIVE_SECRET_ACCESS_KEY");

  const keepRaw = Number(env.R2_ARCHIVE_KEEP_GENERATIONS);
  const keepGenerations =
    overrides.keep ??
    (Number.isInteger(keepRaw) && keepRaw >= 1 ? keepRaw : DEFAULTS.keepGenerations);

  let prefix = (env.R2_ARCHIVE_PREFIX || DEFAULTS.prefix).trim();
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  const dbPath = (env.R2_ARCHIVE_DB_PATH || DEFAULTS.dbPath).trim();
  // Work must live on the persistent data volume beside the DB, never OS
  // /tmp: a tmpfs fill (host Coolify 503 incident) is exactly what a
  // ~100 MB snapshot + verify copy invites. Env override for tests/ops.
  const workDirBase =
    (env.R2_ARCHIVE_WORK_DIR || "").trim() || join(dirname(dbPath), ".r2-archive-work");

  return {
    missing,
    creds: {
      endpoint,
      region: (env.R2_ARCHIVE_REGION || DEFAULTS.region).trim() || DEFAULTS.region,
      accessKeyId,
      secretAccessKey,
    },
    bucket: (env.R2_ARCHIVE_BUCKET || DEFAULTS.bucket).trim(),
    prefix,
    keepGenerations,
    dbPath,
    workDirBase,
    statusPath: (env.R2_ARCHIVE_STATUS_PATH || DEFAULTS.statusPath).trim(),
    // The free-tier kill switch means "stop writing to R2". A ~50 MB weekly
    // object is not what tripped it, but honouring it keeps one switch
    // authoritative; the override exists for a deliberate operator decision.
    killSwitchEngaged:
      env.R2_WRITES_DISABLED === "true" || env.LITESTREAM_EMERGENCY_DISABLE === "true",
    ignoreKillSwitch: env.R2_ARCHIVE_IGNORE_KILL_SWITCH === "true",
  };
}

/** `weekly/prod-2026-08-12T09-48-45Z.db.gz` — lexically sortable == chronological. */
export function archiveKeyFor(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  return `${prefix}prod-${stamp}.db.gz`;
}

/**
 * Keys are only ever deleted if they match the exact shape this job writes.
 * The candidate list comes from a ListObjectsV2 response, i.e. from outside
 * this process — without an allowlist, a malformed or hostile listing could
 * steer DELETE at arbitrary objects (the frozen Litestream history included).
 */
export function isManagedArchiveKey(key, prefix) {
  if (typeof key !== "string" || !key.startsWith(prefix)) return false;
  const remainder = key.slice(prefix.length);
  return /^prod-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db\.gz$/.test(remainder);
}

/** Epoch ms of a `prod-YYYY-MM-DDTHH-MM-SSZ.db.gz` archive key, or NaN. */
export function archiveKeyTimeMs(key) {
  const match = /prod-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db\.gz$/.exec(
    typeof key === "string" ? key : ""
  );
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
}

/**
 * Which existing objects to delete, given the freshly uploaded key.
 * Keeps the newest `keepGenerations` (fresh upload included), then also drops
 * any kept archive more than `maxAgeDays` older than the fresh upload. The
 * fresh upload itself is never a candidate.
 * Pure so the retention rule is unit-testable without touching R2.
 */
export function selectPruneTargets(
  objects,
  freshKey,
  keepGenerations,
  prefix = DEFAULTS.prefix,
  maxAgeDays = DEFAULTS.maxAgeDays
) {
  const archives = objects
    .filter((o) => isManagedArchiveKey(o.key, prefix))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // newest first
  const keep = new Set();
  keep.add(freshKey); // the just-verified upload is never a prune candidate
  for (const object of archives) {
    if (keep.size >= keepGenerations) break;
    keep.add(object.key);
  }
  const freshMs = archiveKeyTimeMs(freshKey);
  const referenceMs = Number.isFinite(freshMs) ? freshMs : Date.now();
  const cutoffMs = referenceMs - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const key of [...keep]) {
    if (key === freshKey) continue;
    const keyMs = archiveKeyTimeMs(key);
    if (Number.isFinite(keyMs) && keyMs < cutoffMs) keep.delete(key);
  }
  return archives.filter((o) => !keep.has(o.key)).map((o) => o.key);
}

function assertIntegrity(path) {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 30_000 });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    const value = Object.values(rows[0] ?? {})[0];
    if (rows.length !== 1 || value !== "ok") {
      throw new Error(`PRAGMA integrity_check returned ${JSON.stringify(rows).slice(0, 200)}`);
    }
  } finally {
    database.close();
  }
}

async function snapshotDatabase(dbPath, destination, ratePages) {
  const source = new DatabaseSync(dbPath, { readOnly: true, timeout: 30_000 });
  try {
    await backup(source, destination, { rate: ratePages });
  } finally {
    source.close();
  }
  chmodSync(destination, 0o600);
}

async function gzipFile(source, destination) {
  await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(destination));
}

function writeStatus(statusPath, payload) {
  try {
    const partial = `${statusPath}.partial`;
    writeFileSync(partial, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
    renameSync(partial, statusPath);
  } catch (error) {
    // Observability must never fail the archive itself.
    log(`WARNING: could not write status file: ${error.message}`);
  }
}

export async function runArchive({ env = process.env, argv = [], fetchImpl } = {}) {
  const options = parseArgs(argv);
  const config = resolveArchiveConfig(env, { keep: options.keep });
  const startedAt = new Date();

  if (config.missing.length > 0) {
    throw new Error(
      `missing R2 archive credentials: ${config.missing.join(", ")}. ` +
        `These are separate from LITESTREAM_S3_* (which point at Backblaze B2). ` +
        `Mint an R2 API token (Cloudflare dashboard -> R2 -> Manage API Tokens) and store it in Infisical.`
    );
  }
  if (config.killSwitchEngaged && !config.ignoreKillSwitch) {
    throw new Error(
      "R2 free-tier kill switch is engaged (R2_WRITES_DISABLED / LITESTREAM_EMERGENCY_DISABLE). " +
        "Clear it, or set R2_ARCHIVE_IGNORE_KILL_SWITCH=true to archive anyway."
    );
  }
  if (!existsSync(config.dbPath)) {
    throw new Error(`database not found at ${config.dbPath}`);
  }

  mkdirSync(config.workDirBase, { recursive: true });
  // Reclaim work dirs abandoned by a killed run before claiming a new one. The
  // age guard keeps this from deleting the dir of an overlapping invocation,
  // which is still being written to.
  const staleCutoff = Date.now() - DEFAULTS.staleWorkDirMs;
  for (const entry of readdirSync(config.workDirBase, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
    const stalePath = join(config.workDirBase, entry.name);
    try {
      if (statSync(stalePath).mtimeMs >= staleCutoff) continue;
    } catch {
      continue; // vanished underneath us; nothing to reclaim
    }
    log(`reclaiming stale work dir from a previous run: ${entry.name}`);
    rmSync(stalePath, { recursive: true, force: true });
  }
  const workDir = mkdtempSync(join(config.workDirBase, "run-"));
  const snapshotPath = join(workDir, "snapshot.db");
  const compressedPath = join(workDir, "snapshot.db.gz");
  const restoredPath = join(workDir, "verify.db");

  try {
    log(`snapshotting ${config.dbPath}`);
    await snapshotDatabase(config.dbPath, snapshotPath, DEFAULTS.backupRatePages);
    assertIntegrity(snapshotPath);
    const snapshotBytes = statSync(snapshotPath).size;
    log(`snapshot verified (${snapshotBytes} bytes)`);

    await gzipFile(snapshotPath, compressedPath);
    // The snapshot is spent the moment it is gzipped — only `snapshotBytes` is
    // read after this. Drop it rather than carry a second full-size copy
    // through the rest of the run on a volume with a free-space floor.
    rmSync(snapshotPath, { force: true });
    // Read once, then derive size, hash, and the upload body from those exact
    // bytes. A stat-then-hash-then-read sequence is a genuine TOCTOU race: the
    // file could change between steps and we would advertise a hash that does
    // not describe what we actually uploaded.
    const compressedBuffer = readFileSync(compressedPath);
    // The upload body now lives in memory; the on-disk copy is redundant.
    rmSync(compressedPath, { force: true });
    const compressedBytes = compressedBuffer.length;
    const localHash = createHash("sha256").update(compressedBuffer).digest("hex");
    log(`compressed to ${compressedBytes} bytes (sha256 ${localHash.slice(0, 12)}...)`);

    const key = archiveKeyFor(config.prefix, startedAt);

    if (options.dryRun) {
      log(`DRY RUN — would upload ${key} to ${config.bucket} and keep ${config.keepGenerations} generations`);
      return { dryRun: true, key, compressedBytes, snapshotBytes, sha256: localHash, pruned: [] };
    }

    log(`uploading ${key}`);
    await s3Request({
      method: "PUT",
      creds: config.creds,
      bucket: config.bucket,
      key,
      body: compressedBuffer,
      headers: {
        "content-type": "application/gzip",
        // Survives independently of this script so a human can verify by hand.
        "x-amz-meta-sha256": localHash,
        "x-amz-meta-source-bytes": String(snapshotBytes),
        "x-amz-meta-created-at": startedAt.toISOString(),
      },
      fetchImpl,
    });

    // ---- Verification: prove the remote object restores, not just that it exists.
    log("verifying uploaded object (download, re-hash, decompress, integrity_check)");
    const response = await s3Request({
      method: "GET",
      creds: config.creds,
      bucket: config.bucket,
      key,
      fetchImpl,
    });
    // Stream the download in two passes, never holding it in memory: pass 1
    // hashes the compressed bytes into a temp .gz, pass 2 gunzips that file
    // to the verify database. The decompressed database is now ~3 GB, past
    // Node's 2 GiB Buffer cap, so the old arrayBuffer()/gunzipSync pair threw
    // on every run and prune (below) never executed. Both copies land only in
    // this run's temp work dir, and prune is still gated on hash + size +
    // integrity all passing.
    if (!response.body) throw new Error("S3 GET returned no body — keeping all existing archives");
    const remoteHash = createHash("sha256");
    const hashTap = new Transform({
      transform(chunk, _encoding, callback) {
        remoteHash.update(chunk);
        callback(null, chunk);
      },
    });
    const downloadedPath = join(workDir, "verify.db.gz");
    await pipeline(Readable.fromWeb(response.body), hashTap, createWriteStream(downloadedPath, { mode: 0o600 }));
    const remoteDigest = remoteHash.digest("hex");
    if (remoteDigest !== localHash) {
      throw new Error(
        `uploaded object hash mismatch: local ${localHash} vs remote ${remoteDigest} — keeping all existing archives`
      );
    }
    let restoredBytes = 0;
    const countTap = new Transform({
      transform(chunk, _encoding, callback) {
        restoredBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(createReadStream(downloadedPath), createGunzip(), countTap, createWriteStream(restoredPath, { mode: 0o600 }));
    // The compressed copy is spent once gunzipped — free it before the
    // multi-GB restore lands next to it.
    rmSync(downloadedPath, { force: true });
    if (restoredBytes !== snapshotBytes) {
      throw new Error(
        `restored size mismatch: ${restoredBytes} vs ${snapshotBytes} — keeping all existing archives`
      );
    }
    assertIntegrity(restoredPath);
    log("verification passed — the archive restores to a byte-identical, integrity-checked database");

    // ---- Only now is deleting anything safe.
    const existing = await listObjects({
      creds: config.creds,
      bucket: config.bucket,
      prefix: config.prefix,
      fetchImpl,
    });
    const pruneTargets = selectPruneTargets(existing, key, config.keepGenerations, config.prefix);
    for (const target of pruneTargets) {
      log(`pruning superseded archive ${target}`);
      await s3Request({
        method: "DELETE",
        creds: config.creds,
        bucket: config.bucket,
        key: target,
        expectStatuses: [200, 204, 404],
        fetchImpl,
      });
    }

    const result = {
      ok: true,
      key,
      snapshotBytes,
      compressedBytes,
      sha256: localHash,
      keptGenerations: config.keepGenerations,
      pruned: pruneTargets,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };
    // The status file records a COUNT, never the pruned key strings. Those
    // originate from a ListObjectsV2 response, and while `isManagedArchiveKey`
    // already constrains them to a strict pattern, keeping remote-derived text
    // out of a file the app later reads removes the question entirely. The full
    // keys are still in this run's log output for an operator.
    const { pruned, ...persisted } = result;
    writeStatus(config.statusPath, {
      ...persisted,
      prunedCount: pruned.length,
      checkedAt: result.completedAt,
    });
    log(
      `done — ${key} verified, ${pruneTargets.length} superseded archive(s) pruned, ` +
        `up to ${config.keepGenerations} generation(s) retained, none older than ${DEFAULTS.maxAgeDays} days`
    );
    return result;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Map a failure to one of a fixed set of reason codes.
 *
 * The status file is parsed by the app on the /api/ready path, and a raw
 * `error.message` can embed an S3 error body — i.e. text controlled by the
 * remote server. Rather than sanitizing vendor text, nothing remote-derived is
 * persisted at all: the file gets a constant from this list, and the full
 * message goes to stdout where an operator reads it. A stable machine-readable
 * reason is also simply better for a health endpoint than arbitrary prose.
 */
export function classifyFailure(error) {
  const message = String(error?.message ?? "");
  if (/missing R2 archive credentials/.test(message)) return "credentials_missing";
  if (/kill switch is engaged/.test(message)) return "kill_switch_engaged";
  if (/database not found/.test(message)) return "database_missing";
  if (/hash mismatch/.test(message)) return "verify_hash_mismatch";
  if (/restored size mismatch/.test(message)) return "verify_size_mismatch";
  if (/integrity_check/.test(message)) return "integrity_check_failed";
  if (/^S3 PUT/.test(message)) return "upload_failed";
  if (/^S3 GET/.test(message)) return "download_failed";
  if (/^S3 DELETE/.test(message)) return "prune_failed";
  return "archive_failed";
}

// Entrypoint detection must compare the RESOLVED module URL, not a filename
// suffix. `"test-r2-weekly-archive.mjs".endsWith("r2-weekly-archive.mjs")` is
// true, so the old suffix check fired while `scripts/test-r2-weekly-archive.mjs`
// was running: importing this module ran a real archive against the ambient
// environment, and its missing-credentials failure set `process.exitCode = 1` on
// a test process whose own assertions had all passed. That is why the test
// reported "18 passed, 0 failed" and still exited 1, and why it was read as
// needing live R2 credentials (docs/rollouts/2026-08-12-pagerduty-alert-
// correctness.md) and left out of CI. On a host where R2_ARCHIVE_* IS set it was
// worse than a bad exit code: the test would have archived and pruned the live
// bucket. This is the idiom the rest of scripts/ already uses.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await runArchive({ argv: process.argv.slice(2) });
  } catch (error) {
    log(`FAILED: ${error.message}`);
    const config = resolveArchiveConfig();
    writeStatus(config.statusPath, {
      ok: false,
      reason: classifyFailure(error),
      checkedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  }
}
