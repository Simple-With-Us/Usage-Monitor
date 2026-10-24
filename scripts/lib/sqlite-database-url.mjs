import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Strips Prisma-engine query params (e.g. connection_limit) that SQLite drivers
 * do not understand, preserving any other query string in valid form.
 */
export function sqliteDriverUrl(url) {
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

/**
 * Resolves a Prisma `file:` SQLite DATABASE_URL to an absolute filesystem path.
 * Query parameters (connection_limit, socket_timeout, …) are ignored.
 */
export function parseSqliteDatabasePath(databaseUrl) {
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

  let path;
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

/** True when the SQLite file for `databaseUrl` already exists on disk. */
export function sqliteDatabaseFileExists(databaseUrl) {
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
