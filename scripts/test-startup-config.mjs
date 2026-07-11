#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "start-with-litestream.sh");
const keys = [
  "LITESTREAM_S3_BUCKET",
  "LITESTREAM_S3_ENDPOINT",
  "LITESTREAM_S3_ACCESS_KEY_ID",
  "LITESTREAM_S3_SECRET_ACCESS_KEY",
];

function run(overrides = {}) {
  const env = { ...process.env, STARTUP_PREFLIGHT_ONLY: "true" };
  for (const key of [
    ...keys,
    "LITESTREAM_REQUIRED",
    "LITESTREAM_BIN_PATH",
    "RELEASE_MAINTENANCE_PLAN_ID",
  ]) {
    delete env[key];
  }
  Object.assign(env, overrides);
  return spawnSync("bash", [script], { env, encoding: "utf8" });
}

function expectStatus(name, result, expected) {
  if (result.status !== expected) {
    throw new Error(
      `${name}: expected exit ${expected}, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
}

const temp = mkdtempSync(join(tmpdir(), "usage-startup-config-"));
try {
  const startupSource = readFileSync(script, "utf8");
  const backupIndex = startupSource.indexOf(
    'node "${REPO_ROOT}/scripts/backup-sqlite-before-migrate.mjs"'
  );
  const migrationIndex = startupSource.indexOf('node "${REPO_ROOT}/scripts/migrate-safe.mjs"');
  const maintenanceIndex = startupSource.lastIndexOf(
    'node "${REPO_ROOT}/scripts/run-release-maintenance.mjs"'
  );
  const appStartIndex = startupSource.lastIndexOf("\nexec npm start");
  if (
    backupIndex < 0 ||
    migrationIndex < 0 ||
    maintenanceIndex < 0 ||
    appStartIndex < 0 ||
    backupIndex >= migrationIndex ||
    migrationIndex >= maintenanceIndex ||
    maintenanceIndex >= appStartIndex
  ) {
    throw new Error(
      "startup wrapper order must be backup -> migrate-safe -> release maintenance -> app"
    );
  }

  expectStatus("disabled backup", run(), 0);
  expectStatus(
    "known release plan",
    run({
      RELEASE_MAINTENANCE_PLAN_ID:
        "provider-subscriptions-2026-07-10-v1",
    }),
    0
  );
  expectStatus(
    "unknown release plan",
    run({ RELEASE_MAINTENANCE_PLAN_ID: "run-everything" }),
    1
  );
  expectStatus(
    "partial configuration",
    run({ LITESTREAM_S3_BUCKET: "bucket" }),
    1
  );
  expectStatus(
    "required but unconfigured",
    run({ LITESTREAM_REQUIRED: "true" }),
    1
  );
  expectStatus(
    "invalid required flag",
    run({ LITESTREAM_REQUIRED: "yes" }),
    1
  );

  const fakeBinary = join(temp, "litestream");
  writeFileSync(fakeBinary, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeBinary, 0o755);
  expectStatus(
    "fully configured backup",
    run({
      LITESTREAM_REQUIRED: "true",
      LITESTREAM_BIN_PATH: fakeBinary,
      LITESTREAM_S3_BUCKET: "bucket",
      LITESTREAM_S3_ENDPOINT: "https://example.invalid",
      LITESTREAM_S3_ACCESS_KEY_ID: "access",
      LITESTREAM_S3_SECRET_ACCESS_KEY: "secret",
    }),
    0
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("startup configuration checks passed");
