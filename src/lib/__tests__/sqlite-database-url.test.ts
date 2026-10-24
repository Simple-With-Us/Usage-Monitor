import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSqliteDatabasePath,
  sqliteDatabaseFileExists,
  sqliteDriverUrl,
} from "../sqlite-database-url";

describe("sqliteDriverUrl", () => {
  it("strips connection_limit while preserving other query params", () => {
    expect(sqliteDriverUrl("file:./dev.db?connection_limit=1")).toBe("file:./dev.db");
    expect(sqliteDriverUrl("file:./dev.db?connection_limit=1&socket_timeout=30")).toBe(
      "file:./dev.db?socket_timeout=30"
    );
    expect(sqliteDriverUrl("file:./dev.db?socket_timeout=30&connection_limit=1")).toBe(
      "file:./dev.db?socket_timeout=30"
    );
  });

  it("leaves URLs without Prisma engine params unchanged", () => {
    expect(sqliteDriverUrl("file:./dev.db")).toBe("file:./dev.db");
    expect(sqliteDriverUrl("file:./dev.db?socket_timeout=30")).toBe(
      "file:./dev.db?socket_timeout=30"
    );
  });
});

describe("parseSqliteDatabasePath", () => {
  it("ignores query parameters when resolving the filesystem path", () => {
    const resolved = parseSqliteDatabasePath(
      "file:./prisma/dev.db?connection_limit=1&socket_timeout=30"
    );
    expect(resolved).toBe(path.resolve(process.cwd(), "./prisma/dev.db"));
  });
});

describe("sqliteDatabaseFileExists", () => {
  it("does not treat query suffixes as part of the filename", () => {
    expect(
      sqliteDatabaseFileExists("file:./prisma/dev.db?connection_limit=1")
    ).toBe(sqliteDatabaseFileExists("file:./prisma/dev.db"));
  });
});
