import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { sqliteWriteContentionCode } from "../sqlite-write-contention";

describe("usage ingest SQLite writer reservation", () => {
  let dir: string;
  let other: { exec(sql: string): unknown; close(): void };
  let prisma: typeof import("../prisma").prisma;
  let persist: typeof import("../external-usage-events").persistExternalUsageEvents;
  let reserve: typeof import("../external-usage-events").reserveExternalUsageWriter;
  const event = {
    idempotencyKey: "writer-lock-event", sourceApp: "codex", provider: "openai",
    billingMode: "estimated", metricType: "usage", quantity: 3, unit: "token",
    occurredAt: new Date("2026-10-30T12:00:00Z"),
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-writer-lock-"));
    const file = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${file}`;
    setupPrismaSqliteTestDb(file);
    // Use the adapter's own SQLite library. Mixing node:sqlite with another
    // SQLite library in one process bypasses their per-process lock tables.
    const require = createRequire(import.meta.url);
    const Database = require(require.resolve("better-sqlite3", {
      paths: [require.resolve("@prisma/adapter-better-sqlite3")],
    }));
    other = new Database(file, { timeout: 0 });
    other.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE writer_probe(n INTEGER); INSERT INTO writer_probe VALUES(0)");
    ({ prisma } = await import("../prisma"));
    ({ persistExternalUsageEvents: persist, reserveExternalUsageWriter: reserve } = await import("../external-usage-events"));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    other?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reproduces the production P1008 wording when a deferred reader upgrades a stale snapshot", async () => {
    const error = await prisma.$transaction(async (tx) => {
      await tx.externalUsageEventTombstone.findMany();
      other.exec("UPDATE writer_probe SET n=n+1");
      await tx.externalUsageEvent.createMany({ data: [event] });
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "P1008" });
    expect(sqliteWriteContentionCode(error)).toBe("SQLITE_BUSY_SNAPSHOT");
    expect(await prisma.externalUsageEvent.count()).toBe(0);
  });

  it("reserves the writer before its first read and retains exact replay semantics", async () => {
    await prisma.$transaction(async (tx) => {
      await reserve(tx);
      await tx.externalUsageEventTombstone.findMany();
      expect(() => other.exec("UPDATE writer_probe SET n=n+1")).toThrow("database is locked");
      await tx.externalUsageEvent.createMany({ data: [event] });
    });
    expect((await persist([event])).persisted).toBe(0);
    await expect(persist([{ ...event, quantity: 4 }])).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
    other.exec("UPDATE writer_probe SET n=n+1");
  });
});
