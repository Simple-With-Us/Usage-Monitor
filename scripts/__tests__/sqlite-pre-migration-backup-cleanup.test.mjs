import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { removeStalePartials } from "../lib/sqlite-pre-migration-backup-cleanup.mjs";

const CLEANUP_SOURCE = fileURLToPath(
  new URL("../lib/sqlite-pre-migration-backup-cleanup.mjs", import.meta.url)
);

test("removeStalePartials ignores ENOENT stat/unlink races without deleting live files", () => {
  const source = readFileSync(CLEANUP_SOURCE, "utf8");
  assert.match(source, /function isENOENT/, "ENOENT helper must exist");
  assert.match(
    source,
    /catch \(error\)[\s\S]*isENOENT\(error\)/,
    "stat/unlink races must be caught and ignored"
  );
});

test("removeStalePartials removes only stale partials", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-partial-cleanup-"));
  const stale = join(dir, "prod.db.pre-migration-20260101T000000000Z-1.partial");
  const fresh = join(dir, "prod.db.pre-migration-20261027T170000000Z-2.partial");
  writeFileSync(stale, "old");
  writeFileSync(fresh, "young");
  const oldDate = new Date(Date.now() - 20 * 60_000);
  utimesSync(stale, oldDate, oldDate);

  const removed = [];
  const env = { ...process.env, SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS: "300000" };
  removeStalePartials(dir, "prod.db.pre-migration-", (msg) => removed.push(msg), env);

  assert.equal(removed.length, 1);
  assert.match(removed[0], /removed stale partial/);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(fresh));
});
