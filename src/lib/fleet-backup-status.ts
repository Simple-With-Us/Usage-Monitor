/**
 * Fleet off-site backup status for Usage Monitor ops UI (web + iOS Client).
 *
 * Per-app, per-location picture for the shared Hetzner host:
 *   - B2 full dumps under `hetzner/` (6h host rclone)
 *   - B2 Litestream continuous LTX (when the app replicates there)
 *   - Local pre-migration / SQLite snapshots (Usage Monitor only, in-process)
 *   - Peer litestream age from public health when available (Socratic.Trade)
 *   - Peer R2 weekly archive from public health (ST + CT; optional until peers ship)
 *   - R2 historic freeze (Usage Monitor self, in-process)
 *
 * Never gates product readiness. Cached separately so B2 list traffic stays
 * bounded. Uses the read-only Backblaze monitor key (same as the B2 adapter).
 */

import { getBackupLayersStatus } from "@/lib/runtime-health";
import { operationsHealthEgressDisabled } from "@/lib/operations-health";

export const FLEET_BACKUP_CACHE_TTL_MS = 180_000; // 3 min
export const FLEET_BACKUP_FAILURE_RETRY_MS = 45_000;

/** Full dump cadence is 6h; allow 3× before red. */
export const FLEET_DUMP_MAX_AGE_SECONDS = 18 * 3600;
/** Continuous litestream should stay well under a few hours. */
export const FLEET_LITESTREAM_MAX_AGE_SECONDS = 3 * 3600;
/** Cap B2 list pages so ST's large LTX tree cannot stall the endpoint. */
const B2_MAX_PAGES_PER_PREFIX = 4;
const B2_PAGE_SIZE = 1000;

export type FleetAppId = "usage-monitor" | "socratic-trade" | "congress-trade";

export type FleetBackupLocationId =
  | "local"
  | "b2-full-dump"
  | "b2-litestream"
  | "peer-litestream"
  | "r2-historic";

export interface FleetBackupLocationStatus {
  id: FleetBackupLocationId;
  /** Short Title Case label for UI. */
  label: string;
  ok: boolean | null;
  present: boolean;
  latestAgeSeconds: number | null;
  bytes: number | null;
  fileCount: number | null;
  reason: string | null;
}

export interface FleetAppBackupStatus {
  id: FleetAppId;
  /** Product display name (Title Case). */
  label: string;
  self: boolean;
  ok: boolean;
  locations: FleetBackupLocationStatus[];
}

export interface FleetBackupStatusPayload {
  configured: boolean;
  ok: boolean;
  asOf: string;
  cacheAgeSeconds: number;
  apps: FleetAppBackupStatus[];
  warnings: string[];
}

interface FleetAppSpec {
  id: FleetAppId;
  label: string;
  self: boolean;
  b2Bucket: string;
  dumpPrefix: string;
  litestreamPrefix: string | null;
  /** Public health URL that may expose checks.storage litestream fields. */
  peerHealthUrl: string | null;
}

function fleetAppSpecs(): FleetAppSpec[] {
  return [
    {
      id: "usage-monitor",
      label: "Usage Monitor",
      self: true,
      b2Bucket: "jays-usage-monitor-eu",
      dumpPrefix: "hetzner/",
      litestreamPrefix: "api-usage-monitor/",
      peerHealthUrl: null,
    },
    {
      id: "socratic-trade",
      label: "Socratic.Trade",
      self: false,
      b2Bucket: "jays-socratic-trade-eu",
      dumpPrefix: "hetzner/",
      // Live replica is trading-live/app.db (see ST litestream.coolify.yml).
      // Listed independently so a down ST process cannot hide a fresh B2 LTX.
      litestreamPrefix: "trading-live/",
      peerHealthUrl:
        process.env.FLEET_ST_HEALTH_URL?.trim() ||
        "https://socratictrade.com/api/health",
    },
    {
      id: "congress-trade",
      label: "Congress.Trade",
      self: false,
      b2Bucket: "jays-congress-trade-eu",
      dumpPrefix: "hetzner/",
      // Live replica path is congress-trade/db.sqlite (app/litestream.yml).
      // The old congress-live/ prefix was never written; listing it made
      // Platforms show B2 Litestream as Not Configured.
      litestreamPrefix: "congress-trade/",
      peerHealthUrl:
        process.env.FLEET_CT_HEALTH_URL?.trim() ||
        "https://congress.trade/api/health",
    },
  ];
}

/** Coolify UUID → fleet app for correlating host resources with backups. */
export const FLEET_COOLIFY_APP_UUIDS: Record<string, FleetAppId> = {
  ...(process.env.COOLIFY_USAGE_MONITOR_UUID ? { [process.env.COOLIFY_USAGE_MONITOR_UUID]: "usage-monitor" as const } : {}),
  ...(process.env.COOLIFY_SOCRATIC_UUID ? { [process.env.COOLIFY_SOCRATIC_UUID]: "socratic-trade" as const } : {}),
  ...(process.env.COOLIFY_CONGRESS_UUID ? { [process.env.COOLIFY_CONGRESS_UUID]: "congress-trade" as const } : {}),
};

interface CacheEntry {
  payload: FleetBackupStatusPayload;
  expiresAt: number;
  discardAt: number;
}

const runtime: {
  cache?: CacheEntry;
  inFlight?: Promise<FleetBackupStatusPayload>;
} = {};

export function resetFleetBackupStatusCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("fleet backup cache can only be reset in tests");
  }
  runtime.cache = undefined;
  runtime.inFlight = undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveMonitorCredentials():
  | { keyId: string; applicationKey: string }
  | null {
  const keyId =
    readText(process.env.BACKBLAZE_APPLICATION_KEY_ID) ||
    readText(process.env.B2_MONITOR_KEY_ID) ||
    readText(process.env.BACKBLAZE_KEY_ID) ||
    readText(process.env.B2_KEY_ID);
  const applicationKey =
    readText(process.env.BACKBLAZE_APPLICATION_KEY) ||
    readText(process.env.B2_MONITOR_APPLICATION_KEY) ||
    readText(process.env.B2_APPLICATION_KEY);
  if (!keyId || !applicationKey) return null;
  return { keyId, applicationKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ageOk(
  ageSeconds: number | null,
  maxAgeSeconds: number
): boolean | null {
  if (ageSeconds == null) return null;
  return ageSeconds <= maxAgeSeconds;
}

function locationOk(
  present: boolean,
  ageSeconds: number | null,
  maxAgeSeconds: number,
  required: boolean
): boolean | null {
  if (!present) return required ? false : null;
  const ok = ageOk(ageSeconds, maxAgeSeconds);
  return ok;
}

interface PrefixInventory {
  present: boolean;
  latestAgeSeconds: number | null;
  bytes: number;
  fileCount: number;
  reason: string | null;
}

interface B2Auth {
  apiUrl: string;
  token: string;
  accountId: string;
}

async function b2Authorize(
  keyId: string,
  applicationKey: string
): Promise<B2Auth> {
  const basic = Buffer.from(`${keyId}:${applicationKey}`, "utf8").toString(
    "base64"
  );
  const response = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    }
  );
  if (!response.ok) {
    throw new Error(`b2_authorize_account HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const apiUrl = readText(data.apiUrl);
  const token = readText(data.authorizationToken);
  const accountId = readText(data.accountId);
  if (!apiUrl || !token || !accountId) {
    throw new Error("b2_authorize_account missing fields");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), token, accountId };
}

async function b2Post(
  auth: B2Auth,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${auth.apiUrl}/b2api/v2/${path}`, {
    method: "POST",
    headers: {
      Authorization: auth.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (!isRecord(data)) throw new Error(`${path} non-object body`);
  return data;
}

async function listBucketsByName(
  auth: B2Auth
): Promise<Map<string, string>> {
  const data = await b2Post(auth, "b2_list_buckets", {
    accountId: auth.accountId,
  });
  const map = new Map<string, string>();
  if (!Array.isArray(data.buckets)) return map;
  for (const row of data.buckets) {
    if (!isRecord(row)) continue;
    const name = readText(row.bucketName);
    const id = readText(row.bucketId);
    if (name && id) map.set(name, id);
  }
  return map;
}

async function inventoryPrefix(
  auth: B2Auth,
  bucketId: string,
  prefix: string,
  nowMs: number,
  maxPages: number = B2_MAX_PAGES_PER_PREFIX
): Promise<PrefixInventory> {
  let fileCount = 0;
  let bytes = 0;
  let latestUploadMs: number | null = null;
  let startFileName: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const body: Record<string, unknown> = {
      bucketId,
      prefix,
      maxFileCount: B2_PAGE_SIZE,
    };
    if (startFileName) body.startFileName = startFileName;
    const data = await b2Post(auth, "b2_list_file_names", body);
    const files = Array.isArray(data.files) ? data.files : [];
    for (const f of files) {
      if (!isRecord(f)) continue;
      const action = readText(f.action);
      if (action && action !== "upload") continue;
      const size =
        typeof f.contentLength === "number" && Number.isFinite(f.contentLength)
          ? f.contentLength
          : 0;
      const ts =
        typeof f.uploadTimestamp === "number" &&
        Number.isFinite(f.uploadTimestamp)
          ? f.uploadTimestamp
          : null;
      fileCount += 1;
      bytes += size;
      if (ts != null && (latestUploadMs == null || ts > latestUploadMs)) {
        latestUploadMs = ts;
      }
    }
    pages += 1;
    const next = readText(data.nextFileName);
    if (!next || files.length === 0) break;
    startFileName = next;
  }

  // High-volume Litestream trees exceed maxPages.  b2_list_file_names is
  // lexicographic, so the first pages are the oldest L0 WAL names.
  // `prefix + "z"` is *after* `…/app.db/…` and `…/db.sqlite/…`, so it
  // never saw the live objects (ST B2 row stayed ~2 days stale while Live
  // Litestream was 35s).  Probe each known L0 directory from a high hex
  // start name so we pick up current uploads.
  if (pages >= maxPages) {
    const base = prefix.replace(/\/$/, "");
    const l0Prefixes = [
      `${base}/app.db/ltx/0/`,
      `${base}/db.sqlite/ltx/0/`,
      `${base}/ltx/0/`,
    ];
    for (const l0 of l0Prefixes) {
      try {
        const tailData = await b2Post(auth, "b2_list_file_names", {
          bucketId,
          prefix: l0,
          startFileName: `${l0}000000000003`,
          maxFileCount: 200,
        });
        const tailFiles = Array.isArray(tailData.files) ? tailData.files : [];
        for (const f of tailFiles) {
          if (!isRecord(f)) continue;
          const action = readText(f.action);
          if (action && action !== "upload") continue;
          const ts =
            typeof f.uploadTimestamp === "number" && Number.isFinite(f.uploadTimestamp)
              ? f.uploadTimestamp
              : null;
          if (ts != null && (latestUploadMs == null || ts > latestUploadMs)) {
            latestUploadMs = ts;
          }
        }
      } catch {
        // ignore optional tail probe failure
      }
    }
  }

  if (fileCount === 0) {
    return {
      present: false,
      latestAgeSeconds: null,
      bytes: 0,
      fileCount: 0,
      reason: "empty_prefix",
    };
  }

  const latestAgeSeconds =
    latestUploadMs != null
      ? Math.max(0, (nowMs - latestUploadMs) / 1000)
      : null;

  return {
    present: true,
    latestAgeSeconds,
    bytes,
    fileCount,
    reason: pages >= maxPages ? "list_truncated" : null,
  };
}

interface PeerR2WeeklyStatus {
  /** null when the peer has not shipped the field (or health failed). */
  ok: boolean | null;
  present: boolean;
  ageSeconds: number | null;
  reason: string | null;
}

interface PeerStorageHealth {
  litestreamAgeSeconds: number | null;
  litestreamReason: string | null;
  /** True when the peer reports a compaction-tier wedge even if L0 is fresh. */
  litestreamTiersDegraded: boolean;
  r2Weekly: PeerR2WeeklyStatus;
}

function continuousTierAgeSeconds(
  storage: Record<string, unknown>
): number | null {
  const tiers = Array.isArray(storage.litestreamTiers)
    ? storage.litestreamTiers
    : [];
  for (const raw of tiers) {
    if (!isRecord(raw)) continue;
    const isContinuous =
      raw.tier === "0" ||
      raw.tier === 0 ||
      raw.label === "Continuous Sync";
    if (!isContinuous) continue;
    const age = raw.ageSeconds;
    if (typeof age === "number" && Number.isFinite(age) && age >= 0) return age;
    const at = readText(raw.newestActivityAt);
    if (at) {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) return Math.max(0, (Date.now() - ms) / 1000);
    }
  }
  return null;
}

function peerLitestreamTiersDegraded(
  storage: Record<string, unknown>
): boolean {
  if (storage.litestreamTiersDegraded === true) return true;
  const tiers = Array.isArray(storage.litestreamTiers)
    ? storage.litestreamTiers
    : [];
  return tiers.some((raw) => isRecord(raw) && raw.degraded === true);
}

function missingPeerR2Weekly(reason: string): PeerR2WeeklyStatus {
  return {
    ok: null,
    present: false,
    ageSeconds: null,
    reason,
  };
}

function parsePeerR2Weekly(
  storage: Record<string, unknown>
): PeerR2WeeklyStatus {
  if (!Object.prototype.hasOwnProperty.call(storage, "r2Weekly")) {
    return missingPeerR2Weekly("peer_r2_weekly_missing");
  }
  const raw = storage.r2Weekly;
  if (raw == null) {
    return missingPeerR2Weekly("peer_r2_weekly_missing");
  }
  if (!isRecord(raw)) {
    return missingPeerR2Weekly("peer_r2_weekly_invalid");
  }
  const ok = typeof raw.ok === "boolean" ? raw.ok : null;
  const ageSeconds =
    typeof raw.ageSeconds === "number" &&
    Number.isFinite(raw.ageSeconds) &&
    raw.ageSeconds >= 0
      ? raw.ageSeconds
      : null;
  const reason = readText(raw.reason) ?? null;
  return {
    ok,
    present: true,
    ageSeconds,
    reason,
  };
}

/** One peer /api/health fetch: litestream age + optional R2 weekly archive. */
async function fetchPeerStorageHealth(
  url: string
): Promise<PeerStorageHealth> {
  // Same offline kill switch as operations-health.ts: no peer egress in e2e.
  if (operationsHealthEgressDisabled()) {
    return {
      litestreamAgeSeconds: null,
      litestreamReason: "peer_health_offline",
      litestreamTiersDegraded: false,
      r2Weekly: missingPeerR2Weekly("peer_health_offline"),
    };
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const reason = `peer_health_http_${response.status}`;
      return {
        litestreamAgeSeconds: null,
        litestreamReason: reason,
        litestreamTiersDegraded: false,
        r2Weekly: missingPeerR2Weekly(reason),
      };
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      return {
        litestreamAgeSeconds: null,
        litestreamReason: "peer_health_invalid",
        litestreamTiersDegraded: false,
        r2Weekly: missingPeerR2Weekly("peer_health_invalid"),
      };
    }
    const checks = isRecord(data.checks) ? data.checks : null;
    const storage = checks && isRecord(checks.storage) ? checks.storage : null;
    if (!storage) {
      return {
        litestreamAgeSeconds: null,
        litestreamReason: "peer_storage_missing",
        litestreamTiersDegraded: false,
        r2Weekly: missingPeerR2Weekly("peer_storage_missing"),
      };
    }

    let litestreamAgeSeconds: number | null = null;
    let litestreamReason: string | null = null;
    const age = storage.litestreamAgeSeconds;
    if (typeof age === "number" && Number.isFinite(age) && age >= 0) {
      litestreamAgeSeconds = age;
    } else {
      const lastSync = readText(storage.litestreamLastSyncAt);
      if (lastSync) {
        const ms = Date.parse(lastSync);
        if (Number.isFinite(ms)) {
          litestreamAgeSeconds = Math.max(0, (Date.now() - ms) / 1000);
        }
      }
      if (litestreamAgeSeconds == null) {
        litestreamAgeSeconds = continuousTierAgeSeconds(storage);
      }
      if (litestreamAgeSeconds == null) {
        litestreamReason = "peer_litestream_age_missing";
      }
    }

    const litestreamTiersDegraded = peerLitestreamTiersDegraded(storage);
    if (litestreamTiersDegraded) {
      litestreamReason = "peer_litestream_tiers_degraded";
    }

    return {
      litestreamAgeSeconds,
      litestreamReason,
      litestreamTiersDegraded,
      r2Weekly: parsePeerR2Weekly(storage),
    };
  } catch {
    return {
      litestreamAgeSeconds: null,
      litestreamReason: "peer_health_unreachable",
      litestreamTiersDegraded: false,
      r2Weekly: missingPeerR2Weekly("peer_health_unreachable"),
    };
  }
}

function buildPeerR2WeeklyLocation(
  r2Weekly: PeerR2WeeklyStatus
): FleetBackupLocationStatus {
  return {
    id: "r2-historic",
    label: "R2 Weekly Archive",
    ok: r2Weekly.ok,
    present: r2Weekly.present,
    latestAgeSeconds: r2Weekly.ageSeconds,
    bytes: null,
    fileCount: null,
    reason: r2Weekly.reason,
  };
}

function buildLocalLocation(
  now: Date
): FleetBackupLocationStatus {
  const layers = getBackupLayersStatus(now);
  const local = layers.local;
  return {
    id: "local",
    label: "Local Snapshots",
    ok: local.ok,
    present: local.present,
    latestAgeSeconds: local.latestAgeSeconds,
    bytes: local.latestSizeBytes,
    fileCount: local.count,
    reason: local.reason,
  };
}

function buildR2HistoricLocation(now: Date): FleetBackupLocationStatus {
  const layers = getBackupLayersStatus(now);
  const r2 = layers.r2Historic;
  return {
    id: "r2-historic",
    label: "R2 Weekly Archive",
    ok: r2.ok,
    present: r2.configured,
    latestAgeSeconds: r2.weeklyArchive?.ageSeconds ?? null,
    bytes: null,
    fileCount: null,
    reason: r2.reason,
  };
}

function buildUmPrimaryFromLayers(now: Date): FleetBackupLocationStatus {
  const layers = getBackupLayersStatus(now);
  const primary = layers.primary;
  const label =
    primary.label === "b2"
      ? "B2 Litestream"
      : primary.label === "r2"
        ? "R2 Litestream"
        : "Off-Site Litestream";
  return {
    id: "b2-litestream",
    label,
    ok: primary.ok,
    present: primary.active,
    latestAgeSeconds: primary.replicaAgeSeconds,
    bytes: null,
    fileCount: null,
    reason: primary.reason,
  };
}

function summarizeApp(
  locations: FleetBackupLocationStatus[]
): boolean {
  const decisive = locations.filter((l) => l.ok !== null);
  if (decisive.length === 0) return true;
  // App is ok if at least one required off-site location is healthy.
  // Prefer: litestream OR full dump present and fresh.
  const offsite = locations.filter(
    (l) =>
      l.id === "b2-full-dump" ||
      l.id === "b2-litestream" ||
      l.id === "peer-litestream"
  );
  if (offsite.some((l) => l.ok === true)) return true;
  if (offsite.every((l) => l.ok === false || !l.present)) return false;
  return !locations.some((l) => l.ok === false && l.present);
}

async function loadFresh(now: Date): Promise<FleetBackupStatusPayload> {
  const warnings: string[] = [];
  const creds = resolveMonitorCredentials();
  const nowMs = now.getTime();

  let auth: B2Auth | null = null;
  let buckets = new Map<string, string>();

  if (!creds) {
    warnings.push(
      "Backblaze monitor credentials are not configured; B2 dump and LTX inventory unavailable."
    );
  } else {
    try {
      auth = await b2Authorize(creds.keyId, creds.applicationKey);
      buckets = await listBucketsByName(auth);
    } catch (err) {
      warnings.push(
        `Backblaze authorization failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
      auth = null;
    }
  }

  const apps: FleetAppBackupStatus[] = [];

  for (const spec of fleetAppSpecs()) {
    const locations: FleetBackupLocationStatus[] = [];

    // --- B2 full dumps (hetzner/) ---
    if (auth) {
      const bucketId = buckets.get(spec.b2Bucket);
      if (!bucketId) {
        locations.push({
          id: "b2-full-dump",
          label: "B2 Full Dump",
          ok: false,
          present: false,
          latestAgeSeconds: null,
          bytes: null,
          fileCount: null,
          reason: "bucket_missing",
        });
      } else {
        try {
          const inv = await inventoryPrefix(
            auth,
            bucketId,
            spec.dumpPrefix,
            nowMs,
            2 // dumps are few
          );
          const ok = locationOk(
            inv.present,
            inv.latestAgeSeconds,
            FLEET_DUMP_MAX_AGE_SECONDS,
            true
          );
          locations.push({
            id: "b2-full-dump",
            label: "B2 Full Dump",
            ok,
            present: inv.present,
            latestAgeSeconds: inv.latestAgeSeconds,
            bytes: inv.bytes || null,
            fileCount: inv.fileCount || null,
            reason:
              ok === false && inv.present
                ? "dump_stale"
                : inv.reason,
          });
        } catch (err) {
          warnings.push(
            `${spec.label} B2 dump list failed: ${err instanceof Error ? err.message : "error"}`
          );
          locations.push({
            id: "b2-full-dump",
            label: "B2 Full Dump",
            ok: null,
            present: false,
            latestAgeSeconds: null,
            bytes: null,
            fileCount: null,
            reason: "list_failed",
          });
        }
      }
    } else {
      locations.push({
        id: "b2-full-dump",
        label: "B2 Full Dump",
        ok: null,
        present: false,
        latestAgeSeconds: null,
        bytes: null,
        fileCount: null,
        reason: "b2_unconfigured",
      });
    }

    // --- Continuous Litestream ---
    if (spec.self) {
      // Prefer in-process replica status (side-channel); also show B2 object
      // inventory when credentials work so operators see storage reality.
      locations.push(buildUmPrimaryFromLayers(now));
      if (auth && spec.litestreamPrefix) {
        const bucketId = buckets.get(spec.b2Bucket);
        if (bucketId) {
          try {
            const inv = await inventoryPrefix(
              auth,
              bucketId,
              spec.litestreamPrefix,
              nowMs,
              B2_MAX_PAGES_PER_PREFIX
            );
            // Only surface a separate object-store row when it adds signal.
            if (inv.present) {
              const ok = locationOk(
                inv.present,
                inv.latestAgeSeconds,
                FLEET_LITESTREAM_MAX_AGE_SECONDS,
                false
              );
              // Merge into the primary row if process status is env-only bad.
              const primary = locations.find((l) => l.id === "b2-litestream");
              if (primary && primary.ok === false && ok === true) {
                primary.ok = true;
                primary.present = true;
                primary.latestAgeSeconds = inv.latestAgeSeconds;
                primary.bytes = inv.bytes;
                primary.fileCount = inv.fileCount;
                primary.reason = "b2_objects_fresh";
              } else if (primary && primary.latestAgeSeconds == null && inv.latestAgeSeconds != null) {
                primary.latestAgeSeconds = inv.latestAgeSeconds;
                primary.bytes = inv.bytes;
                primary.fileCount = inv.fileCount;
                if (primary.present === false) primary.present = true;
              }
            }
          } catch {
            // non-fatal; primary row already present
          }
        }
      }
      locations.push(buildLocalLocation(now));
      locations.push(buildR2HistoricLocation(now));
    } else {
      // Peer apps: peer health litestream + B2 LTX + optional peer R2 weekly
      let peerR2Weekly: PeerR2WeeklyStatus | null = null;
      if (spec.peerHealthUrl) {
        const peer = await fetchPeerStorageHealth(spec.peerHealthUrl);
        const ageOk = locationOk(
          peer.litestreamAgeSeconds != null,
          peer.litestreamAgeSeconds,
          FLEET_LITESTREAM_MAX_AGE_SECONDS,
          false
        );
        // Continuous sync (L0) is the Live row.  A wedged higher compaction
        // tier is a warning on that same row, not "the replica is down".
        const present =
          peer.litestreamAgeSeconds != null || peer.litestreamTiersDegraded;
        const ok =
          peer.litestreamAgeSeconds != null
            ? ageOk
            : peer.litestreamTiersDegraded
              ? false
              : null;
        locations.push({
          id: "peer-litestream",
          label: "Live Litestream",
          ok,
          present,
          latestAgeSeconds: peer.litestreamAgeSeconds,
          bytes: null,
          fileCount: null,
          reason: peer.litestreamReason,
        });
        peerR2Weekly = peer.r2Weekly;
      }

      if (auth && spec.litestreamPrefix) {
        const bucketId = buckets.get(spec.b2Bucket);
        if (bucketId) {
          try {
            const inv = await inventoryPrefix(
              auth,
              bucketId,
              spec.litestreamPrefix,
              nowMs,
              B2_MAX_PAGES_PER_PREFIX
            );
            const ok = locationOk(
              inv.present,
              inv.latestAgeSeconds,
              FLEET_LITESTREAM_MAX_AGE_SECONDS,
              true
            );
            locations.push({
              id: "b2-litestream",
              label: "B2 Litestream",
              ok,
              present: inv.present,
              latestAgeSeconds: inv.latestAgeSeconds,
              bytes: inv.bytes || null,
              fileCount: inv.fileCount || null,
              reason:
                ok === false && inv.present
                  ? "ltx_stale"
                  : inv.reason,
            });
          } catch (err) {
            warnings.push(
              `${spec.label} B2 Litestream list failed: ${err instanceof Error ? err.message : "error"}`
            );
            locations.push({
              id: "b2-litestream",
              label: "B2 Litestream",
              ok: null,
              present: false,
              latestAgeSeconds: null,
              bytes: null,
              fileCount: null,
              reason: "list_failed",
            });
          }
        }
      } else if (spec.litestreamPrefix === "") {
        locations.push({
          id: "b2-litestream",
          label: "B2 Litestream",
          ok: null,
          present: false,
          latestAgeSeconds: null,
          bytes: null,
          fileCount: null,
          reason: "not_configured",
        });
      }

      // Optional: do not require for summarizeApp off-site health.
      if (peerR2Weekly) {
        locations.push(buildPeerR2WeeklyLocation(peerR2Weekly));
      }
    }

    apps.push({
      id: spec.id,
      label: spec.label,
      self: spec.self,
      ok: summarizeApp(locations),
      locations,
    });
  }

  const overallOk =
    apps.length > 0 && apps.every((a) => a.ok) && warnings.length === 0;

  return {
    configured: creds != null,
    ok: overallOk,
    asOf: now.toISOString(),
    cacheAgeSeconds: 0,
    apps,
    warnings,
  };
}

/**
 * Cached fleet backup status. Always resolves; never throws.
 */
export async function fetchFleetBackupStatus(
  now = new Date()
): Promise<FleetBackupStatusPayload> {
  const nowMs = now.getTime();
  if (runtime.cache && runtime.cache.expiresAt > nowMs) {
    return {
      ...runtime.cache.payload,
      cacheAgeSeconds: Math.max(
        0,
        Math.floor((nowMs - Date.parse(runtime.cache.payload.asOf)) / 1000)
      ),
    };
  }

  if (!runtime.inFlight) {
    runtime.inFlight = (async () => {
      try {
        const payload = await loadFresh(now);
        runtime.cache = {
          payload,
          expiresAt: Date.now() + FLEET_BACKUP_CACHE_TTL_MS,
          discardAt: Date.now() + 15 * 60_000,
        };
        return payload;
      } catch (err) {
        const previous = runtime.cache;
        if (previous && previous.discardAt > Date.now()) {
          return {
            ...previous.payload,
            cacheAgeSeconds: Math.max(
              0,
              Math.floor((Date.now() - Date.parse(previous.payload.asOf)) / 1000)
            ),
            warnings: [
              ...previous.payload.warnings,
              `Fleet backup refresh failed: ${err instanceof Error ? err.message : "error"}`,
            ],
            ok: false,
          };
        }
        return {
          configured: false,
          ok: false,
          asOf: new Date().toISOString(),
          cacheAgeSeconds: 0,
          apps: [],
          warnings: [
            `Fleet backup status unavailable: ${err instanceof Error ? err.message : "error"}`,
          ],
        };
      } finally {
        runtime.inFlight = undefined;
      }
    })();
  }

  return runtime.inFlight;
}
