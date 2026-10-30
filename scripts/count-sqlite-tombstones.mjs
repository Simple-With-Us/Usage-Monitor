import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const [databasePath, ...extraArgs] = process.argv.slice(2);
if (!databasePath || extraArgs.length > 0 || !isAbsolute(databasePath)) {
  process.stderr.write("A single absolute SQLite database path is required.\n");
  process.exit(2);
}

let db;
try {
  db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const row = db
    .prepare('SELECT COUNT(*) AS "count" FROM "ExternalUsageEventTombstone"')
    .get();
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("SQLite returned an invalid tombstone count");
  }
  process.stdout.write(`${count}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error" })}\n`
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
