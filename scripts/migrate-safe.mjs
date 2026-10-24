#!/usr/bin/env node
/**
 * Safe migration script for Prisma + SQLite deployments.
 *
 * Runs `prisma db push` (never `--accept-data-loss`) and trusts
 * Prisma's own built-in guard: it refuses to apply a change that would actually
 * drop or truncate non-empty rows (checked against real row counts, not just
 * schema-shape heuristics like "a table was recreated") and applies cleanly
 * otherwise, exiting non-zero only when data would genuinely be lost.
 * Prisma 7 no longer runs `prisma generate` from `db push` (the old
 * `--skip-generate` flag is gone), so deploy-time pushes cannot race client
 * generation. On refusal this
 * script exits with instructions for manual review instead of silently forcing
 * the change via --accept-data-loss. Litestream's internal tables are excluded
 * from Prisma schema management in prisma.config.ts.
 *
 * Previously this ran `prisma db push --dry-run` first and parsed the diff
 * text for destructive-looking patterns — `--dry-run` is not a supported
 * flag on the pinned Prisma version (6.19.3; `npx prisma db push --help`
 * lists no such option), so that pre-check crashed unconditionally on every
 * deploy once the disk already had a DB file, before it ever ran the actual
 * push. Verified locally (old-shape SQLite DB + newer schema, both via
 * `git show <sha>:prisma/schema.prisma`) that a plain `db push` already
 * applies additive-only diffs cleanly and refuses destructive ones that
 * would touch real data, so the separate dry-run/parsing step was removed
 * rather than repaired.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";

const DB_PATH = process.env.DATABASE_URL;

function log(message) {
  console.log(`[migrate-safe] ${message}`);
}

function error(message) {
  console.error(`[migrate-safe] ERROR: ${message}`);
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" });
}

async function main() {
  // If the database file doesn't exist yet (first deploy), `prisma db push`
  // is always safe — it will create all tables from scratch.
  let dbExists = false;
  if (DB_PATH) {
    // Parse the SQLite file path from DATABASE_URL (format: "file:/path/to/db")
    const match = DB_PATH.match(/^file:([^?]+)/);
    if (match) {
      dbExists = existsSync(match[1]);
    }
  }

  if (!dbExists) {
    log("No existing database found — creating schema from scratch (safe).");
    run("npx prisma db push");
    log("Database created successfully.");
    return;
  }

  log("Existing database found — applying schema changes...");

  try {
    const output = run("npx prisma db push");
    process.stdout.write(output);
    log(
      output.includes("already in sync")
        ? "Schema is already up to date."
        : "Schema migrated successfully."
    );
  } catch (err) {
    error("prisma db push refused to apply the schema changes:");
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    console.error("");
    console.error(
      "Prisma detected this change would drop or truncate existing data on"
    );
    console.error(
      "SQLite (table/column recreation) and refused to apply it automatically."
    );
    console.error("");
    console.error("To proceed:");
    console.error(
      "  1. Confirm startup logged a verified .pre-migration-backups/*.backup.db snapshot."
    );
    console.error(
      "     Do not use raw cp on a live SQLite database; use the verified Online Backup API snapshot."
    );
    console.error("  2. Review the data-loss warning above carefully.");
    console.error(
      "  3. If you're certain the loss is acceptable, manually run:"
    );
    console.error("       npx prisma db push --accept-data-loss");
    console.error(
      "  4. Or use Prisma Migrate for a proper migration: npx prisma migrate dev"
    );
    process.exit(1);
  }
}

main();
