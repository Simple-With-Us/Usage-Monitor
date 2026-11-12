import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { sqliteDriverUrl } from "./sqlite-database-url";

export { sqliteDriverUrl } from "./sqlite-database-url";

export type CreatePrismaClientOptions = {
  /** Overrides `DATABASE_URL` (tests, migrate-safe repro). */
  databaseUrl?: string;
};

/**
 * Single construction path for Prisma 7 + SQLite: driver adapter required;
 * datasource URL lives in prisma.config.ts for CLI, not in schema.
 */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!url?.trim()) {
    throw new Error(
      "DATABASE_URL is required to construct PrismaClient (set env or pass databaseUrl)"
    );
  }
  // better-sqlite3 is synchronous:  every query, and the whole body of an
  // interactive `$transaction(async (tx) => ...)`, runs on the Node main
  // thread with no timer or I/O turn until it finishes.  Measured on a temp DB
  // (UM-1630):  1,000 awaited single-row UPDATEs in one transaction held the
  // event loop ~330ms and 10,000 held it ~2.2s, while one set-based UPDATE of
  // 10,000 rows took ~17ms.  Keep transaction bodies short and set-based.
  const adapter = new PrismaBetterSqlite3({ url: sqliteDriverUrl(url) });
  return new PrismaClient({ adapter });
}
