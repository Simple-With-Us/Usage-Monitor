#!/usr/bin/env node
/**
 * Manual repro/integration test for scripts/migrate-safe.mjs.
 *
 * Exercises the real script (unmodified, invoked the same way
 * start-with-litestream.sh does) against real SQLite DB files, covering the
 * cases that matter for safe startup schema synchronization:
 *
 *   1. Fresh database: a missing DB file must be created successfully.
 *   2. Additive-only diff: an old-shape DB (schema.prisma from an earlier
 *      git revision) pushed against the current schema.prisma — must exit 0
 *      and apply the new tables/columns.
 *   3. Litestream-owned tables: additive schema synchronization must preserve
 *      arbitrary `_litestream_seq`/`_litestream_lock` schemas and data.
 *   4. Already-in-sync: re-running against the now-current DB — must exit 0
 *      as a no-op.
 *   5. Destructive diff with real data: a DB with actual rows in a
 *      table/column that a schema change would drop — must exit non-zero,
 *      leave the DB file byte-for-byte unchanged, and print manual
 *      --accept-data-loss instructions.
 *   6. Every production migration push disables Prisma client generation;
 *      both generated-client trees must remain byte- and metadata-identical
 *      across fresh, additive, no-op, and rejected destructive pushes.
 *
 * Scenario 5 needs a schema that's destructive *relative to the current
 * schema.prisma*, and migrate-safe.mjs always reads the default
 * prisma/schema.prisma path (it takes no --schema flag, matching how it's
 * actually invoked at deploy time) — so this script temporarily overwrites
 * the real prisma/schema.prisma and restores it from a backup in a
 * try/finally. It refuses to run at all if that file has uncommitted
 * changes, so it can never clobber in-progress work.
 *
 * All DB files live under a temp dir, cleaned up on exit.
 *
 * Usage: node scripts/test-migrate-safe-repro.mjs [old-schema-git-rev]
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma/schema.prisma");
const MIGRATE_SAFE = path.join(REPO_ROOT, "scripts/migrate-safe.mjs");
const GENERATED_CLIENT_PATHS = [
  path.join(REPO_ROOT, "node_modules/.prisma/client"),
  path.join(REPO_ROOT, "node_modules/@prisma/client"),
];

// An earlier commit whose prisma/schema.prisma predates the Project /
// Subscription / ProviderProjectAllocation models — gives a genuinely
// additive diff against the current schema. Override via argv[2].
const OLD_SCHEMA_REV = process.argv[2] || "421a05c";

let failures = 0;

function log(msg) {
  console.log(`[test-migrate-safe] ${msg}`);
}

function fail(msg) {
  console.error(`[test-migrate-safe] FAIL: ${msg}`);
  failures++;
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function snapshotGeneratedClients() {
  const entries = [];

  function visit(root, absolutePath, relativePath) {
    const stat = lstatSync(absolutePath, { bigint: true });
    const common = {
      root: path.relative(REPO_ROOT, root),
      path: relativePath,
      mode: stat.mode.toString(8),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };

    if (stat.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      for (const name of readdirSync(absolutePath).sort()) {
        visit(root, path.join(absolutePath, name), path.join(relativePath, name));
      }
      return;
    }

    if (stat.isSymbolicLink()) {
      entries.push({
        ...common,
        kind: "symlink",
        target: readlinkSync(absolutePath),
      });
      return;
    }

    entries.push({
      ...common,
      kind: "file",
      sha256: hashFile(absolutePath),
    });
  }

  for (const root of GENERATED_CLIENT_PATHS) {
    if (!existsSync(root)) {
      throw new Error(
        `generated Prisma client path is missing: ${path.relative(REPO_ROOT, root)}`
      );
    }
    visit(root, root, ".");
  }

  return JSON.stringify(entries);
}

function assertGeneratedClientsUnchanged(before, phase) {
  const after = snapshotGeneratedClients();
  if (after !== before) {
    fail(`generated Prisma client content or metadata changed during ${phase}`);
  } else {
    log(`  PASS — generated Prisma clients unchanged during ${phase}`);
  }
}

function readDatabaseSummary(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return {
      quickCheck: db.prepare("PRAGMA quick_check").get()?.quick_check ?? null,
      tableCount: Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .get()?.count ?? 0
      ),
    };
  } finally {
    db.close();
  }
}

function assertMigrationNeverGeneratesClient() {
  const source = readFileSync(MIGRATE_SAFE, "utf8");
  const commands = [
    ...source.matchAll(/\brun\("([^"]*npx prisma db push[^"]*)"\)/g),
  ].map((match) => match[1]);

  if (
    commands.length !== 2 ||
    commands.some((command) => command.split(/\s+/).includes("--skip-generate"))
  ) {
    fail(
      "migrate-safe must use plain `prisma db push` (Prisma 7 removed --skip-generate)"
    );
    return;
  }

  if (!source.includes("npx prisma db push --accept-data-loss")) {
    fail("manual data-loss guidance must reference `prisma db push --accept-data-loss`");
    return;
  }

  log("Client generation invariant: PASS — migration push does not use removed --skip-generate");
}

function seedLitestreamState(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE "_litestream_seq" (
        id INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        opaque BLOB NOT NULL
      );
      CREATE TABLE "_litestream_lock" (
        id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL,
        opaque BLOB NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO "_litestream_seq" (id, seq, opaque) VALUES (?, ?, ?)'
    ).run(1, 0x1f2e, Buffer.from([0x00, 0x7f, 0x80, 0xff]));
    db.prepare(
      'INSERT INTO "_litestream_lock" (id, owner, opaque) VALUES (?, ?, ?)'
    ).run(1, "litestream-owned", Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  } finally {
    db.close();
  }
}

function readLitestreamState(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const seqSchema = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '_litestream_seq'"
    ).get();
    const lockSchema = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '_litestream_lock'"
    ).get();
    const seq = db.prepare(
      'SELECT id, seq, opaque FROM "_litestream_seq" WHERE id = 1'
    ).get();
    const lock = db.prepare(
      'SELECT id, owner, opaque FROM "_litestream_lock" WHERE id = 1'
    ).get();
    return {
      seqSchema: seqSchema?.sql ?? null,
      lockSchema: lockSchema?.sql ?? null,
      seq: seq
        ? {
            id: seq.id,
            seq: seq.seq,
            opaque: Buffer.from(seq.opaque).toString("hex"),
          }
        : null,
      lock: lock
        ? {
            id: lock.id,
            owner: lock.owner,
            opaque: Buffer.from(lock.opaque).toString("hex"),
          }
        : null,
    };
  } finally {
    db.close();
  }
}

function gitShow(rev, relPath) {
  return execFileSync("git", ["show", `${rev}:${relPath}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/** Prisma 7 reads DATABASE_URL from prisma.config.ts; historical schema files still list `url`. */
function stripDatasourceUrlFromSchema(source) {
  return source.replace(/^\s*url\s*=\s*env\([^)]+\)\s*$/gm, "");
}

function runMigrateSafe(dbFile) {
  try {
    const stdout = execFileSync("node", [MIGRATE_SAFE], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

// Pushes a given schema file directly (bypassing migrate-safe.mjs) — used
// only to construct fixture DBs in known shapes, not to exercise the fix.
function pushSchemaDirect(schemaPath, dbFile) {
  execFileSync(
    "npx",
    ["prisma", "db", "push", `--schema=${schemaPath}`, "--accept-data-loss"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      stdio: "pipe",
    }
  );
}

// Textually strips the ProviderProjectAllocation model (a table) and
// Provider.label (a column) from a schema.prisma source, producing a
// schema that's destructive relative to any DB built from the unmodified
// current schema.
function toDestructiveSchema(source) {
  let out = source;
  // Drop Provider.label — the first `label String?` field is Provider's
  // (other models have their own unrelated `label` columns, left alone).
  out = out.replace(/^\s*label\s+String\?\s*\n/, "");
  // Drop every relation field pointing at ProviderProjectAllocation (both
  // Provider.allocations and Project.allocations reference it)...
  out = out.replace(/^\s*allocations\s+ProviderProjectAllocation\[\]\s*\n/gm, "");
  // ...and the model itself.
  out = out.replace(/\nmodel ProviderProjectAllocation \{[\s\S]*?\n\}\n/, "\n");
  if (out.includes("ProviderProjectAllocation") || out === source) {
    throw new Error(
      "toDestructiveSchema: expected patterns not found — schema.prisma shape changed, update this repro script"
    );
  }
  return out;
}

async function main() {
  assertMigrationNeverGeneratesClient();

  const dirty = execFileSync("git", ["status", "--porcelain", "--", "prisma/schema.prisma"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    console.error(
      "[test-migrate-safe] refusing to run: prisma/schema.prisma has uncommitted changes " +
        "(this script temporarily overwrites it). Commit or stash first."
    );
    process.exit(1);
  }

  const work = mkdtempSync(path.join(tmpdir(), "migrate-safe-repro-"));
  log(`working dir: ${work}`);
  const schemaBackup = path.join(work, "schema.prisma.orig-backup");
  copyFileSync(SCHEMA_PATH, schemaBackup);
  const generatedClientsBefore = snapshotGeneratedClients();

  try {
    // --- Scenario 1: fresh database ---
    log("Scenario 1: fresh database creation");
    const freshDb = path.join(work, "fresh.db");
    const freshScenario = runMigrateSafe(freshDb);
    const freshSummary = existsSync(freshDb)
      ? readDatabaseSummary(freshDb)
      : { quickCheck: null, tableCount: 0 };
    if (
      freshScenario.code === 0 &&
      freshSummary.quickCheck === "ok" &&
      freshSummary.tableCount > 0
    ) {
      log(
        `  PASS — fresh DB created with integrity ok and ${freshSummary.tableCount} application tables`
      );
    } else {
      fail(
        `fresh scenario failed: exit=${freshScenario.code}, quickCheck=${freshSummary.quickCheck}, ` +
          `tableCount=${freshSummary.tableCount}\n${freshScenario.stdout}\n${freshScenario.stderr}`
      );
    }
    assertGeneratedClientsUnchanged(generatedClientsBefore, "fresh DB creation");

    // --- Scenario 2: additive-only diff ---
    log(`Scenario 2: additive-only diff (schema.prisma@${OLD_SCHEMA_REV} -> current)`);
    const oldSchemaPath = path.join(work, "old-schema.prisma");
    writeFileSync(
      oldSchemaPath,
      stripDatasourceUrlFromSchema(gitShow(OLD_SCHEMA_REV, "prisma/schema.prisma"))
    );
    const additiveDb = path.join(work, "additive.db");
    pushSchemaDirect(oldSchemaPath, additiveDb);
    seedLitestreamState(additiveDb);
    const litestreamStateBefore = readLitestreamState(additiveDb);

    const scenario1 = runMigrateSafe(additiveDb);
    if (scenario1.code === 0) {
      log("  PASS — additive diff applied, exit 0");
    } else {
      fail(`additive scenario exited ${scenario1.code}\n${scenario1.stdout}\n${scenario1.stderr}`);
    }
    assertGeneratedClientsUnchanged(generatedClientsBefore, "additive migration");

    // --- Scenario 3: externally-managed Litestream state survives ---
    log("Scenario 3: Litestream external tables survive schema synchronization");
    const litestreamStateAfter = readLitestreamState(additiveDb);
    if (JSON.stringify(litestreamStateAfter) === JSON.stringify(litestreamStateBefore)) {
      log("  PASS — external table schemas and opaque rows were preserved exactly");
    } else {
      fail(
        `Litestream external state changed during schema synchronization\n` +
          `before=${JSON.stringify(litestreamStateBefore)}\n` +
          `after=${JSON.stringify(litestreamStateAfter)}`
      );
    }

    // --- Scenario 4: already in sync (no-op) ---
    log("Scenario 4: already-in-sync re-run");
    const scenario2 = runMigrateSafe(additiveDb);
    if (scenario2.code === 0) {
      log("  PASS — no-op re-run, exit 0");
    } else {
      fail(`already-in-sync scenario exited ${scenario2.code}\n${scenario2.stdout}\n${scenario2.stderr}`);
    }
    assertGeneratedClientsUnchanged(generatedClientsBefore, "no-op migration");

    // --- Scenario 5: destructive diff with real data ---
    log("Scenario 5: destructive diff with real data present");
    const destructiveDb = path.join(work, "destructive.db");
    copyFileSync(additiveDb, destructiveDb);

    // Seed application rows through the generated Prisma client so this case
    // exercises the same schema and write path as the production application.
    const { createPrismaClient } = await import("./lib/create-prisma-client.mjs");
    const seedClient = createPrismaClient({ databaseUrl: `file:${destructiveDb}` });
    const seedProvider = await seedClient.provider.create({
      data: { name: "repro-provider", displayName: "Repro Provider", label: "some-label" },
    });
    const seedProject = await seedClient.project.create({ data: { name: "Repro Project" } });
    await seedClient.providerProjectAllocation.create({
      data: { providerId: seedProvider.id, projectId: seedProject.id, percentage: 100 },
    });
    await seedClient.$disconnect();

    const destructiveSchema = toDestructiveSchema(readFileSync(SCHEMA_PATH, "utf8"));
    writeFileSync(SCHEMA_PATH, destructiveSchema);

    const beforeHash = hashFile(destructiveDb);
    const scenario3 = runMigrateSafe(destructiveDb);
    const afterHash = hashFile(destructiveDb);

    // Restore the real schema immediately, before any further assertions.
    copyFileSync(schemaBackup, SCHEMA_PATH);

    if (scenario3.code !== 0 && beforeHash === afterHash) {
      log(`  PASS — destructive diff refused (exit ${scenario3.code}), DB left unchanged`);
      // migrate-safe.mjs routes all of its error-path output (including
      // Prisma's own captured stdout/stderr) through console.error, so it
      // all lands on the child process's stderr.
      if (!scenario3.stderr.includes("--accept-data-loss")) {
        fail("destructive scenario refused correctly but did not mention --accept-data-loss guidance");
      }
    } else {
      fail(
        `destructive scenario should have refused with the DB untouched; got exit=${scenario3.code}, ` +
          `dbChanged=${beforeHash !== afterHash}\n${scenario3.stdout}\n${scenario3.stderr}`
      );
    }
    assertGeneratedClientsUnchanged(
      generatedClientsBefore,
      "rejected destructive migration"
    );
  } finally {
    // Always restore the real schema.prisma, even if an assertion above threw.
    copyFileSync(schemaBackup, SCHEMA_PATH);
    rmSync(work, { recursive: true, force: true });
  }

  const dirtyAfter = execFileSync("git", ["status", "--porcelain", "--", "prisma/schema.prisma"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (dirtyAfter) {
    fail("prisma/schema.prisma was not restored cleanly after the run");
  }

  if (failures > 0) {
    console.error(`\n[test-migrate-safe] ${failures} scenario(s) FAILED`);
    process.exit(1);
  }
  console.log("\n[test-migrate-safe] all scenarios PASSED");
}

main();
