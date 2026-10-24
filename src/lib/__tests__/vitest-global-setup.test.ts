import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeVitestFallbackDatabases } from "../../../vitest.global-setup";

describe("removeVitestFallbackDatabases", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes only the per-worker fallback DBs and their sidecars", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-fallback-db-"));
    dirs.push(dir);
    const fallback = [
      "vitest-worker-1.db",
      "vitest-worker-1.db-wal",
      "vitest-worker-1.db-shm",
      "vitest-worker-12.db-journal",
    ];
    const kept = ["schema.prisma", "dev.db", "vitest-worker-x.db", "vitest-global.db"];
    for (const name of [...fallback, ...kept]) fs.writeFileSync(path.join(dir, name), "");

    expect(removeVitestFallbackDatabases(dir).sort()).toEqual([...fallback].sort());
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort());
  });

  it("is a no-op when the directory does not exist", () => {
    expect(removeVitestFallbackDatabases(path.join(os.tmpdir(), "no-such-dir-um-1630"))).toEqual([]);
  });
});
