#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "start-with-litestream.sh");
const fetchScript = join(repoRoot, "scripts", "fetch-litestream.sh");
const renderConfig = join(repoRoot, "render.yaml");
const keys = [
  "LITESTREAM_S3_BUCKET",
  "LITESTREAM_S3_ENDPOINT",
  "LITESTREAM_S3_ACCESS_KEY_ID",
  "LITESTREAM_S3_SECRET_ACCESS_KEY",
];

function run(overrides = {}) {
  const env = { ...process.env, STARTUP_PREFLIGHT_ONLY: "true" };
  for (const key of [...keys, "LITESTREAM_REQUIRED", "LITESTREAM_BIN_PATH"]) {
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

function expectLitestreamAsset(hostArch, expectedAsset, expectedSha256) {
  const result = spawnSync("bash", [fetchScript], {
    env: {
      ...process.env,
      LITESTREAM_ARCH_OVERRIDE: hostArch,
      FETCH_LITESTREAM_METADATA_ONLY: "true",
    },
    encoding: "utf8",
  });
  expectStatus(`Litestream ${hostArch} asset`, result, 0);
  const expected = `${expectedAsset} ${expectedSha256}`;
  if (result.stdout.trim() !== expected) {
    throw new Error(
      `Litestream ${hostArch} asset: expected ${expected}, got ${result.stdout.trim()}`
    );
  }
}

const temp = mkdtempSync(join(tmpdir(), "usage-startup-config-"));
try {
  const startupSource = readFileSync(script, "utf8");
  const renderSource = readFileSync(renderConfig, "utf8");
  if (!/^\s*healthCheckPath:\s*\/api\/health\s*$/m.test(renderSource)) {
    throw new Error("Render health checks must use the database-independent /api/health liveness route");
  }
  if (/^\s*healthCheckPath:\s*\/api\/ready\s*$/m.test(renderSource)) {
    throw new Error("strict /api/ready must not be Render's restart trigger");
  }

  // The production image runs with replication configured, so a missing
  // bin/litestream is a broken image: the startup wrapper fails closed and the
  // container crash-loops. fetch-litestream.sh only WARNS by default, which on
  // 2026-08-13 turned a transient CDN flake into a green build and a deploy
  // that could never succeed — and stayed unfixable, because the bad image is
  // cached against the commit SHA. Keep the build fatal.
  const dockerfileSource = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  if (
    !/ARG NEXT_PUBLIC_SENTRY_DSN=""/.test(dockerfileSource) ||
    !/ENV NEXT_PUBLIC_SENTRY_DSN=\$NEXT_PUBLIC_SENTRY_DSN/.test(dockerfileSource)
  ) {
    throw new Error(
      "Dockerfile must ARG+ENV NEXT_PUBLIC_SENTRY_DSN before npm run build so Coolify " +
        "build-time env actually reaches the Next client bundle"
    );
  }
  if (!/FETCH_LITESTREAM_REQUIRED=true\s+bash\s+scripts\/fetch-litestream\.sh/.test(dockerfileSource)) {
    throw new Error(
      "Dockerfile must run fetch-litestream.sh with FETCH_LITESTREAM_REQUIRED=true so a " +
        "failed download fails the build instead of shipping an image that cannot start"
    );
  }
  if (!/test -x bin\/litestream/.test(dockerfileSource)) {
    throw new Error(
      "Dockerfile must assert bin/litestream exists after fetching it, so a future " +
        "silent-skip path in the fetch script cannot ship a replication-less image"
    );
  }
  // Coolify no longer stores INFISICAL_UM_PROJECT_ID (#1211). #1315 removed
  // the script fallback and rolled back every later deploy (Infisical 404
  // projectId=undefined). The UUID is a project address, not a secret.
  if (
    !/INFISICAL_UM_PROJECT_ID=86e35e51-91bc-4dfd-a045-4484726b9c40/.test(dockerfileSource)
  ) {
    throw new Error(
      "Dockerfile must bake INFISICAL_UM_PROJECT_ID so Infisical inject works when " +
        "Coolify only has CLIENT_ID/SECRET"
    );
  }
  const infisicalStart = readFileSync(join(repoRoot, "scripts", "start-with-infisical.sh"), "utf8");
  if (!/86e35e51-91bc-4dfd-a045-4484726b9c40/.test(infisicalStart)) {
    throw new Error(
      "start-with-infisical.sh must keep the UM Infisical project UUID fallback"
    );
  }
  if (!/DD_SERVICE is missing/.test(startupSource)) {
    throw new Error(
      "start-with-litestream.sh must fail closed when DD_REQUIRE=1 or partial Datadog config is missing DD_SERVICE"
    );
  }
  const ddGuard = startupSource.slice(
    startupSource.indexOf("dd_opted_out"),
    startupSource.indexOf("--require dd-trace/init")
  );
  if (/NODE_ENV/.test(ddGuard)) {
    throw new Error(
      "start-with-litestream.sh must not hard-exit on NODE_ENV=production alone; the Datadog guard is DD_REQUIRE=1 opt-in"
    );
  }
  if (!/DD_REQUIRE/.test(ddGuard)) {
    throw new Error(
      "start-with-litestream.sh must fail closed when DD_REQUIRE=1 and DD_SERVICE is missing"
    );
  }
  // Execute the actual Datadog guard, not the full database/startup wrapper.
  const guardSource = startupSource.slice(startupSource.indexOf("dd_opted_out=false"), startupSource.indexOf('if [[ "${litestream_enabled}" == "true" ]];', startupSource.indexOf("dd_opted_out=false")));
  for (const [name, overrides, expected] of [
    ["production dark", { NODE_ENV: "production" }, 0],
    ["explicit required", { DD_REQUIRE: "1" }, 1],
    ["truthy required", { DD_REQUIRE: "true" }, 1],
    ["padded truthy required", { DD_REQUIRE: " True " }, 1],
    ["mixed-case truthy required", { DD_REQUIRE: "Yes" }, 1],
    ["padded uppercase required", { DD_REQUIRE: " ON " }, 1],
    ["partial config", { DD_AGENT_HOST: "127.0.0.1" }, 1],
    ["trace opt-out", { DD_REQUIRE: "1", DD_TRACE_ENABLED: "false" }, 0],
    ["padded trace opt-out", { DD_REQUIRE: "1", DD_TRACE_ENABLED: " Off " }, 0],
    ["mixed-case trace opt-out", { DD_REQUIRE: "1", DD_TRACE_ENABLED: "No" }, 0],
    ["whitespace service still missing", { DD_REQUIRE: "1", DD_SERVICE: "   " }, 1],
    ["whitespace service with partial config", { DD_AGENT_HOST: "127.0.0.1", DD_SERVICE: " \t " }, 1],
    ["whitespace-only signal stays dark", { DD_AGENT_HOST: "   " }, 0],
    ["padded service configured", { DD_SERVICE: " usage-monitor " }, 0],
    ["configured opt-in", { DD_SERVICE: "usage-monitor" }, 0],
  ]) {
    const env = { PATH: process.env.PATH, ...overrides };
    const result = spawnSync("bash", ["-c", 'log() { :; }; ' + guardSource], { env, encoding: "utf8" });
    expectStatus(`Datadog guard ${name}`, result, expected);
  }
  // The dd-trace preload decision must apply the same trimmed DD_SERVICE
  // semantics as the guard: whitespace-only never preloads, padded values do,
  // an explicit opt-out suppresses the preload even with a service set, and an
  // existing preload or NODE_OPTIONS content must survive untouched.
  for (const [name, overrides, expectPreload] of [
    ["preload on configured service", { DD_SERVICE: "usage-monitor" }, true],
    ["preload on padded service", { DD_SERVICE: " usage-monitor " }, true],
    ["no preload for whitespace-only service", { DD_SERVICE: "   " }, false],
    ["no preload when opted out", { DD_SERVICE: "usage-monitor", DD_TRACE_ENABLED: " off " }, false],
    ["preload preserves existing NODE_OPTIONS", { DD_SERVICE: "usage-monitor", NODE_OPTIONS: "--max-old-space-size=512" }, true],
    ["preload not duplicated", { DD_SERVICE: "usage-monitor", NODE_OPTIONS: "--require dd-trace/init" }, true],
  ]) {
    const env = { PATH: process.env.PATH, ...overrides };
    const result = spawnSync(
      "bash",
      ["-c", 'log() { :; }; ' + guardSource + '\nprintf "%s" "${NODE_OPTIONS:-}"'],
      { env, encoding: "utf8" }
    );
    expectStatus(`Datadog preload ${name}`, result, 0);
    const occurrences = result.stdout.split("--require dd-trace/init").length - 1;
    const expectedCount = expectPreload ? 1 : 0;
    if (occurrences !== expectedCount) {
      throw new Error(
        `Datadog preload ${name}: expected ${expectedCount} dd-trace preload(s), got ${occurrences} (NODE_OPTIONS=${result.stdout})`
      );
    }
    if (name === "preload preserves existing NODE_OPTIONS" && !result.stdout.includes("--max-old-space-size=512")) {
      throw new Error(`Datadog preload ${name}: existing NODE_OPTIONS was dropped (NODE_OPTIONS=${result.stdout})`);
    }
  }
  if (!/--require dd-trace\/init/.test(startupSource)) {
    throw new Error(
      "start-with-litestream.sh must preload dd-trace/init when DD_SERVICE is set"
    );
  }
  const backupIndex = startupSource.indexOf(
    'node "${REPO_ROOT}/scripts/backup-sqlite-before-migrate.mjs" --if-schema-changed'
  );
  const migrationIndex = startupSource.indexOf('node "${REPO_ROOT}/scripts/migrate-safe.mjs"');
  const linkAuditIndex = startupSource.indexOf(
    'node "${REPO_ROOT}/scripts/audit-subscription-links.mjs"'
  );
  const linkIndexIndex = startupSource.indexOf(
    'node "${REPO_ROOT}/scripts/ensure-subscription-link-unique-index.mjs"'
  );
  if (
    backupIndex < 0 ||
    linkAuditIndex < 0 ||
    linkIndexIndex < 0 ||
    migrationIndex < 0 ||
    backupIndex >= linkAuditIndex ||
    linkAuditIndex >= linkIndexIndex ||
    linkIndexIndex >= migrationIndex
  ) {
    throw new Error(
      "startup wrapper must run backup, subscription-link audit, then migrate-safe"
    );
  }

  expectStatus("disabled backup", run(), 0);
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

  // R2 free-tier kill switch must disable replication only for R2 endpoints.
  const r2Kill = run({
    LITESTREAM_REQUIRED: "true",
    LITESTREAM_BIN_PATH: fakeBinary,
    LITESTREAM_S3_BUCKET: "bucket",
    LITESTREAM_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
    LITESTREAM_S3_ACCESS_KEY_ID: "access",
    LITESTREAM_S3_SECRET_ACCESS_KEY: "secret",
    LITESTREAM_EMERGENCY_DISABLE: "true",
  });
  expectStatus("r2 free-tier kill on R2 endpoint", r2Kill, 0);
  if (
    !/preflight OK \(replication false; r2_endpoint=true; r2_kill=true\)/.test(
      r2Kill.stdout
    )
  ) {
    throw new Error(
      `r2 free-tier kill on R2 endpoint: expected disabled preflight, got:\n${r2Kill.stdout}`
    );
  }

  const b2KeepsReplicating = run({
    LITESTREAM_REQUIRED: "true",
    LITESTREAM_BIN_PATH: fakeBinary,
    LITESTREAM_S3_BUCKET: "jays-usage-monitor-eu",
    LITESTREAM_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com",
    LITESTREAM_S3_ACCESS_KEY_ID: "access",
    LITESTREAM_S3_SECRET_ACCESS_KEY: "secret",
    LITESTREAM_EMERGENCY_DISABLE: "true",
  });
  expectStatus("r2 free-tier kill leaves B2 enabled", b2KeepsReplicating, 0);
  if (
    !/preflight OK \(replication true; r2_endpoint=false; r2_kill=true\)/.test(
      b2KeepsReplicating.stdout
    )
  ) {
    throw new Error(
      `r2 free-tier kill leaves B2 enabled: expected enabled preflight, got:\n${b2KeepsReplicating.stdout}`
    );
  }

  expectLitestreamAsset(
    "x86_64",
    "litestream-0.5.13-linux-x86_64.tar.gz",
    "fc3420fea7d2f92d4d604aceeb0d7c63dc2c91f6ee5c1547cc05e25629e70f9f"
  );
  expectLitestreamAsset(
    "aarch64",
    "litestream-0.5.13-linux-arm64.tar.gz",
    "ef47997794ce8dd87a64b44622d556b3a693b135fd72e0cf47cc42ac2e979051"
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("startup configuration checks passed");
