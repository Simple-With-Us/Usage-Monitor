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

  function seed(names: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-fallback-db-"));
    dirs.push(dir);
    for (const name of names) fs.writeFileSync(path.join(dir, name), "");
    return dir;
  }

  const live = ["vitest-worker-200-1.db", "vitest-worker-200-1.db-wal"];
  const dead = ["vitest-worker-100-1.db", "vitest-worker-100-1.db-shm", "vitest-worker-100-3.db-journal"];
  const legacy = ["vitest-worker-2.db", "vitest-worker-2.db-wal"];
  const unrelated = ["schema.prisma", "dev.db", "vitest-worker-x.db", "vitest-global.db"];
  const isAlive = (pid: number) => pid === 200;

  it("pre-run: removes dead runs and legacy files, keeps a live concurrent run", () => {
    const dir = seed([...live, ...dead, ...legacy, ...unrelated]);
    expect(removeVitestFallbackDatabases(dir, undefined, isAlive).sort()).toEqual(
      [...dead, ...legacy].sort()
    );
    expect(fs.readdirSync(dir).sort()).toEqual([...live, ...unrelated].sort());
  });

  it("teardown: removes only this run's files", () => {
    const dir = seed([...live, ...dead, ...legacy, ...unrelated]);
    expect(removeVitestFallbackDatabases(dir, 100, isAlive).sort()).toEqual([...dead].sort());
    expect(fs.readdirSync(dir).sort()).toEqual([...live, ...legacy, ...unrelated].sort());
  });

  it("pre-run: removes files left under this run's recycled pid", () => {
    const dir = seed([...live, ...unrelated]);
    expect(removeVitestFallbackDatabases(dir, undefined, isAlive, 200).sort()).toEqual(
      [...live].sort()
    );
    expect(fs.readdirSync(dir).sort()).toEqual([...unrelated].sort());
  });

  it("is a no-op when the directory does not exist", () => {
    expect(removeVitestFallbackDatabases(path.join(os.tmpdir(), "no-such-dir-um-1630"))).toEqual([]);
  });
});
