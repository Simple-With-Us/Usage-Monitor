/**
 * Prevention-oriented host indicators + short process-local history for
 * `/api/server-metrics`. Helps catch OOM-adjacent pressure (CPU pegged),
 * disk fill, app restarts/stops, and backup lag before the next outage.
 *
 * History is an in-memory ring buffer (survives only while the Node process
 * lives). It is not a substitute for Prometheus/Hetzner long-term metrics —
 * it exists so the dashboard can show "what got worse in the last hour of
 * polls" without a separate time-series store.
 */

import type { FleetBackupStatusPayload } from "@/lib/fleet-backup-status";
import type {
  ServerMetricsMetricValue,
  ServerMetricsPayload,
  ServerMetricsResource,
} from "@/lib/server-metrics";

export type IndicatorSeverity = "info" | "warning" | "critical";

export interface HostIndicator {
  /** Stable machine id, e.g. `cpu_high`. */
  id: string;
  severity: IndicatorSeverity;
  /** Title Case short label for UI. */
  label: string;
  /** Sentence-case detail (fleet copy: two spaces between sentences). */
  detail: string;
  /** Optional subject (app name, metric). */
  subject?: string | null;
}

export interface HostMetricsSummary {
  /** Peak CPU % in the 1h series (0–100). */
  cpuPeakPct: number | null;
  /** Average CPU % over the 1h series. */
  cpuAvgPct: number | null;
  /** Latest sample CPU %. */
  cpuLatestPct: number | null;
  /** Sample count used for averages. */
  cpuSampleCount: number;
  /** Disk used % for the app volume. */
  diskUsedPct: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** Coolify app counts. */
  appsHealthy: number;
  appsDown: number;
  appsDegraded: number;
  appsUnknown: number;
  appsTotal: number;
  /** Fleet backup rollup. */
  backupAppsOk: number | null;
  backupAppsTotal: number | null;
  backupConfigured: boolean | null;
}

export interface HostHistorySample {
  at: string;
  cpuPct: number | null;
  diskUsedPct: number | null;
  appsDown: number;
  appsDegraded: number;
  /** Active indicator ids at this sample. */
  indicatorIds: string[];
  overall: "ok" | "warning" | "critical";
}

export interface HostPreventionPanel {
  overall: "ok" | "warning" | "critical";
  summary: HostMetricsSummary;
  indicators: HostIndicator[];
  /** Newest last; up to HISTORY_MAX samples. */
  history: HostHistorySample[];
  historyNote: string;
}

const HISTORY_MAX = 48; // ~48 polls × 2 min cache ≈ multi-hour window when active
const CPU_HIGH_PCT = 85;
const CPU_ELEVATED_PCT = 70;
const DISK_WARN_USED_PCT = 80;
const DISK_CRITICAL_USED_PCT = 92;
const DISK_CRITICAL_FREE_BYTES = 3 * 1024 ** 3; // 3 GiB

const historyRing: HostHistorySample[] = [];

export function resetHostMetricsHistoryForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("host metrics history can only be reset in tests");
  }
  historyRing.length = 0;
}

function isHealthyStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return lower.includes("healthy") || lower === "running";
}

function isDownStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return (
    lower.includes("exited") ||
    lower.includes("stopped") ||
    lower.includes("dead") ||
    lower.includes("restarting")
  );
}

function isDegradedStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return lower.includes("unhealthy") || lower.includes("degraded");
}

function seriesStats(series: ServerMetricsMetricValue[]): {
  peak: number | null;
  avg: number | null;
  latest: number | null;
  count: number;
} {
  if (!series.length) {
    return { peak: null, avg: null, latest: null, count: 0 };
  }
  let sum = 0;
  let peak = -Infinity;
  for (const point of series) {
    sum += point.value;
    if (point.value > peak) peak = point.value;
  }
  return {
    peak: Number.isFinite(peak) ? peak : null,
    avg: sum / series.length,
    latest: series[series.length - 1]?.value ?? null,
    count: series.length,
  };
}

function countApps(resources: ServerMetricsResource[]): {
  healthy: number;
  down: number;
  degraded: number;
  unknown: number;
  total: number;
} {
  let healthy = 0;
  let down = 0;
  let degraded = 0;
  let unknown = 0;
  for (const r of resources) {
    if (r.type && r.type !== "application" && !r.type.includes("application")) {
      // Still count all resources that look like services; Coolify uses "application".
    }
    if (isHealthyStatus(r.status)) healthy += 1;
    else if (isDownStatus(r.status)) down += 1;
    else if (isDegradedStatus(r.status)) degraded += 1;
    else unknown += 1;
  }
  return {
    healthy,
    down,
    degraded,
    unknown,
    total: resources.length,
  };
}

function severityRank(s: IndicatorSeverity): number {
  if (s === "critical") return 2;
  if (s === "warning") return 1;
  return 0;
}

function overallFromIndicators(
  indicators: HostIndicator[]
): "ok" | "warning" | "critical" {
  let worst: IndicatorSeverity = "info";
  for (const i of indicators) {
    if (severityRank(i.severity) > severityRank(worst)) worst = i.severity;
  }
  if (worst === "critical") return "critical";
  if (worst === "warning") return "warning";
  return "ok";
}

/**
 * Pure derivation of prevention indicators + summary from a metrics payload.
 * Does not mutate history.
 */
export function buildHostPreventionSnapshot(
  payload: Pick<
    ServerMetricsPayload,
    "hostUsage" | "metrics" | "resources" | "appDisk" | "fleetBackups" | "stale" | "degraded" | "error"
  >
): Omit<HostPreventionPanel, "history" | "historyNote"> {
  const cpu = seriesStats(payload.metrics.cpu);
  // Prefer series latest; fall back to hostUsage rollup.
  const cpuLatest =
    cpu.latest ??
    (typeof payload.hostUsage.cpuPct === "number"
      ? payload.hostUsage.cpuPct
      : null);
  const cpuPeak = cpu.peak ?? cpuLatest;
  const cpuAvg = cpu.avg ?? cpuLatest;

  const apps = countApps(payload.resources);
  const diskUsed = payload.appDisk.usedPct;
  const diskFree = payload.appDisk.freeBytes;
  const diskTotal = payload.appDisk.totalBytes;

  const fleet = payload.fleetBackups;
  const backupAppsOk =
    fleet?.apps != null ? fleet.apps.filter((a) => a.ok).length : null;
  const backupAppsTotal = fleet?.apps != null ? fleet.apps.length : null;

  const summary: HostMetricsSummary = {
    cpuPeakPct: cpuPeak,
    cpuAvgPct: cpuAvg,
    cpuLatestPct: cpuLatest,
    cpuSampleCount: cpu.count,
    diskUsedPct: diskUsed,
    diskFreeBytes: diskFree,
    diskTotalBytes: diskTotal,
    appsHealthy: apps.healthy,
    appsDown: apps.down,
    appsDegraded: apps.degraded,
    appsUnknown: apps.unknown,
    appsTotal: apps.total,
    backupAppsOk,
    backupAppsTotal,
    backupConfigured: fleet?.configured ?? null,
  };

  const indicators: HostIndicator[] = [];

  if (cpuPeak != null && cpuPeak >= CPU_HIGH_PCT) {
    indicators.push({
      id: "cpu_high",
      severity: "critical",
      label: "CPU High",
      detail: `Host CPU peaked at ${Math.round(cpuPeak)}% in the last hour.  Sustained pegging can trigger OOMs and Coolify restarts (recent ST Litestream loop).`,
    });
  } else if (
    (cpuAvg != null && cpuAvg >= CPU_ELEVATED_PCT) ||
    (cpuLatest != null && cpuLatest >= CPU_ELEVATED_PCT)
  ) {
    const shown = Math.round(cpuAvg ?? cpuLatest ?? 0);
    indicators.push({
      id: "cpu_elevated",
      severity: "warning",
      label: "CPU Elevated",
      detail: `Host CPU around ${shown}%.  Watch for Litestream or bulk jobs competing with apps.`,
    });
  }

  if (
    (diskUsed != null && diskUsed >= DISK_CRITICAL_USED_PCT) ||
    (diskFree != null && diskFree < DISK_CRITICAL_FREE_BYTES)
  ) {
    const freeGiB =
      diskFree != null ? (diskFree / 1024 ** 3).toFixed(1) : "unknown";
    indicators.push({
      id: "disk_critical",
      severity: "critical",
      label: "Disk Critical",
      detail: `App volume free space is low (${freeGiB} GiB free${diskUsed != null ? `, ${diskUsed}% used` : ""}).  Prune local backups and large volume debris before SQLite or deploys fail.`,
    });
  } else if (diskUsed != null && diskUsed >= DISK_WARN_USED_PCT) {
    indicators.push({
      id: "disk_pressure",
      severity: "warning",
      label: "Disk Pressure",
      detail: `App volume is ${diskUsed}% used.  Keep local backup retention tight now that B2 holds off-site copies.`,
    });
  } else if (payload.appDisk.ok === false) {
    indicators.push({
      id: "disk_below_threshold",
      severity: "warning",
      label: "Disk Below Threshold",
      detail:
        "Disk free space is under the readiness warn threshold.  Plan cleanup before the next deploy.",
    });
  }

  for (const r of payload.resources) {
    const name = r.fleetLabel ?? r.name;
    if (isDownStatus(r.status)) {
      indicators.push({
        id: `app_down_${r.uuid}`,
        severity: "critical",
        label: "App Down",
        subject: name,
        detail: `${name} reports ${r.status}.  Check Coolify logs for OOM (exit 137) or crash loops.`,
      });
    } else if (isDegradedStatus(r.status)) {
      indicators.push({
        id: `app_degraded_${r.uuid}`,
        severity: "warning",
        label: "App Degraded",
        subject: name,
        detail: `${name} reports ${r.status}.  Confirm health endpoints and memory limits.`,
      });
    }
  }

  if (fleet && fleet.configured) {
    for (const app of fleet.apps) {
      if (app.ok === false) {
        const lagging = app.locations
          .filter((l) => l.ok === false)
          .map((l) => l.label)
          .slice(0, 3);
        indicators.push({
          id: `backup_lag_${app.id}`,
          severity: "warning",
          label: "Backup Lagging",
          subject: app.label,
          detail: `${app.label} off-site backup is lagging${lagging.length ? ` (${lagging.join(", ")})` : ""}.  Verify Litestream and the 6h host dump cron.`,
        });
      }
    }
  } else if (fleet && fleet.configured === false) {
    indicators.push({
      id: "backup_unconfigured",
      severity: "info",
      label: "Backup Monitor Off",
      detail:
        "Backblaze monitor credentials are not set, so B2 dump ages cannot be verified from this process.",
    });
  }

  if (payload.stale) {
    indicators.push({
      id: "metrics_stale",
      severity: "warning",
      label: "Metrics Stale",
      detail:
        "Showing a cached infrastructure snapshot because a provider failed.  Numbers may lag the host.",
    });
  }

  if (payload.error) {
    indicators.push({
      id: "provider_error",
      severity: "warning",
      label: "Provider Error",
      detail: payload.error,
    });
  }

  // Sort critical first, then warning, then info.
  indicators.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  );

  return {
    overall: overallFromIndicators(indicators),
    summary,
    indicators,
  };
}

/**
 * Append a history sample from the current snapshot and return the panel
 * including the ring buffer (newest last).
 */
export function recordAndBuildPreventionPanel(
  payload: Pick<
    ServerMetricsPayload,
    | "hostUsage"
    | "metrics"
    | "resources"
    | "appDisk"
    | "fleetBackups"
    | "stale"
    | "degraded"
    | "error"
    | "asOf"
  >
): HostPreventionPanel {
  const snap = buildHostPreventionSnapshot(payload);
  const sample: HostHistorySample = {
    at: payload.asOf,
    cpuPct: snap.summary.cpuLatestPct,
    diskUsedPct: snap.summary.diskUsedPct,
    appsDown: snap.summary.appsDown,
    appsDegraded: snap.summary.appsDegraded,
    indicatorIds: snap.indicators.map((i) => i.id),
    overall: snap.overall,
  };

  const last = historyRing[historyRing.length - 1];
  // Avoid duplicate samples when cache returns the same asOf.
  if (!last || last.at !== sample.at) {
    historyRing.push(sample);
    while (historyRing.length > HISTORY_MAX) {
      historyRing.shift();
    }
  }

  return {
    ...snap,
    history: [...historyRing],
    historyNote:
      "Process-local history of recent polls (clears on container restart).  Use Hetzner/Coolify for long-term metrics.",
  };
}

/** Test helper: seed history without going through metrics fetch. */
export function seedHostMetricsHistoryForTests(
  samples: HostHistorySample[]
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("seedHostMetricsHistoryForTests is test-only");
  }
  historyRing.length = 0;
  historyRing.push(...samples.slice(-HISTORY_MAX));
}

export function analyzeFleetBackupForIndicators(
  fleet: FleetBackupStatusPayload | null
): HostIndicator[] {
  return buildHostPreventionSnapshot({
    hostUsage: {
      cpuPct: null,
      networkRxBytesPerSec: null,
      networkTxBytesPerSec: null,
      diskReadBytesPerSec: null,
      diskWriteBytesPerSec: null,
    },
    metrics: {
      cpu: [],
      networkRx: [],
      networkTx: [],
      diskRead: [],
      diskWrite: [],
    },
    resources: [],
    appDisk: {
      freeBytes: null,
      totalBytes: null,
      usedPct: null,
      ok: true,
    },
    fleetBackups: fleet,
    stale: false,
    degraded: false,
  }).indicators.filter((i) => i.id.startsWith("backup_"));
}
