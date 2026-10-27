// Behavior repro of the cross-startup partial-cleanup race observed when two
// Usage Monitor containers share one /data volume: a second startup's cleanup
// must not delete another instance's in-flight snapshot partial, while a
// genuinely stale (crashed) partial must still be collected.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { stalePartialGuardMinutesForFind } from "./lib/sqlite-pre-migration-backup-timing.mjs";

const SCRIPT = fileURLToPath(
  new URL("./backup-sqlite-before-migrate.mjs", import.meta.url)
);
const WRAPPER = fileURLToPath(
  new URL("./start-with-litestream.sh", import.meta.url)
);

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "um-backup-race-"));
  const db = new DatabaseSync(join(dir, "prod.db"));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, pad TEXT)");
  const insert = db.prepare("INSERT INTO t (pad) VALUES (?)");
  const pad = "x".repeat(512);
  for (let i = 0; i < 60_000; i += 1) insert.run(pad);
  db.close();
  return dir;
}

function runBackup(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: `file:${join(dir, "prod.db")}`, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
}

function partials(dir) {
  const backupDir = join(dir, ".pre-migration-backups");
  return existsSync(backupDir)
    ? readdirSync(backupDir).filter((n) => n.endsWith(".partial"))
    : [];
}

test("a concurrent startup's cleanup preserves an in-flight partial", async () => {
  const dir = makeDataDir();
  const backupDir = join(dir, ".pre-migration-backups");

  const a = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: `file:${join(dir, "prod.db")}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let aErr = "";
  a.stderr.on("data", (c) => (aErr += c));

  const deadline = Date.now() + 30_000;
  while (partials(dir).length === 0) {
    if (Date.now() > deadline) throw new Error("parent A never created a partial");
    await new Promise((r) => setTimeout(r, 25));
  }
  const aPartial = partials(dir)[0];
  const b = runBackup(dir);
  assert.equal(
    b.status,
    0,
    `parent B should complete; stderr: ${b.stderr}\nstdout: ${b.stdout}`
  );

  const aExit = await new Promise((resolve) => a.on("close", resolve));
  assert.equal(
    aExit,
    0,
    `parent A's in-flight partial ${aPartial} must survive B's cleanup; stderr: ${aErr}`
  );
  assert.ok(
    readdirSync(backupDir).some((n) => n.endsWith(".backup.db")),
    "at least one verified backup must exist"
  );
});

test("a partial orphaned well past twice the deadline is collected", () => {
  const dir = makeDataDir();
  const backupDir = join(dir, ".pre-migration-backups");
  const first = runBackup(dir);
  assert.equal(first.status, 0, `setup backup should succeed: ${first.stderr}`);

  const orphan = join(backupDir, "prod.db.pre-migration-20000101T000000000Z-99.partial");
  writeFileSync(orphan, "orphaned");
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(orphan, old, old);

  const second = runBackup(dir);
  assert.equal(second.status, 0, `second backup should succeed: ${second.stderr}`);
  assert.ok(!existsSync(orphan), "stale orphan partial should be collected");
});

test("the wrapper startup cleanup is age-guarded the same way", () => {
  const wrapperSource = readFileSync(WRAPPER, "utf8");
  assert.match(
    wrapperSource,
    /find \/data\/\.pre-migration-backups -maxdepth 1 -type f -name '\*\.partial' -mmin \+/,
    "wrapper must use an age-guarded find, not an unconditional rm"
  );
  assert.ok(
    !wrapperSource.includes("rm -f /data/.pre-migration-backups/*.partial"),
    "unconditional rm of all partials must be gone"
  );
  assert.match(
    wrapperSource,
    /sqlite-pre-migration-backup-timing\.mjs" --guard-minutes/,
    "wrapper must read the same guard minutes as the Node backup script"
  );
  assert.match(
    wrapperSource,
    /stale_guard_min=10/,
    "wrapper must fall back to a safe default when the timing helper fails"
  );

  const guardMin = stalePartialGuardMinutesForFind();
  const dir = mkdtempSync(join(tmpdir(), "um-wrapper-clean-"));
  const backupDir = join(dir, ".pre-migration-backups");
  spawnSync("mkdir", ["-p", backupDir]);
  const young = join(backupDir, "prod.db.pre-migration-20261027T170000000Z-51.partial");
  const old = join(backupDir, "prod.db.pre-migration-20261027T160000000Z-51.partial");
  writeFileSync(young, "young");
  writeFileSync(old, "old");
  const oldDate = new Date(Date.now() - (guardMin + 2) * 60_000);
  utimesSync(old, oldDate, oldDate);

  const find = spawnSync(
    "find",
    [
      backupDir,
      "-maxdepth",
      "1",
      "-type",
      "f",
      "-name",
      "*.partial",
      "-mmin",
      `+${guardMin}`,
      "-delete",
    ]
  );
  assert.equal(find.status, 0, "find cleanup should run");
  assert.ok(existsSync(young), "young in-flight partial must survive");
  assert.ok(!existsSync(old), "stale partial must be collected");
});
