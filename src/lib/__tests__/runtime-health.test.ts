import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDatabaseFileBaseline,
  backupLayersGatesOk,
  getBackupLayersStatus,
  getBackupRuntimeStatus,
  getDatabaseFileStatus,
  getDiskRuntimeStatus,
  getLocalBackupRuntimeStatus,
  getLitestreamReplicaTarget,
  getPublicR2WeeklyHealth,
  getR2HistoricBackupStatus,
  getR2WeeklyArchiveStatus,
  presentR2HistoricLayer,
  formatBackupAgeSeconds,
  getAppliedSchedulerGate,
  getRuntimeIdentity,
  getSchedulerReadiness,
  getSchedulerRuntimeStatus,
  isSchedulerEnabled,
  recordSchedulerGate,
  getStartupRuntimeStatus,
  markSchedulerStarted,
  markSchedulerTickCompleted,
  markSchedulerTickStarted,
  resetRuntimeHealthForTests,
} from "../runtime-health";

describe("runtime health state", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
  });

  it("isSchedulerEnabled() reads live env until recordSchedulerGate pins boot value", () => {
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    expect(isSchedulerEnabled()).toBe(false);

    recordSchedulerGate(true);
    expect(isSchedulerEnabled()).toBe(true);
    expect(getAppliedSchedulerGate()).toBe(true);

    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    expect(isSchedulerEnabled()).toBe(true);
  });

  it("records scheduler lifecycle without exposing adapter errors", () => {
    const startedAt = new Date("2026-07-11T12:00:00.000Z");
    const tickAt = new Date("2026-07-11T12:01:00.000Z");
    const completedAt = new Date("2026-07-11T12:01:05.000Z");

    markSchedulerStarted(startedAt);
    markSchedulerTickStarted(tickAt);
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      startedAt: startedAt.toISOString(),
      tickInProgress: true,
      lastTickStartedAt: tickAt.toISOString(),
    });

    const unsafeSummary = {
      total: 4,
      successes: 2,
      failures: 1,
      skipped: 1,
      maintenanceHealthy: true,
      providerFetchDegraded: false,
      cloudflareLegacyHandoff: "disabled" as const,
      targetId: "must-not-leak-target-id",
      rawEnv: "must-not-leak-env-value",
      billingPayload: "must-not-leak-billing-payload",
      providerError: "must-not-leak-provider-error",
    };
    markSchedulerTickCompleted(
      true,
      unsafeSummary,
      completedAt
    );
    const runtime = getSchedulerRuntimeStatus();
    expect(runtime).toMatchObject({
      tickInProgress: false,
      lastTickCompletedAt: completedAt.toISOString(),
      lastTickSucceeded: true,
      consecutiveFailures: 0,
      firstFailureAt: null,
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
      lastRun: {
        total: 4,
        successes: 2,
        failures: 1,
        skipped: 1,
        maintenanceHealthy: true,
        providerFetchDegraded: false,
        cloudflareLegacyHandoff: "disabled",
      },
    });
    expect(Object.keys(runtime.lastRun ?? {}).sort()).toEqual(
      [
        "cloudflareLegacyHandoff",
        "failures",
        "maintenanceHealthy",
        "providerFetchDegraded",
        "skipped",
        "successes",
        "total",
      ].sort()
    );
    expect(JSON.stringify(runtime)).not.toContain("must-not-leak");
  });

  it("preserves scheduler summary fields in lastRun without attaching provider details (AGENTS.md L226-228)", () => {
    markSchedulerStarted();
    const tickAt = new Date("2026-09-12T12:00:00.000Z");
    markSchedulerTickStarted(tickAt);
    const summary = {
      total: 27,
      successes: 0,
      failures: 2,
      skipped: 25,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, summary, tickAt);
    const runtime = getSchedulerRuntimeStatus();
    expect(runtime.lastRun).toEqual({
      total: 27,
      successes: 0,
      failures: 2,
      skipped: 25,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled",
    });
    // AGENTS.md lines 226-228: /api/ready exposes the scheduler summary without
    // attaching target/provider IDs, env values, billing payloads, or provider errors.
    expect("failedProviders" in (runtime.lastRun ?? {})).toBe(false);
  });

  it("reports release identity and backup enforcement from non-secret env", () => {
    vi.stubEnv("RENDER_SERVICE_NAME", "usage-prod");
    vi.stubEnv("RENDER_GIT_COMMIT", "abc123");
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");

    expect(getRuntimeIdentity()).toMatchObject({
      service: "usage-prod",
      revision: "abc123",
    });
    expect(getBackupRuntimeStatus()).toEqual({
      required: true,
      active: true,
      envOnly: true,
      replicaOk: null,
      replicaAgeSeconds: null,
      // An env-only claim is never proof the replica is advancing, so the
      // side-channel is mandatory unless explicitly opted out.
      verificationRequired: true,
      reason: "env_active_unverified",
    });
    // LITESTREAM_REQUIRED=true also makes the verified startup wrapper
    // mandatory, regardless of hosting platform.
    expect(getStartupRuntimeStatus()).toEqual({
      required: true,
      active: false,
      entrypoint: null,
    });
  });

  
  it("prefers Coolify SOURCE_COMMIT over stale GIT_COMMIT_SHA", () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "");
    vi.stubEnv("GIT_COMMIT_SHA", "stale-oracle-sha");
    vi.stubEnv("SOURCE_COMMIT", "coolify-live-sha");
    expect(getRuntimeIdentity()).toMatchObject({
      revision: "coolify-live-sha",
    });
  });

  it("reads Coolify SOURCE_COMMIT when Render/GitHub commit env is unset", () => {
    vi.stubEnv("RENDER_GIT_COMMIT", "");
    vi.stubEnv("GIT_COMMIT_SHA", "");
    vi.stubEnv("SOURCE_COMMIT", "deadbeefcafebabe");

    expect(getRuntimeIdentity()).toMatchObject({
      revision: "deadbeefcafebabe",
    });
  });

  it("requires the startup wrapper in production mode and on Litestream-required hosts", () => {
    // Plain test/dev mode without Litestream: not required.
    expect(getStartupRuntimeStatus()).toEqual({
      required: false,
      active: false,
      entrypoint: null,
    });

    // Production mode requires the wrapper so a bare `npm start` fails strict
    // readiness instead of silently skipping backup/migration/Litestream.
    vi.stubEnv("NODE_ENV", "production");
    expect(getStartupRuntimeStatus().required).toBe(true);

    // Explicit opt-out for disposable throwaway containers.
    vi.stubEnv("STARTUP_WRAPPER_REQUIRED", "false");
    expect(getStartupRuntimeStatus().required).toBe(false);
    vi.unstubAllEnvs();

    // Litestream-required hosts need the wrapper in any NODE_ENV.
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    expect(getStartupRuntimeStatus().required).toBe(true);

    // The wrapper marks itself via APP_STARTUP_WRAPPER.
    vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");
    expect(getStartupRuntimeStatus()).toEqual({
      required: true,
      active: true,
      entrypoint: "start-with-litestream-v2",
    });
  });

  it("reports steady-state disk headroom against the warn threshold", () => {
    const status = getDiskRuntimeStatus();
    expect(status).toMatchObject({
      ok: true,
      thresholdBytes: 5 * 1024 * 1024 * 1024,
      reason: null,
    });
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.totalBytes).toBeGreaterThan(0);

    // DATABASE_URL's directory wins over the cwd fallback.
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
    expect(getDiskRuntimeStatus().ok).toBe(true);

    // A warn threshold above current free space flips only this check.
    vi.stubEnv("READY_DISK_WARN_FREE_BYTES", "1000000000000000000");
    expect(getDiskRuntimeStatus()).toMatchObject({
      ok: false,
      reason: "free_bytes_below_warn_threshold",
      thresholdBytes: 1e18,
    });
    vi.unstubAllEnvs();

    // An unreadable database directory degrades the check, never throws.
    vi.stubEnv("DATABASE_URL", "file:/nonexistent-usage-monitor-dir/prod.db");
    expect(getDiskRuntimeStatus()).toMatchObject({
      ok: false,
      freeBytes: null,
      totalBytes: null,
      reason: "disk_stat_failed",
    });
  });

  it("treats missing replica side-channel as unhealthy when configured (C4)", () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    vi.stubEnv(
      "LITESTREAM_REPLICA_STATUS_PATH",
      "/tmp/usage-monitor-missing-replica-status.json"
    );

    expect(getBackupRuntimeStatus()).toMatchObject({
      required: true,
      active: true,
      envOnly: false,
      replicaOk: false,
      verificationRequired: true,
      reason: "replica_status_missing",
    });
  });

  it("accepts the replica heartbeat JSON contract written by the Oracle probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-monitor-replica-status-"));
    const statusPath = join(dir, ".litestream-replica-status.json");
    const now = new Date("2026-08-01T12:00:00.000Z");
    try {
      vi.stubEnv("LITESTREAM_REQUIRED", "true");
      vi.stubEnv("LITESTREAM_ACTIVE", "true");
      vi.stubEnv("LITESTREAM_REPLICA_STATUS_PATH", statusPath);

      // Shape written by deploy/retired/oracle/replica-status-probe.sh. It omits
      // `ageSeconds` ON PURPOSE: the parser prefers ageSeconds over
      // checkedAt, and a frozen ageSeconds in a file left behind by a dead
      // probe would pass forever. checkedAt must drive staleness.
      writeFileSync(
        statusPath,
        JSON.stringify({
          ok: true,
          checkedAt: "2026-08-01T11:55:00Z",
          ltxAgeSeconds: 42,
          reason: null,
        })
      );
      expect(getBackupRuntimeStatus(now)).toMatchObject({
        envOnly: false,
        replicaOk: true,
        replicaAgeSeconds: 300,
        reason: null,
      });

      // A probe that stopped running ages out via checkedAt (fail closed).
      // Default budget is 3h (aligned with 1h Litestream sync); 4h is stale.
      writeFileSync(
        statusPath,
        JSON.stringify({
          ok: true,
          checkedAt: "2026-08-01T08:00:00Z",
          ltxAgeSeconds: 42,
          reason: null,
        })
      );
      expect(getBackupRuntimeStatus(now)).toMatchObject({
        replicaOk: false,
        reason: "replica_status_stale",
      });

      // A fresh but unhealthy verdict fails immediately and surfaces the
      // probe's own reason (not a generic unhealthy).
      writeFileSync(
        statusPath,
        JSON.stringify({
          ok: false,
          checkedAt: "2026-08-01T11:59:00Z",
          ltxAgeSeconds: 9000,
          reason: "ltx_age_exceeds_budget",
        })
      );
      expect(getBackupRuntimeStatus(now)).toMatchObject({
        replicaOk: false,
        reason: "ltx_age_exceeds_budget",
      });

      // Free-tier kill switch from the host probe.
      writeFileSync(
        statusPath,
        JSON.stringify({
          ok: false,
          checkedAt: "2026-08-01T11:59:30Z",
          reason: "r2_free_tier_disabled",
        })
      );
      expect(getBackupRuntimeStatus(now)).toMatchObject({
        replicaOk: false,
        reason: "r2_free_tier_disabled",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows an explicit opt-out from replica verification", () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    vi.stubEnv("LITESTREAM_REPLICA_VERIFICATION_REQUIRED", "false");

    expect(getBackupRuntimeStatus()).toMatchObject({
      envOnly: true,
      replicaOk: null,
      verificationRequired: false,
      reason: "env_active_unverified",
    });
  });

  it("classifies Litestream endpoints as b2 / r2 / unknown", () => {
    vi.stubEnv(
      "LITESTREAM_S3_ENDPOINT",
      "https://s3.eu-central-003.backblazeb2.com"
    );
    expect(getLitestreamReplicaTarget()).toBe("b2");

    vi.stubEnv(
      "LITESTREAM_S3_ENDPOINT",
      "https://abc.r2.cloudflarestorage.com"
    );
    expect(getLitestreamReplicaTarget()).toBe("r2");

    vi.stubEnv("LITESTREAM_S3_ENDPOINT", "https://garage.example.invalid");
    expect(getLitestreamReplicaTarget()).toBe("unknown");
  });

  it("reports local pre-migration backup inventory without leaking paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-monitor-local-backup-"));
    const dbPath = join(dir, "prod.db");
    const backupDir = join(dir, ".pre-migration-backups");
    try {
      writeFileSync(dbPath, "sqlite-placeholder\n");
      mkdirSync(backupDir, { recursive: true });
      vi.stubEnv("DATABASE_URL", `file:${dbPath}`);

      expect(getLocalBackupRuntimeStatus()).toMatchObject({
        ok: false,
        present: true,
        count: 0,
        reason: "no_verified_backups",
      });

      const backupPath = join(backupDir, "prod-2026-08-01.backup.db");
      writeFileSync(backupPath, "backup-bytes\n");
      const now = new Date("2026-08-02T00:00:00.000Z");
      const status = getLocalBackupRuntimeStatus(now);
      expect(status).toMatchObject({
        ok: true,
        present: true,
        count: 1,
        reason: null,
      });
      expect(status.latestAgeSeconds).not.toBeNull();
      expect(status.latestSizeBytes).toBeGreaterThan(0);
      expect(JSON.stringify(status)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels R2 as historic when Litestream points at B2", () => {
    vi.stubEnv(
      "LITESTREAM_S3_ENDPOINT",
      "https://s3.eu-central-003.backblazeb2.com"
    );
    vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
    vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));
    expect(getR2HistoricBackupStatus()).toMatchObject({
      configured: true,
      litestreamUsesR2: false,
      role: "historic",
      ok: false,
      reason: "archive_not_run",
      weeklyArchive: null,
    });

    const layers = getBackupLayersStatus();
    expect(layers.primary.label).toBe("b2");
    expect(layers.r2Historic.role).toBe("historic");
    expect(layers.local).toBeDefined();
    expect(backupLayersGatesOk(layers)).toBe(
      layers.local.ok && layers.primary.ok && layers.r2Historic.ok
    );
  });

  it("backupLayersGatesOk is the AND of the three layer ok flags", () => {
    expect(
      backupLayersGatesOk({
        local: {
          ok: true,
          present: true,
          count: 1,
          latestAgeSeconds: 1,
          latestSizeBytes: 1,
          reason: null,
          title: "Local Backup",
          detail: null,
        },
        primary: {
          ok: true,
          target: "b2",
          label: "b2",
          required: true,
          active: true,
          replicaOk: true,
          replicaAgeSeconds: 12,
          envOnly: false,
          verificationRequired: false,
          reason: null,
          title: "B2",
          detail: null,
        },
        r2Historic: {
          configured: true,
          litestreamUsesR2: false,
          autoDisabled: false,
          role: "historic",
          ok: true,
          reason: null,
          weeklyArchive: null,
          title: "R2 Historic",
          detail: null,
        },
      })
    ).toBe(true);
    expect(
      backupLayersGatesOk({
        local: {
          ok: true,
          present: true,
          count: 1,
          latestAgeSeconds: 1,
          latestSizeBytes: 1,
          reason: null,
          title: "Local Backup",
          detail: null,
        },
        primary: {
          ok: true,
          target: "b2",
          label: "b2",
          required: true,
          active: true,
          replicaOk: true,
          replicaAgeSeconds: 12,
          envOnly: false,
          verificationRequired: false,
          reason: null,
          title: "B2",
          detail: null,
        },
        r2Historic: {
          configured: true,
          litestreamUsesR2: false,
          autoDisabled: false,
          role: "historic",
          ok: false,
          reason: "archive_not_run",
          weeklyArchive: null,
          title: "R2 Historic",
          detail: "archive not run",
        },
      })
    ).toBe(false);
  });

  describe("weekly R2 archive status", () => {
    function writeArchiveStatus(payload: unknown): string {
      const dir = mkdtempSync(join(tmpdir(), "r2-archive-status-"));
      const path = join(dir, "status.json");
      writeFileSync(path, JSON.stringify(payload), "utf8");
      return path;
    }

    it("returns null when the job has never run", () => {
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));
      expect(getR2WeeklyArchiveStatus()).toBeNull();
    });

    it("reports a fresh successful archive as ok", () => {
      const path = writeArchiveStatus({
        ok: true,
        key: "weekly/prod-2026-08-12T00-00-00Z.db.gz",
        completedAt: new Date(Date.now() - 3_600_000).toISOString(),
        prunedCount: 1,
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

      const status = getR2WeeklyArchiveStatus();
      expect(status).toMatchObject({ ok: true, prunedCount: 1, reason: null });
      expect(status?.ageSeconds).toBeGreaterThanOrEqual(3_500);
    });

    it("flags an archive older than the weekly window as stale", () => {
      const path = writeArchiveStatus({
        ok: true,
        key: "weekly/old.db.gz",
        completedAt: new Date(Date.now() - 9 * 24 * 3_600_000).toISOString(),
        pruned: [],
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
      expect(getR2WeeklyArchiveStatus()).toMatchObject({
        ok: false,
        reason: "archive_stale",
      });
    });

    it("surfaces a failed run's reason code", () => {
      const path = writeArchiveStatus({
        ok: false,
        reason: "verify_hash_mismatch",
        checkedAt: new Date().toISOString(),
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
      expect(getR2WeeklyArchiveStatus()).toMatchObject({
        ok: false,
        reason: "verify_hash_mismatch",
        ageSeconds: null,
      });
    });

    it("does not treat a failed attempt's checkedAt as archive age", () => {
      const path = writeArchiveStatus({
        ok: false,
        reason: "upload_failed",
        checkedAt: new Date().toISOString(),
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
      expect(getR2WeeklyArchiveStatus()?.ageSeconds).toBeNull();
    });

    it("keeps last-success age when a later run fails", () => {
      const path = writeArchiveStatus({
        ok: false,
        reason: "verify_hash_mismatch",
        checkedAt: new Date().toISOString(),
        completedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        key: "weekly/prod-last-good.db.gz",
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
      const status = getR2WeeklyArchiveStatus();
      expect(status).toMatchObject({ ok: false, reason: "verify_hash_mismatch" });
      expect(status?.ageSeconds).toBeGreaterThanOrEqual(7_000);
      expect(status?.ageSeconds).toBeLessThan(8_000);
    });

    it("rejects a reason that is not one of the job's own codes", () => {
      // Defence in depth: the file should only ever contain a fixed code, so
      // anything free-form is treated as an unlabelled failure rather than
      // rendered verbatim in the UI.
      const path = writeArchiveStatus({
        ok: false,
        reason: "<Error><Message>Unauthorized</Message></Error>",
        checkedAt: new Date().toISOString(),
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
      expect(getR2WeeklyArchiveStatus()).toMatchObject({
        ok: false,
        reason: "archive_failed",
      });
    });

    it("a stale archive is amber on r2Historic but never gates readiness", () => {
      vi.stubEnv("LITESTREAM_S3_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com");
      vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
      vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
      const path = writeArchiveStatus({
        ok: true,
        key: "weekly/old.db.gz",
        completedAt: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

      const status = getR2HistoricBackupStatus();
      // Layer is not ok (iOS must not show a green check) but backup layers
      // never flip `/api/ready` ok — that gate is tested via backupLayers
      // exclusion in the ready route.
      expect(status.ok).toBe(false);
      expect(status.reason).toBe("archive_stale");
      expect(status.weeklyArchive?.ok).toBe(false);
    });

    it("a never-run archive is not ok and names archive_not_run", () => {
      vi.stubEnv("LITESTREAM_S3_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com");
      vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
      vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));

      expect(getR2HistoricBackupStatus()).toMatchObject({
        role: "historic",
        ok: false,
        reason: "archive_not_run",
        weeklyArchive: null,
      });
    });

    it("phones render server title/detail so copy can change without an iOS build", () => {
      vi.stubEnv("LITESTREAM_S3_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com");
      vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
      vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
      const path = writeArchiveStatus({
        ok: true,
        key: "weekly/prod-2026-08-12T00-00-00Z.db.gz",
        completedAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

      const layers = getBackupLayersStatus();
      expect(layers.r2Historic.title).toBe("R2 Weekly Archive");
      expect(layers.r2Historic.detail).toMatch(/latest 1h ago/);
      expect(presentR2HistoricLayer(layers.r2Historic).title).toBe("R2 Weekly Archive");
      expect(formatBackupAgeSeconds(3600)).toBe("latest 1h ago");
    });

    it("a fresh weekly archive makes historic R2 ok", () => {
      vi.stubEnv("LITESTREAM_S3_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com");
      vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
      vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
      const path = writeArchiveStatus({
        ok: true,
        key: "weekly/prod-2026-08-12T00-00-00Z.db.gz",
        completedAt: new Date(Date.now() - 3_600_000).toISOString(),
        prunedCount: 0,
      });
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

      expect(getR2HistoricBackupStatus()).toMatchObject({
        role: "historic",
        ok: true,
        reason: null,
      });
      expect(getR2HistoricBackupStatus().weeklyArchive?.ok).toBe(true);
    });

    describe("public health view (checks.storage.r2Weekly)", () => {
      it("reports no_receipt when the job has never run", () => {
        vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));
        expect(getPublicR2WeeklyHealth()).toEqual({
          ok: false,
          key: null,
          ageSeconds: null,
          staleness: "unknown",
          reason: "no_receipt",
        });
      });

      it("reports no_receipt when the receipt file is unreadable", () => {
        const dir = mkdtempSync(join(tmpdir(), "r2-archive-status-"));
        const path = join(dir, "status.json");
        writeFileSync(path, "not json", "utf8");
        vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);
        expect(getPublicR2WeeklyHealth()).toEqual({
          ok: false,
          key: null,
          ageSeconds: null,
          staleness: "unknown",
          reason: "no_receipt",
        });
      });

      it("reports fresh for a recent successful archive", () => {
        const path = writeArchiveStatus({
          ok: true,
          key: "weekly/prod-2026-08-12T00-00-00Z.db.gz",
          completedAt: new Date(Date.now() - 3_600_000).toISOString(),
        });
        vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

        const health = getPublicR2WeeklyHealth();
        expect(health.ok).toBe(true);
        expect(health.staleness).toBe("fresh");
        expect(health.key).toBe("weekly/prod-2026-08-12T00-00-00Z.db.gz");
        expect(health.reason).toBeNull();
        expect(health.ageSeconds).toBeGreaterThanOrEqual(3_500);
      });

      it("reports stale when completedAt is outside the 8-day window", () => {
        const path = writeArchiveStatus({
          ok: true,
          key: "weekly/old.db.gz",
          completedAt: new Date(Date.now() - 9 * 24 * 3_600_000).toISOString(),
        });
        vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

        expect(getPublicR2WeeklyHealth()).toMatchObject({
          ok: false,
          staleness: "stale",
          reason: "archive_stale",
        });
      });

      it("reports stale (not no_receipt) when the job itself reported failure", () => {
        const path = writeArchiveStatus({
          ok: false,
          reason: "verify_hash_mismatch",
          checkedAt: new Date().toISOString(),
        });
        vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

        expect(getPublicR2WeeklyHealth()).toMatchObject({
          ok: false,
          staleness: "stale",
          reason: "verify_hash_mismatch",
        });
      });
    });
  });

  describe("database file identity", () => {
    // Date-derived probe times, never the wall clock: getDatabaseFileStatus
    // caches a healthy verdict for 5s keyed on the `now` it is given, so each
    // probe passes an explicit instant derived from this fixed origin.
    const T0 = new Date("2026-08-01T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

    const makeDatabaseFixture = () => {
      const dir = mkdtempSync(join(tmpdir(), "usage-monitor-dbfile-"));
      const dbPath = join(dir, "prod.db");
      writeFileSync(dbPath, "not-actually-sqlite\n");
      vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
      return { dir, dbPath };
    };

    it("makes no claim when DATABASE_URL is absent or not a file: URL", () => {
      const unchecked = {
        ok: true,
        checked: false,
        reason: null,
        linkCount: null,
        pathPresent: null,
        baselineCaptured: false,
      };
      expect(getDatabaseFileStatus(T0)).toMatchObject(unchecked);

      vi.stubEnv("DATABASE_URL", "postgres://example.invalid/usage");
      expect(getDatabaseFileStatus(at(1))).toMatchObject(unchecked);
    });

    it("makes no claim when the file was never openable (mocked-prisma CI database)", () => {
      // CI sets DATABASE_URL=file:$RUNNER_TEMP/api-usage-monitor-ci.db but the
      // unit suite mocks prisma, so that file never exists. Identity checking
      // must stay transparent there instead of reporting a false incident.
      const dir = mkdtempSync(join(tmpdir(), "usage-monitor-dbfile-"));
      try {
        vi.stubEnv("DATABASE_URL", `file:${join(dir, "never-created.db")}`);
        expect(getDatabaseFileStatus(T0)).toMatchObject({
          ok: true,
          checked: false,
          reason: null,
          baselineCaptured: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports a healthy checked verdict and caches it briefly once the baseline exists", () => {
      const { dir } = makeDatabaseFixture();
      try {
        captureDatabaseFileBaseline();
        expect(getDatabaseFileStatus(T0)).toMatchObject({
          ok: true,
          checked: true,
          reason: null,
          linkCount: 1,
          pathPresent: true,
          baselineCaptured: true,
          cached: false,
        });
        // Within the success TTL the verdict is reused; after it, recomputed.
        expect(getDatabaseFileStatus(at(4_000))).toMatchObject({
          ok: true,
          cached: true,
        });
        expect(getDatabaseFileStatus(at(6_000))).toMatchObject({
          ok: true,
          cached: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("detects the incident: a deleted-but-open database reports database_file_unlinked", () => {
      const { dir, dbPath } = makeDatabaseFixture();
      try {
        captureDatabaseFileBaseline();
        expect(getDatabaseFileStatus(T0).ok).toBe(true);

        rmSync(dbPath);
        // 6s after the healthy probe so the success cache has expired; a
        // failing verdict is then recomputed live on every later probe.
        expect(getDatabaseFileStatus(at(6_000))).toMatchObject({
          ok: false,
          checked: true,
          reason: "database_file_unlinked",
          linkCount: 0,
          pathPresent: false,
          baselineCaptured: true,
          cached: false,
        });
        // Failures are never cached: the very next probe stays live.
        expect(getDatabaseFileStatus(at(6_001))).toMatchObject({
          ok: false,
          cached: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports database_file_missing when the pathname is renamed away from a still-linked inode", () => {
      const { dir, dbPath } = makeDatabaseFixture();
      try {
        captureDatabaseFileBaseline();
        renameSync(dbPath, join(dir, "prod.db.moved"));
        expect(getDatabaseFileStatus(T0)).toMatchObject({
          ok: false,
          checked: true,
          reason: "database_file_missing",
          linkCount: 1,
          pathPresent: false,
          baselineCaptured: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports database_file_replaced when the pathname resolves to a different inode", () => {
      const { dir, dbPath } = makeDatabaseFixture();
      try {
        // Read inodes through fds rather than path-stats so there is no
        // check-then-use pattern on the pathname (CodeQL js/file-system-race);
        // the deliberate inode swap below is the subject under test, not a
        // race hazard.
        const inodeOf = (path: string): number => {
          const fd = openSync(path, "r");
          try {
            return fstatSync(fd).ino;
          } finally {
            closeSync(fd);
          }
        };
        const originalIno = inodeOf(dbPath);
        captureDatabaseFileBaseline();
        // Rename (keeping the original inode linked) then write a new file at
        // the same pathname, so the failure is purely identity, not deletion.
        renameSync(dbPath, join(dir, "prod.db.orig"));
        writeFileSync(dbPath, "a different database\n");
        expect(inodeOf(dbPath)).not.toBe(originalIno);

        expect(getDatabaseFileStatus(T0)).toMatchObject({
          ok: false,
          checked: true,
          reason: "database_file_replaced",
          linkCount: 1,
          pathPresent: true,
          baselineCaptured: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("clears the baseline and cache via resetRuntimeHealthForTests", () => {
      const { dir, dbPath } = makeDatabaseFixture();
      try {
        captureDatabaseFileBaseline();
        rmSync(dbPath);
        expect(getDatabaseFileStatus(T0).ok).toBe(false);

        // After a reset the deleted file can no longer be re-opened, so the
        // check returns to the no-claim state instead of a stale verdict.
        resetRuntimeHealthForTests();
        expect(getDatabaseFileStatus(at(1))).toMatchObject({
          ok: true,
          checked: false,
          baselineCaptured: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("tolerates one transient failure but fails repeated, stalled, and stale ticks", () => {
    vi.stubEnv("SCHEDULER_STALE_AFTER_MS", "1000");
    const now = new Date("2026-07-11T12:10:00.000Z");
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickStarted(new Date("2026-07-11T12:09:58.000Z"));
    expect(getSchedulerReadiness(now).reason).toBe("tick_stalled");

    resetRuntimeHealthForTests();
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.500Z"));
    expect(getSchedulerReadiness(now)).toMatchObject({ ok: true, reason: null });
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.600Z"));
    markSchedulerTickCompleted(false, null, new Date("2026-07-11T12:09:59.700Z"));
    expect(getSchedulerReadiness(now).reason).toBe("repeated_tick_failures");
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveFailures: 3,
      firstFailureAt: "2026-07-11T12:09:59.500Z",
    });

    markSchedulerTickCompleted(true, null, new Date("2026-07-11T12:09:59.800Z"));
    expect(getSchedulerReadiness(now)).toMatchObject({ ok: true, reason: null });
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveFailures: 0,
      firstFailureAt: null,
    });

    resetRuntimeHealthForTests();
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
    markSchedulerTickCompleted(true, null, new Date("2026-07-11T12:09:58.000Z"));
    expect(getSchedulerReadiness(now).reason).toBe("tick_stale");
  });

  it("supports an explicit consecutive-failure threshold", () => {
    vi.stubEnv("SCHEDULER_FAILURE_THRESHOLD", "2");
    markSchedulerStarted();
    markSchedulerTickCompleted(false, null);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, failureThreshold: 2 });
    markSchedulerTickCompleted(false, null);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: false,
      reason: "repeated_tick_failures",
      failureThreshold: 2,
    });
  });

  it("surfaces provider-fetch degradation as a distinct signal only after sustained consecutive ticks, and resets on recovery", () => {
    markSchedulerStarted();
    const degradedRun = {
      total: 6,
      successes: 1,
      failures: 5,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    const healthyRun = {
      ...degradedRun,
      successes: 6,
      failures: 0,
      providerFetchDegraded: false,
    };
    const skippedOnlyRun = {
      ...degradedRun,
      successes: 0,
      failures: 0,
      skipped: 6,
      providerFetchDegraded: false,
    };

    // A single degraded tick must not flip readiness - only a sustained run
    // does. `succeeded` here stays true throughout: provider-fetch health is
    // deliberately independent of maintenanceHealthy/lastTickSucceeded.
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, reason: null });
    expect(
      getSchedulerRuntimeStatus().consecutiveProviderFetchDegradedTicks
    ).toBe(1);

    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({ ok: true, reason: null });

    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: "provider_fetch_degraded",
      providerFetchDegraded: true,
      providerFetchDegradedTickThreshold: 3,
    });
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveProviderFetchDegradedTicks: 3,
      // Never affects lastTickSucceeded/consecutiveFailures - the app itself
      // is still serving; a provider-fetch outage is upstream.
      lastTickSucceeded: true,
      consecutiveFailures: 0,
    });

    // A tick where nothing was attempted (all interval-gated skips) is not
    // degraded and resets the streak.
    markSchedulerTickCompleted(true, skippedOnlyRun);
    expect(
      getSchedulerRuntimeStatus().consecutiveProviderFetchDegradedTicks
    ).toBe(0);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegraded: false,
    });

    // Recovery: run the streak back up, then one healthy tick resets it.
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness().reason).toBe("provider_fetch_degraded");
    markSchedulerTickCompleted(true, healthyRun);
    expect(getSchedulerRuntimeStatus()).toMatchObject({
      consecutiveProviderFetchDegradedTicks: 0,
      firstProviderFetchDegradedAt: null,
    });
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegraded: false,
    });
  });

  it("supports an explicit provider-fetch-degraded consecutive tick threshold", () => {
    vi.stubEnv("PROVIDER_FETCH_DEGRADED_TICK_THRESHOLD", "2");
    markSchedulerStarted();
    const degradedRun = {
      total: 2,
      successes: 0,
      failures: 2,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: null,
      providerFetchDegradedTickThreshold: 2,
    });
    markSchedulerTickCompleted(true, degradedRun);
    expect(getSchedulerReadiness()).toMatchObject({
      ok: true,
      reason: "provider_fetch_degraded",
      providerFetchDegradedTickThreshold: 2,
    });
  });
});
