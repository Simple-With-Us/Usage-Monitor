import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

export function sqliteDriverUrl(url) {
  const withoutConnectionLimit = url.replace(/([?&])connection_limit=[^&]*/g, (match, sep) =>
    sep === "?" ? "?" : ""
  );
  return withoutConnectionLimit.replace(/\?$/, "");
}

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
