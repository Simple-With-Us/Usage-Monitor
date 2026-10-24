import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

/** Strips Prisma-engine query params that SQLite drivers do not understand. */
export function sqliteDriverUrl(url: string): string {
  const withoutConnectionLimit = url.replace(/([?&])connection_limit=[^&]*/g, (match, sep) =>
    sep === "?" ? "?" : ""
  );
  return withoutConnectionLimit.replace(/\?$/, "");
}

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
