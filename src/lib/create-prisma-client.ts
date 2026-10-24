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
  const adapter = new PrismaBetterSqlite3({ url: sqliteDriverUrl(url) });
  return new PrismaClient({ adapter });
}
