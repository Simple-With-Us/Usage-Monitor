import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Strips Prisma-engine query params that SQLite drivers do not understand. */
export function sqliteDriverUrl(url: string): string {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex === -1) {
    return withoutHash;
  }

  const base = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  const kept = query
    .split("&")
    .filter((segment) => segment.length > 0 && !segment.startsWith("connection_limit="));
  if (kept.length === 0) {
    return base;
  }
  return `${base}?${kept.join("&")}`;
}

/** Resolves a Prisma `file:` SQLite DATABASE_URL to an absolute filesystem path. */
export function parseSqliteDatabasePath(databaseUrl: string): string {
  if (!databaseUrl?.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a file: SQLite URL");
  }

  const withoutQuery = databaseUrl.split(/[?#]/, 1)[0];
  if (withoutQuery === "file::memory:" || withoutQuery === "file:") {
    throw new Error("DATABASE_URL must point to a persistent SQLite file");
  }

  if (withoutQuery.startsWith("file://")) {
    return fileURLToPath(new URL(withoutQuery));
  }

  let path: string;
  try {
    path = decodeURIComponent(withoutQuery.slice("file:".length));
  } catch {
    throw new Error("DATABASE_URL contains invalid percent encoding");
  }
  if (!path || path === ":memory:") {
    throw new Error("DATABASE_URL must point to a persistent SQLite file");
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function sqliteDatabaseFileExists(databaseUrl: string): boolean {
  if (!databaseUrl?.startsWith("file:")) {
    return false;
  }
  try {
    const path = parseSqliteDatabasePath(databaseUrl);
    return existsSync(path);
  } catch {
    return false;
  }
}
