#!/usr/bin/env node
// Staged-error coverage for backup-sqlite-before-migrate.mjs: each snapshot
// stage failure must name its stage and path so ops can locate bare SQLite
// errors (e.g. "unable to open database file") without a debugger.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "backup-sqlite-before-migrate.mjs");
const source = readFileSync(script, "utf8");

function runChild(argv) {
  return spawnSync(process.execPath, [script, ...argv], { encoding: "utf8" });
}

function createWalSourceDb(dir, { rowCount = 0 } = {}) {
  const dbPath = join(dir, "prod.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  if (rowCount > 0) {
    const insert = db.prepare("INSERT INTO t (id) VALUES (?)");
    for (let index = 0; index < rowCount; index += 1) {
      insert.run(index);
    }
  }
  db.close();
  return dbPath;
}

// Source-level: every stage of the child is wrapped with a stage+path message.
for (const label of [
  "snapshot could not open source",
  "snapshot VACUUM INTO",
  "backup integrity check could not open",
  "backup integrity_check failed for",
]) {
  assert.ok(source.includes(label), `staged error label missing: ${label}`);
}

// Live: source-open failure names the stage and the missing path.
{
  const missing = join(mkdtempSync(join(tmpdir(), "bk-missing-")), "no.db");
  const r = runChild(["--snapshot-child", missing, join(tmpdir(), "x.partial")]);
  assert.equal(r.status, 1, `child should fail: ${r.stderr}`);
  assert.match(r.stderr, /snapshot could not open source/);
  assert.match(r.stderr, new RegExp(missing.replace(/[/.]/g, "\\$&")));
}

// Live: VACUUM INTO failure (target directory does not exist) names the stage,
// the target path, and preserves the original SQLite message.
{
  const dir = mkdtempSync(join(tmpdir(), "bk-src-"));
  const dbPath = createWalSourceDb(dir);
  const badTarget = join(dir, "no-such-dir", "snap.partial");
  const r = runChild(["--snapshot-child", dbPath, badTarget]);
  assert.equal(r.status, 1, `child should fail: ${r.stderr}`);
  assert.match(r.stderr, /snapshot VACUUM INTO/);
  assert.match(r.stderr, /unable to open database/);
  assert.match(r.stderr, /no-such-dir/);
  rmSync(dir, { recursive: true, force: true });
}

// Live: backup open failure after a successful VACUUM (path exists but is not a DB file).
{
  const dir = mkdtempSync(join(tmpdir(), "bk-open-"));
  const dbPath = createWalSourceDb(dir);
  const target = join(dir, "snap.partial");
  const ok = runChild(["--snapshot-child", dbPath, target]);
  assert.equal(ok.status, 0, `setup snapshot should succeed: ${ok.stderr}`);
  rmSync(target, { force: true });
  mkdirSync(target);
  const r = runChild(["--assert-integrity-only", target]);
  assert.equal(r.status, 1, `child should fail: ${r.stderr}`);
  assert.match(r.stderr, /backup integrity check could not open/);
  assert.match(r.stderr, /snap\.partial/);
  rmSync(dir, { recursive: true, force: true });
}

// Live: integrity_check execution failure names the stage, path, and SQLite message.
{
  const dir = mkdtempSync(join(tmpdir(), "bk-integ-"));
  const dbPath = createWalSourceDb(dir, { rowCount: 200 });
  const target = join(dir, "snap.partial");
  const ok = runChild(["--snapshot-child", dbPath, target]);
  assert.equal(ok.status, 0, `setup snapshot should succeed: ${ok.stderr}`);
  const bytes = readFileSync(target);
  assert.ok(bytes.length > 4096, "snapshot must be large enough for staged corruption");
  bytes[4096] = 0xff;
  writeFileSync(target, bytes);
  const r = runChild(["--assert-integrity-only", target]);
  assert.equal(r.status, 1, `child should fail: ${r.stderr}`);
  assert.match(r.stderr, /backup integrity_check failed for/);
  assert.match(r.stderr, /database disk image is malformed/);
  rmSync(dir, { recursive: true, force: true });
}

// Live: happy path through the child still succeeds (target created + integrity ok).
{
  const dir = mkdtempSync(join(tmpdir(), "bk-ok-"));
  const dbPath = createWalSourceDb(dir);
  const target = join(dir, "snap.partial");
  const r = runChild(["--snapshot-child", dbPath, target]);
  assert.equal(r.status, 0, `child should succeed: ${r.stderr}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log("staged-error tests: 6/6 passed");
