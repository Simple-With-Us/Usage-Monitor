import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { countExternalUsageEventTombstones } from "@/lib/sqlite-tombstone-count";

const require = createRequire(import.meta.url);
interface FixtureDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: Array<string | number>): unknown };
  transaction<T>(callback: () => T): () => T;
  close(): void;
}
const Database = require("better-sqlite3") as new (filename: string) => FixtureDatabase;

let fixtureDirectory: string | undefined;

afterEach(() => {
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = undefined;
});

function createFixtureDatabase(): { databasePath: string; db: FixtureDatabase } {
  fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "sqlite-tombstone-count-"));
  const databasePath = path.join(fixtureDirectory, "fixture.db");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE "ExternalUsageEventTombstone" (
      "idempotencyKey" TEXT NOT NULL PRIMARY KEY,
      "occurredAt" DATETIME NOT NULL,
      "prunedAt" DATETIME NOT NULL
    );
  `);
  return { databasePath, db };
}

describe("countExternalUsageEventTombstones", () => {
  it("returns the exact SQLite count while the parent event loop continues", async () => {
    const { databasePath, db } = createFixtureDatabase();
    const insert = db.prepare(
      'INSERT INTO "ExternalUsageEventTombstone" VALUES (?, ?, ?)'
    );
    const insertRows = db.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`tombstone-${index}`, 1_700_000_000_000, 1_700_000_000_000);
      }
    });
    insertRows();
    db.close();

    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks += 1;
    }, 0);
    try {
      await expect(countExternalUsageEventTombstones(`file:${databasePath}`)).resolves.toBe(
        2_000
      );
      expect(timerTicks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it("does not create a missing database while opening the child reader", async () => {
    fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "sqlite-tombstone-missing-"));
    const databasePath = path.join(fixtureDirectory, "missing.db");
    expect(existsSync(databasePath)).toBe(false);

    await expect(countExternalUsageEventTombstones(`file:${databasePath}`)).rejects.toThrow(
      /Read-only SQLite tombstone count failed/
    );
    expect(existsSync(databasePath)).toBe(false);
  });
});
