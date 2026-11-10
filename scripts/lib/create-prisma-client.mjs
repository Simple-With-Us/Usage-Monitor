import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { sqliteDriverUrl } from "./sqlite-database-url.mjs";

export { sqliteDriverUrl } from "./sqlite-database-url.mjs";

export function createPrismaClient({ databaseUrl } = {}) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url?.trim()) {
    throw new Error(
      "DATABASE_URL is required to construct PrismaClient (set env or pass databaseUrl)"
    );
  }
  const adapter = new PrismaBetterSqlite3({ url: sqliteDriverUrl(url) });
  return new PrismaClient({ adapter });
}
