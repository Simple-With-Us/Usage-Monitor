import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

const workflow = read(".github/workflows/production-deploy-verify.yml");
const sentryDeployWorkflow = read(".github/workflows/sentry-deploy.yml");
const uptimeWorkflow = read(".github/workflows/uptime-monitor.yml");
const compose = read("deploy/retired/oracle/compose.production.yaml");
const composeDev = read("deploy/retired/oracle/compose.yaml");
const caddy = read("deploy/retired/oracle/Caddyfile");
const oracleReadme = read("deploy/retired/oracle/README.md");
const deploy = read("deploy/retired/oracle/deploy-production.sh");
const poller = read("deploy/retired/oracle/auto-deploy.sh");
const service = read("deploy/retired/oracle/usage-monitor.service");
const deployService = read("deploy/retired/oracle/usage-monitor-auto-deploy.service");
const timer = read("deploy/retired/oracle/usage-monitor-auto-deploy.timer");
const ci = read(".github/workflows/ci.yml");
const renderRetirement = JSON.parse(
  read("deploy/retired/oracle/render-retired.production.json"),
);

function requireText(body, pattern, message) {
  assert.match(body, pattern, message);
}

function forbidText(body, pattern, message) {
  assert.doesNotMatch(body, pattern, message);
}

function forbidLiteral(body, text, message) {
  assert.equal(body.includes(text), false, message);
}

// GitHub observes an exact, already-green main CI run. It holds no production
// credential because Oracle pulls the public protected revision itself.
requireText(workflow, /workflow_run:/, "deploy receipt must follow CI");
requireText(workflow, /workflows:\s*\[CI\]/, "deploy receipt must follow the CI workflow");
requireText(workflow, /head_branch == 'main'/, "workflow must reject non-main runs");
requireText(workflow, /workflow_run\.conclusion == 'success'/, "workflow must require successful CI");
requireText(workflow, /\.revision == \$revision/, "workflow must verify the exact production revision");
requireText(workflow, /cancel-in-progress:\s*true/, "stale receipt observers should be cancelled");
requireText(workflow, /timeout-minutes:\s*250/, "observer job must outlast the host transaction ceiling");
requireText(workflow, /seq 1 1440/, "observer must cover the 240-minute host transaction ceiling");
requireText(workflow, /PRODUCTION_ORIGIN_IPV4:\s*"167\.233\.254\.55"/, "observer must pin the Hetzner Coolify origin");
requireText(workflow, /--resolve "usage\.jays\.services:443:\$\{PRODUCTION_ORIGIN_IPV4\}"/, "observer must bypass Cloudflare bot challenges without weakening TLS");
requireText(sentryDeployWorkflow, /cancel-in-progress:\s*true/, "stale Sentry deploy reporters should be cancelled");
requireText(sentryDeployWorkflow, /PRODUCTION_ORIGIN_IPV4:\s*"167\.233\.254\.55"/, "Sentry deploy reporter must pin the Hetzner Coolify origin");
requireText(read("scripts/sentry-report-deploy.mjs"), /PRODUCTION_ORIGIN_IPV4/, "Sentry deploy reporter must read production health through the pinned origin when configured");
forbidText(workflow, /secrets\./, "the observer workflow must not hold a production secret");
forbidText(workflow, /ssh-keyscan|StrictHostKeyChecking=no/, "unsafe SSH bootstrap is forbidden");
requireText(uptimeWorkflow, /PRODUCTION_ORIGIN_IPV4:\s*"167\.233\.254\.55"/, "GitHub uptime must pin the Hetzner Coolify origin");
requireText(uptimeWorkflow, /--resolve "usage\.jays\.services:443:\$\{PRODUCTION_ORIGIN_IPV4\}"/, "GitHub uptime must avoid Cloudflare false failures while retaining TLS validation");
requireText(
  uptimeWorkflow,
  /INCIDENT_TITLE:\s*"\[Uptime\] Usage Monitor Hetzner origin readiness failure"/,
  "uptime issue title must name the live Hetzner origin, not the retired Oracle host",
);
forbidText(
  uptimeWorkflow,
  /INCIDENT_TITLE:.*Oracle/,
  "uptime issue title must not mention the retired Oracle host",
);
requireText(
  uptimeWorkflow,
  /PAGERDUTY_DEDUP_KEY:\s*"usage-monitor-oracle-origin-readiness"/,
  "PagerDuty dedup key stays historical so open incidents do not fork",
);
requireText(ci, /npm run test:oracle-deploy/, "hosted CI must exercise deployment contracts");

// Production uses the Cloudflare-proxied public hostname. The old sslip.io
// fallback encoded a deleted ephemeral Oracle address and could cause a fresh
// bootstrap to request the wrong certificate. Cloudflare terminates public TLS,
// so Caddy must leave HTTP-01 enabled and disable TLS-ALPN-01.
requireText(caddy, /^\{\$USAGE_MONITOR_HOSTNAME:usage\.jays\.services\}/m, "Caddy must default to the public hostname");
requireText(caddy, /disable_tlsalpn_challenge/, "Caddy must use HTTP-01 behind the proxied hostname");
requireText(caddy, /issuer acme/, "Caddy must keep the Let's Encrypt ACME issuer");
requireText(
  caddy,
  /dir https:\/\/acme\.zerossl\.com\/v2\/DV90/,
  "Caddy must keep ZeroSSL ACME directory as the Automatic HTTPS fallback issuer",
);
requireText(deploy, /ensure_public_caddy_hostname/, "deploy must migrate/refuse stale Caddy hostnames");
requireText(deploy, /reload_caddy_proxy/, "deploy must recreate Caddy after hostname migration");
// Use awk index() markers (not host-shaped substring checks) so CodeQL does
// not flag incomplete URL sanitization on this contract file.
forbidLiteral(deploy, "usage-oracle.", "deploy must not reintroduce the deleted IP-derived host prefix");
assert.equal(
  deploy.includes('index($0, "sslip.io")'),
  true,
  "deploy must detect deleted IP-derived sslip hostnames via awk index()",
);
assert.equal(
  deploy.includes('index($0, "132.226.90.164")'),
  true,
  "deploy must detect the deleted Oracle public IP hostname via awk index()",
);
// Split the forbidden host label so this file does not embed a host-shaped
// sanitizer check that CodeQL treats as incomplete URL validation.
const deletedHostLabel = ["sslip", ".io"].join("");
forbidLiteral(caddy, deletedHostLabel, "Caddy must not retain the deleted IP-derived fallback");
requireText(composeDev, /USAGE_MONITOR_HOSTNAME:\s*\$\{USAGE_MONITOR_HOSTNAME:-usage\.jays\.services\}/, "Compose must default to the public hostname");
forbidLiteral(composeDev, deletedHostLabel, "Compose must not retain the deleted IP-derived fallback");
requireText(oracleReadme, /USAGE_MONITOR_HOSTNAME=usage\.jays\.services/, "Oracle docs must name the public hostname");
forbidLiteral(oracleReadme, deletedHostLabel, "Oracle docs must not retain the deleted IP-derived fallback");

// The root-owned production Compose policy must never build or accept new host
// mounts from a fetched revision.
forbidText(compose, /^\s*build:/m, "production compose must never build repo-controlled content");
forbidText(compose, /docker\.sock|\/\s*:\s*\//, "production compose must not expose host root or Docker");
requireText(compose, /user:\s*"1000:1000"/, "app must run as the data-volume uid/gid");
requireText(compose, /no-new-privileges:true/, "app must set no-new-privileges");
requireText(compose, /cap_drop:\s*\n\s*- ALL/, "app must drop Linux capabilities");
requireText(compose, /restart:\s*"no"/, "candidate restart loops must remain disabled until acceptance");
requireText(compose, /pull_policy:\s*never/, "reboot and rollback must use locally verified images");

// Root transaction invariants. These are static contract checks in addition to
// bash syntax verification; production performs the live checks again.
for (const [pattern, message] of [
  [/flock -w 10/, "host deployment lock"],
  [/EXPECTED_DATA_UUID/, "pinned data-volume UUID"],
  [/USAGE_SCHEDULER_ENABLED/, "sole scheduler guard"],
  [/jays-usage-monitor-eu/, "B2 primary bucket guard"],
  [/commit\.verification\.verified/, "verified GitHub commit guard"],
  [/merge_commit_sha/, "merged PR guard"],
  [/GITHUB_ACTIONS_APP_ID/, "trusted GitHub Actions app guard"],
  [/Analyze JavaScript and TypeScript/, "CodeQL check guard"],
  [/create_sqlite_backup/, "transaction-consistent backup"],
  [/timeout --signal=TERM --kill-after=30s 1800 \\\s*\n\s*sqlite3/, "long SQLite Online Backup timeout for large prod DB"],
  [/PRAGMA integrity_check/, "SQLite integrity verification"],
  [/PRAGMA foreign_key_check/, "SQLite foreign-key verification"],
  [/--network none/, "offline scratch migration"],
  [/--no-deps --no-build --force-recreate app/, "single-app cutover"],
  [/lastTickSucceeded/, "fresh scheduler-tick acceptance"],
  [/refs\/deploy\//, "fetch exact deploy SHA into root-owned mirror"],
  [/origin\/main advanced to/, "allow main tip to advance mid exact-SHA deploy"],
  [/is not an ancestor of origin\/main/, "reject target SHAs that left main"],
  [/continuing exact-SHA deploy of/, "cutover continues when main tip advances"],
  [/committing exact-SHA/, "acceptance continues when main tip advances"],
  [/still on main \(tip advanced to/, "require_current_main allows main ancestors"],

  [/capture_pre_stop_backup_watermark/, "pre-stop online Garage watermark capture"],
  [/capture_quiescent_backup_watermark/, "post-stop Garage watermark capture (uses pre-stop TXID)"],
  [/r2-disabled-70pct\.flag/, "R2 free-tier kill-switch acceptance path"],
  [/curl -sS --max-time 30/, "ready probes must keep JSON bodies on HTTP 503"],
  [/for _ in \{1\.\.180\}/, "extended candidate readiness wait for large DB pre-migration backup"],
  [/candidate image missing after backup; rebuilding/, "re-verify candidate image after long backup"],
  [/ltx -config \/app\/litestream\.yml -level "\$\{level\}"/, "per-level LTX tip listing (not full history)"],
  [/for level in 0 1 2 3 4 5/, "L0-then-L1..L5 fallback when tip is compacted"],
  [/list_garage_ltx_level/, "shared LTX level lister for online/offline paths"],
  [/run_usage_monitor_oneshot/, "named one-shot docker runs (no random epic_jackson unmanaged names)"],
  [/usage-monitor-\$\{kind\}-\$\$/, "one-shot container name prefix usage-monitor-<kind>-pid"],
  [/docker run --name "\$\{name\}"/, "one-shots pass --name to docker run"],
  [/-integrity-check quick/, "post-cutover Garage restore structural check"],
  [/readonly GARAGE_RESTORE_TIMEOUT_SECONDS=900/, "bounded Garage restore"],
  [/readonly GARAGE_RESTORE_CLIENT_TIMEOUT_SECONDS=960/, "bounded Garage Docker client"],
  [/readonly GARAGE_INTEGRITY_TIMEOUT_SECONDS=1800/, "bounded full Garage integrity check"],
  [/readonly GARAGE_FOREIGN_KEY_TIMEOUT_SECONDS=600/, "bounded Garage foreign-key check"],
  [/docker exec "\$\{APP_CONTAINER\}"\s+\\\s+\/usr\/bin\/timeout --signal=TERM --kill-after=30s "\$\{GARAGE_RESTORE_TIMEOUT_SECONDS\}"/, "in-container Garage restore timeout"],
  [/timeout --signal=TERM --kill-after=30s "\$\{GARAGE_INTEGRITY_TIMEOUT_SECONDS\}"/, "full Garage integrity timeout enforcement"],
  [/timeout --signal=TERM --kill-after=30s "\$\{GARAGE_FOREIGN_KEY_TIMEOUT_SECONDS\}"/, "Garage foreign-key timeout enforcement"],
  [/require_no_acceptance_restore_process/, "restore-process absence before cleanup"],
  [/docker top "\$\{APP_CONTAINER\}" -eo pid,args ww/, "untruncated restore-process inspection"],
  [/refusing to unlink Garage acceptance scratch/, "orphan-safe scratch retention"],
  [/name != '_deploy_heartbeat'/, "quoted exclusion for the unmanaged deployment heartbeat object"],
  [/verify_render_retirement/, "durable Render retirement proof"],
  [/prune_unreferenced_application_images/, "targeted application-image retention"],
  [/docker image ls --format '\{\{\.Repository\}\} \{\{\.Tag\}\}'/, "bounded image enumeration"],
  [/\^\[0-9a-f\]\{40\}\$/, "immutable revision-tag cleanup filter"],
  [/docker ps -aq --filter "ancestor=/, "container-reference protection before image removal"],
  [/docker image rm "\$\{repository\}:\$\{tag\}"/, "exact-tag image removal"],
  [/prune_bounded_build_cache/, "bounded BuildKit cache retention"],
  [/--max-used-space="\$\{MAX_BUILD_CACHE\}"/, "BuildKit cache maximum"],
  [/--min-free-space="\$\{MIN_BUILD_CACHE_FREE\}"/, "BuildKit free-space target"],
  [/--reserved-space="\$\{RESERVED_BUILD_CACHE\}"/, "BuildKit retained-cache floor"],
  [/env-vars\/USAGE_SCHEDULER_ENABLED/, "exact Render scheduler lookup without pagination"],
  [/--kill-after=60s 5400/, "bounded target-controlled image build (shared-host ceiling)"],
  [/--kill-after=30s 900/, "bounded target-controlled scratch migration"],
  [/on_signal TERM 143/, "signal-safe rollback"],
  [/rolling code back.*without restoring SQLite/, "code-only rollback"],
  [/both candidate and rollback validation failed; stopping every app writer/, "dual-failure stop"],
]) {
  requireText(deploy, pattern, `deploy script must enforce ${message}`);
}
forbidText(deploy, /reset --hard|docker system prune|rm -rf/, "broad destructive cleanup is forbidden");
forbidText(deploy, /docker image (prune|rm -f)/, "image cleanup must not be broad or forced");
assert.equal((deploy.match(/docker buildx prune/g) ?? []).length, 1, "only the one bounded BuildKit prune is allowed");
forbidText(deploy, /name != "_deploy_heartbeat"/, "SQLite identifiers must not be shell-quote corrupted");
forbidText(deploy, /set -x/, "deployment must never trace secrets");
forbidText(deploy, /ltx[^\n]*-level all/, "full LTX history listing is forbidden (Coolify timeout false-block)");

requireText(poller, /MAX_FAILURES=3/, "poller must have a bounded retry circuit breaker");
requireText(poller, /blocked-sha/, "poller must persist the blocked revision");
requireText(poller, /CHECK_RETRY_SECONDS=300/, "failed checks must be re-evaluated without hot polling");
requireText(poller, /git ls-remote/, "poller must resolve public main without credentials");
requireText(poller, /systemctl restart usage-monitor\.service/, "stopped writers must recover only through the mount-gated unit");
requireText(poller, /mountpoint -q/, "writer recovery must require the data mount");
requireText(poller, /docker update --restart=no/, "the poller must retrofit mount-safe restart policy before honoring pause");
requireText(poller, /flock -w 10 8/, "recovery must share the deployment transaction lock");
requireText(poller, /flock -u 8/, "the poller must release its recovery lock before the child transaction");
requireText(poller, /public_ready_matches_revision/, "poller readiness gate must be shared");
requireText(poller, /r2-disabled-70pct\.flag/, "poller must accept intentional R2 free-tier not_ready");
requireText(poller, /curl -sS --max-time 15/, "poller ready probes must keep JSON on HTTP 503");
forbidText(poller, /curl -fsS.*PUBLIC_READY_URL/, "poller must not use curl -f against ready (discards 503 bodies)");
requireText(deployService, /SuccessExitStatus=75/, "pending checks must not fail systemd");
requireText(deployService, /TimeoutStartSec=240min/, "systemd must bound an unexpectedly wedged transaction");
requireText(deployService, /TimeoutStopSec=45min/, "systemd must allow bounded signal rollback to finish");
const declaredSerialTransactionSeconds =
  300 + // bounded BuildKit cleanup
  240 + // live SQLite integrity and foreign keys
  330 + // Garage LTX listing, dry-run, and authenticated validation
  1080 + // cold mirror clone, fetch, and worktree creation
  2940 + // image build, startup preflight, and Litestream presence
  600 + // pre-migration and stopped-writer SQLite backups
  900 + // target scratch migration
  600 + // exact readiness and fresh scheduler tick
  300 + // post-cutover Garage advancement
  960 + // in-container restore plus Docker-client margin
  1800 + // authoritative full SQLite integrity
  600 + // restored foreign keys
  300; // public samples and bounded metadata checks
const rollbackContingencySeconds = 30 * 60;
assert.ok(
  240 * 60 >= declaredSerialTransactionSeconds + rollbackContingencySeconds,
  "systemd start ceiling must exceed declared serial transaction budgets plus contingency",
);
requireText(timer, /OnUnitInactiveSec=1min/, "timer must detect merged main promptly");
requireText(service, /\/etc\/usage-monitor\/compose\.yaml/, "boot must use root-owned stable compose");
requireText(service, /--no-build/, "boot must never build a mutable checkout");
requireText(service, /--restart=no/, "systemd must keep Docker-level writer restart disabled");
forbidText(service, /--restart=unless-stopped/, "Docker must not bypass the systemd data-mount gate");
forbidText(deploy, /--restart=unless-stopped/, "accepted and rollback writers must remain systemd-gated");

const retentionStart = deploy.indexOf("prune_unreferenced_application_images() {");
const retentionEndMarker = "\n}\n\nprune_bounded_build_cache()";
const retentionEnd = deploy.indexOf(retentionEndMarker, retentionStart);
assert.ok(retentionStart >= 0 && retentionEnd > retentionStart, "retention function must be extractable for behavioral tests");
const retentionFunction = deploy.slice(retentionStart, retentionEnd + 2);
const cacheStart = deploy.indexOf("prune_bounded_build_cache() {");
const cacheEndMarker = "\n}\n\ncompose_for_revision()";
const cacheEnd = deploy.indexOf(cacheEndMarker, cacheStart);
assert.ok(cacheStart >= 0 && cacheEnd > cacheStart, "cache function must be extractable for behavioral tests");
const cacheFunction = deploy.slice(cacheStart, cacheEnd + 2);
const restoreStart = deploy.indexOf("acceptance_restore_pids() {");
const restoreEndMarker = "\n}\n\nverify_render_retirement()";
const restoreEnd = deploy.indexOf(restoreEndMarker, restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, "restore functions must be extractable for behavioral tests");
const restoreFunctions = deploy.slice(restoreStart, restoreEnd + 2);
const productionRestoreKillSwitch = "/data/r2-disabled-70pct.flag";
assert.equal(
  restoreFunctions.split(productionRestoreKillSwitch).length - 1,
  1,
  "restore fixture must contain exactly one production kill-switch path",
);
const isolatedRestoreFunctions = restoreFunctions.replace(
  productionRestoreKillSwitch,
  "$CASE_DIR_VALUE/r2-disabled-70pct.flag",
);

const retentionTemp = mkdtempSync(path.join(os.tmpdir(), "usage-monitor-image-retention-"));
const receiptPath = path.join(retentionTemp, "current.json");
const removalLog = path.join(retentionTemp, "removed.log");

function runRetentionCase({
  imageRows,
  previousSha,
  targetSha,
  receiptActive = "",
  receiptPrevious = "",
  referencedImage = "",
  failRemoval = "",
  receipt = "regular",
}) {
  rmSync(receiptPath, { force: true });
  rmSync(removalLog, { force: true });
  if (receipt === "regular") {
    writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
  } else if (receipt === "dangling") {
    symlinkSync(path.join(retentionTemp, "missing-receipt.json"), receiptPath);
  }

  const harness = `
set -Eeuo pipefail
APP_IMAGE_REPOSITORY=usage-monitor
PREVIOUS_SHA="$PREVIOUS_SHA_VALUE"
TARGET_SHA="$TARGET_SHA_VALUE"
RECEIPT_FILE="$RECEIPT_PATH_VALUE"
die() { printf 'ERROR: %s\\n' "$*" >&2; return 1; }
log() { printf '%s\\n' "$*" >&2; }
require_secure_root_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "unsafe receipt"
}
jq() {
  case "$2" in
    *activeRevision*) [[ "$RECEIPT_ACTIVE_VALUE" != __FAIL__ ]] || return 1; printf '%s\\n' "$RECEIPT_ACTIVE_VALUE" ;;
    *previousRevision*) [[ "$RECEIPT_PREVIOUS_VALUE" != __FAIL__ ]] || return 1; printf '%s\\n' "$RECEIPT_PREVIOUS_VALUE" ;;
    *) return 2 ;;
  esac
}
docker() {
  if [[ "$1 $2" == "image ls" ]]; then
    printf '%s\\n' "$IMAGE_ROWS_VALUE"
    return 0
  fi
  if [[ "$1 $2" == "ps -aq" ]]; then
    local image_ref="\${4#ancestor=}"
    [[ "$image_ref" == "$REFERENCED_IMAGE_VALUE" ]] && printf 'container-id\\n'
    return 0
  fi
  if [[ "$1 $2" == "image rm" ]]; then
    printf '%s\\n' "$3" >> "$REMOVAL_LOG_VALUE"
    [[ "$3" != "$FAIL_REMOVAL_VALUE" ]]
    return
  fi
  return 2
}
timeout() {
  while (( $# > 0 )) && [[ "$1" == --* ]]; do shift; done
  (( $# > 0 )) || return 2
  shift
  "$@"
}
${retentionFunction}
prune_unreferenced_application_images
`;
  return spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      IMAGE_ROWS_VALUE: imageRows,
      PREVIOUS_SHA_VALUE: previousSha,
      TARGET_SHA_VALUE: targetSha,
      RECEIPT_PATH_VALUE: receiptPath,
      RECEIPT_ACTIVE_VALUE: receiptActive,
      RECEIPT_PREVIOUS_VALUE: receiptPrevious,
      REFERENCED_IMAGE_VALUE: referencedImage,
      FAIL_REMOVAL_VALUE: failRemoval,
      REMOVAL_LOG_VALUE: removalLog,
    },
  });
}

function runBuildCacheCase({ fail = false } = {}) {
  const cacheLog = path.join(retentionTemp, "cache.log");
  rmSync(cacheLog, { force: true });
  const harness = `
set -Eeuo pipefail
MAX_BUILD_CACHE=8GB
MIN_BUILD_CACHE_FREE=12GB
RESERVED_BUILD_CACHE=4GB
log() { printf '%s\\n' "$*" >&2; }
docker() {
  printf '%s\\n' "$*" >> "$CACHE_LOG_VALUE"
  [[ "$FAIL_CACHE_VALUE" != true ]]
}
timeout() {
  while (( $# > 0 )) && [[ "$1" == --* ]]; do shift; done
  (( $# > 0 )) || return 2
  shift
  "$@"
}
${cacheFunction}
prune_bounded_build_cache
`;
  const result = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      CACHE_LOG_VALUE: cacheLog,
      FAIL_CACHE_VALUE: String(fail),
    },
  });
  return { result, cacheLog };
}

const restoreTemp = mkdtempSync(path.join(os.tmpdir(), "usage-monitor-restore-acceptance-"));

function runRestoreCase({
  restoreStatus = 0,
  integrityStatus = 0,
  integrityResult = "ok",
  foreignKeyStatus = 0,
  foreignKeyResult = "",
  orphanAfterRestore = false,
  killSwitch = false,
} = {}) {
  const caseDir = mkdtempSync(path.join(restoreTemp, "case-"));
  const commandLog = path.join(caseDir, "commands.log");
  const restoreMarker = path.join(caseDir, "restore-started");
  writeFileSync(commandLog, "");
  if (killSwitch) writeFileSync(path.join(caseDir, "r2-disabled-70pct.flag"), "enabled\n");
  const harness = `
set -Eeuo pipefail
APP_CONTAINER=usage-monitor-app-1
DATA_DIR="$CASE_DIR_VALUE"
DB_PATH="$CASE_DIR_VALUE/prod.db"
TARGET_SHA="${"a".repeat(40)}"
GARAGE_RESTORE_TIMEOUT_SECONDS=900
GARAGE_RESTORE_CLIENT_TIMEOUT_SECONDS=960
GARAGE_INTEGRITY_TIMEOUT_SECONDS=1800
GARAGE_FOREIGN_KEY_TIMEOUT_SECONDS=600
RESTORE_SCRATCH=""
die() { printf 'ERROR: %s\\n' "$*" >&2; return 1; }
log() { printf '%s\\n' "$*" >&2; }
timeout() {
  while (( $# > 0 )) && [[ "$1" == --* ]]; do shift; done
  (( $# > 1 )) || return 2
  shift
  "$@"
}
docker() {
  printf 'docker %s\\n' "$*" >> "$COMMAND_LOG_VALUE"
  case "$1" in
    top)
      local long_process_row
      printf 'PID COMMAND\\n'
      if [[ -f "$RESTORE_MARKER_VALUE" && "$ORPHAN_AFTER_RESTORE_VALUE" == true ]]; then
        long_process_row="4242 /usr/bin/timeout --signal=TERM --kill-after=30s 900 /app/bin/litestream restore -config /app/litestream.yml -integrity-check quick -o $RESTORE_SCRATCH /data/prod.db"
        if [[ " $* " == *" ww "* ]]; then
          printf '%s\\n' "$long_process_row"
        else
          printf '%s\\n' "\${long_process_row:0:80}"
        fi
      fi
      ;;
    exec)
      local argument output_path="" previous=""
      for argument in "$@"; do
        if [[ "$previous" == -o ]]; then output_path="$argument"; fi
        previous="$argument"
      done
      [[ -n "$output_path" ]] || return 2
      printf 'x' > "$output_path"
      : > "$RESTORE_MARKER_VALUE"
      return "$RESTORE_STATUS_VALUE"
      ;;
    *) return 2 ;;
  esac
}
sqlite3() {
  printf 'sqlite3 %s\\n' "$*" >> "$COMMAND_LOG_VALUE"
  case "$*" in
    *"PRAGMA integrity_check"*) printf '%s\\n' "$INTEGRITY_RESULT_VALUE"; return "$INTEGRITY_STATUS_VALUE" ;;
    *"PRAGMA foreign_key_check"*) printf '%s' "$FOREIGN_KEY_RESULT_VALUE"; return "$FOREIGN_KEY_STATUS_VALUE" ;;
    *"SELECT coalesce(group_concat"*) printf 'CREATE TABLE accepted(id INTEGER);\\n' ;;
    *) return 2 ;;
  esac
}
${isolatedRestoreFunctions}
trap cleanup_restore_scratch EXIT
verify_backup_restore
`;
  const result = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      CASE_DIR_VALUE: caseDir,
      COMMAND_LOG_VALUE: commandLog,
      RESTORE_MARKER_VALUE: restoreMarker,
      RESTORE_STATUS_VALUE: String(restoreStatus),
      INTEGRITY_STATUS_VALUE: String(integrityStatus),
      INTEGRITY_RESULT_VALUE: integrityResult,
      FOREIGN_KEY_STATUS_VALUE: String(foreignKeyStatus),
      FOREIGN_KEY_RESULT_VALUE: foreignKeyResult,
      ORPHAN_AFTER_RESTORE_VALUE: String(orphanAfterRestore),
    },
  });
  const commands = readFileSync(commandLog, "utf8");
  const restoreFiles = readdirSync(caseDir).filter((name) => name.startsWith(".deploy-garage-acceptance-"));
  return { result, commands, restoreFiles };
}

try {
  const revisions = Object.fromEntries(
    ["previous", "target", "active", "receiptPrevious", "referenced", "removable"].map((name, index) => [
      name,
      String.fromCharCode(97 + index).repeat(40),
    ]),
  );
  const protectedCase = runRetentionCase({
    imageRows: [
      `usage-monitor ${revisions.previous}`,
      `usage-monitor ${revisions.target}`,
      `usage-monitor ${revisions.active}`,
      `usage-monitor ${revisions.receiptPrevious}`,
      `usage-monitor ${revisions.referenced}`,
      `usage-monitor ${revisions.removable}`,
      "usage-monitor latest",
      `other-repository ${"f".repeat(40)}`,
    ].join("\n"),
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: revisions.active,
    receiptPrevious: revisions.receiptPrevious,
    referencedImage: `usage-monitor:${revisions.referenced}`,
  });
  assert.equal(protectedCase.status, 0, protectedCase.stderr);
  assert.equal(readFileSync(removalLog, "utf8"), `usage-monitor:${revisions.removable}\n`);

  const missingReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receipt: "missing",
  });
  assert.equal(missingReceipt.status, 0, missingReceipt.stderr);
  assert.equal(readFileSync(removalLog, "utf8"), `usage-monitor:${revisions.removable}\n`);

  const malformedReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: "not-a-revision",
    receiptPrevious: revisions.receiptPrevious,
  });
  assert.notEqual(malformedReceipt.status, 0, "malformed receipt must fail closed");

  const danglingReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receipt: "dangling",
  });
  assert.notEqual(danglingReceipt.status, 0, "dangling receipt symlink must fail closed");

  const failedRemoval = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: revisions.active,
    receiptPrevious: revisions.receiptPrevious,
    failRemoval: `usage-monitor:${revisions.removable}`,
  });
  assert.equal(failedRemoval.status, 0, failedRemoval.stderr);
  assert.match(failedRemoval.stderr, /disk preflight will decide/);

  const successfulCache = runBuildCacheCase();
  assert.equal(successfulCache.result.status, 0, successfulCache.result.stderr);
  assert.equal(
    readFileSync(successfulCache.cacheLog, "utf8"),
    "buildx prune --max-used-space=8GB --min-free-space=12GB --reserved-space=4GB --force\n",
  );

  const failedCache = runBuildCacheCase({ fail: true });
  assert.equal(failedCache.result.status, 0, failedCache.result.stderr);
  assert.match(failedCache.result.stderr, /disk preflight will decide/);

  const successfulRestore = runRestoreCase();
  assert.equal(successfulRestore.result.status, 0, successfulRestore.result.stderr);
  assert.match(successfulRestore.commands, /docker exec usage-monitor-app-1 \/usr\/bin\/timeout --signal=TERM --kill-after=30s 900 \/app\/bin\/litestream restore/);
  assert.match(successfulRestore.commands, /docker top usage-monitor-app-1 -eo pid,args ww/);
  assert.match(successfulRestore.commands, /-integrity-check quick/);
  assert.doesNotMatch(successfulRestore.commands, /-integrity-check full/);
  assert.equal((successfulRestore.commands.match(/PRAGMA integrity_check/g) ?? []).length, 1);
  assert.equal((successfulRestore.commands.match(/PRAGMA foreign_key_check/g) ?? []).length, 1);
  assert.deepEqual(successfulRestore.restoreFiles, [], "successful restore scratch must be removed");

  const skippedRestore = runRestoreCase({ killSwitch: true });
  assert.equal(skippedRestore.result.status, 0, skippedRestore.result.stderr);
  assert.match(skippedRestore.result.stderr, /R2 free-tier kill switch engaged; skipping full Garage acceptance restore/);
  assert.equal(skippedRestore.commands, "", "kill switch must skip all restore commands");

  const timedOutRestore = runRestoreCase({ restoreStatus: 124 });
  assert.notEqual(timedOutRestore.result.status, 0, "restore timeout must fail closed");
  assert.match(timedOutRestore.result.stderr, /restore did not complete \(exit 124\)/);
  assert.doesNotMatch(timedOutRestore.commands, /PRAGMA integrity_check/);
  assert.deepEqual(timedOutRestore.restoreFiles, [], "non-orphaned timeout scratch must be removed");

  const orphanedRestore = runRestoreCase({ restoreStatus: 124, orphanAfterRestore: true });
  assert.notEqual(orphanedRestore.result.status, 0, "orphaned restore must fail closed");
  assert.match(orphanedRestore.result.stderr, /restore process still runs/);
  assert.match(orphanedRestore.result.stderr, /refusing to unlink Garage acceptance scratch/);
  assert.equal(orphanedRestore.restoreFiles.length, 1, "orphaned restore scratch must remain linked");

  const corruptRestore = runRestoreCase({ integrityResult: "corrupt" });
  assert.notEqual(corruptRestore.result.status, 0, "non-ok full integrity must fail closed");
  assert.match(corruptRestore.result.stderr, /failed SQLite integrity/);

  const timedOutIntegrity = runRestoreCase({ integrityStatus: 124, integrityResult: "" });
  assert.notEqual(timedOutIntegrity.result.status, 0, "full integrity timeout must fail closed");
  assert.match(timedOutIntegrity.result.stderr, /integrity check did not complete/);

  const timedOutForeignKeys = runRestoreCase({ foreignKeyStatus: 124 });
  assert.notEqual(timedOutForeignKeys.result.status, 0, "foreign-key timeout must fail closed");
  assert.match(timedOutForeignKeys.result.stderr, /foreign-key check did not complete/);
} finally {
  rmSync(retentionTemp, { recursive: true, force: true });
  rmSync(restoreTemp, { recursive: true, force: true });
}

assert.deepEqual(
  {
    state: renderRetirement.state,
    autoDeploy: renderRetirement.autoDeploy,
    schedulerEnabled: renderRetirement.schedulerEnabled,
    writerAuthority: renderRetirement.writerAuthority,
  },
  {
    state: "suspended",
    autoDeploy: "off",
    schedulerEnabled: false,
    writerAuthority: "oracle",
  },
  "Render retirement evidence must encode a disabled former writer",
);

for (const relativePath of [
  "deploy/retired/oracle/deploy-production.sh",
  "deploy/retired/oracle/auto-deploy.sh",
]) {
  const result = spawnSync("bash", ["-n", path.join(repoRoot, relativePath)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${relativePath} failed bash -n: ${result.stderr}`);
}

const sameShaGuard = deploy.indexOf(
  'if [[ "${PREVIOUS_SHA}" == "${TARGET_SHA}" ]]',
);
const targetBuild = deploy.lastIndexOf(
  'ensure_mirror_and_release "${TARGET_SHA}"',
);
assert.ok(
  sameShaGuard >= 0 && targetBuild >= 0 && sameShaGuard < targetBuild,
  "same-SHA acceptance must occur before any image rebuild or retag",
);
assert.ok(
  (deploy.match(/require_current_main "\$\{TARGET_SHA\}"/g) ?? []).length >= 3 &&
    deploy.includes('accepted_main="$(remote_main_sha)"'),
  "main must be rechecked after build and immediately before cutover",
);

const recoveryLock = poller.indexOf('flock -w 10 8');
const recoveryCall = poller.indexOf('recover_current_app_if_stopped "${current_sha}"');
const recoveryUnlock = poller.indexOf('flock -u 8');
const childDeploy = poller.indexOf('"${DEPLOY_COMMAND}" "${target_sha}"');
assert.ok(
  recoveryLock >= 0 &&
    recoveryCall > recoveryLock &&
    recoveryUnlock > recoveryCall &&
    childDeploy > recoveryUnlock,
  "recovery must hold the shared transaction lock and release it before child deployment",
);

console.log("Oracle auto-deploy configuration checks passed.");
