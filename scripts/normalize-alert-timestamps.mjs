import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSqliteDatabasePath } from "./lib/sqlite-database-url.mjs";

const ALERT_DATE_COLUMNS = Object.freeze({
  ProviderAlertNotification: Object.freeze([
    "firstDetectedAt",
    "lastDetectedAt",
    "evidenceWatermarkAt",
    "evidenceSourceAt",
    "operationClaimExpiresAt",
    "operationClaimEvidenceSourceAt",
    "operationClaimEvidenceAt",
    "lastSentAt",
    "resolvedAt",
    "createdAt",
    "updatedAt",
  ]),
  ProviderAlertChannelDelivery: Object.freeze([
    "lastAttemptAt",
    "lastSucceededAt",
    "triggerClaimExpiresAt",
    "resolveClaimExpiresAt",
    "lastResolveAttemptAt",
    "lastResolvedAt",
    "createdAt",
    "updatedAt",
  ]),
});

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function inspectDateColumns(db) {
  const inspected = new Map();
  for (const [table, expectedColumns] of Object.entries(ALERT_DATE_COLUMNS)) {
    const tableInfo = db.pragma(`table_info(${quoteIdentifier(table)})`);
    if (tableInfo.length === 0) {
      throw new Error(`Expected alert table ${table} is missing`);
    }
    const columns = new Map(tableInfo.map((column) => [column.name, column]));
    for (const name of expectedColumns) {
      const column = columns.get(name);
      if (!column || String(column.type).toUpperCase() !== "DATETIME") {
        throw new Error(`Expected ${table}.${name} to have DATETIME schema type`);
      }
    }
    inspected.set(table, expectedColumns);
  }
  return inspected;
}

function toIsoTimestamp(table, id, column, value) {
  const milliseconds = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid integer timestamp at ${table}.${column} for row ${id}`);
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime()) || date.getTime() !== milliseconds) {
    throw new Error(`Invalid integer timestamp at ${table}.${column} for row ${id}`);
  }
  return date.toISOString().replace("Z", "+00:00");
}

function readConversionPlans(db, schema) {
  const plans = [];
  let integerValueCount = 0;
  for (const [table, columns] of schema) {
    const selected = [quoteIdentifier("id")];
    for (const column of columns) {
      const quoted = quoteIdentifier(column);
      selected.push(`${quoted} AS ${quoted}`);
      selected.push(`typeof(${quoted}) AS ${quoteIdentifier(`__type_${column}`)}`);
    }
    const rows = db
      .prepare(`SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table)}`)
      .all();
    for (const row of rows) {
      const conversions = [];
      for (const column of columns) {
        const storageClass = row[`__type_${column}`];
        if (storageClass === "integer") {
          conversions.push({
            column,
            isoValue: toIsoTimestamp(table, row.id, column, row[column]),
          });
        } else if (storageClass !== "null" && storageClass !== "text") {
          throw new Error(
            `Unsupported ${storageClass} timestamp storage at ${table}.${column} for row ${row.id}`
          );
        }
      }
      if (conversions.length > 0) {
        integerValueCount += conversions.length;
        plans.push({ table, id: row.id, conversions });
      }
    }
  }
  return { plans, integerValueCount };
}

function countRemainingIntegers(db, schema) {
  let remaining = 0;
  for (const [table, columns] of schema) {
    for (const column of columns) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE typeof(${quoteIdentifier(column)}) = 'integer'`
        )
        .get();
      remaining += row.count;
    }
  }
  return remaining;
}

/**
 * Convert populated INTEGER epoch-millisecond DateTime values in the two
 * alert-state tables to Prisma's default ISO 8601 SQLite representation.  Dry-run is the default.  The caller owns the database connection.
 */
export function normalizeAlertTimestamps(db, { apply = false } = {}) {
  const schema = inspectDateColumns(db);
  const plan = () => readConversionPlans(db, schema);

  if (!apply) {
    const { plans, integerValueCount } = plan();
    return {
      mode: "dry-run",
      rowsWithIntegerDates: plans.length,
      valuesToConvert: integerValueCount,
      rowsUpdated: 0,
      valuesConverted: 0,
    };
  }

  const transaction = db.transaction(() => {
    // Reread and validate every candidate after acquiring the writer lock.
    const { plans, integerValueCount } = plan();
    const updateStatements = new Map();
    let valuesConverted = 0;
    const updatedRows = new Set();
    for (const row of plans) {
      for (const conversion of row.conversions) {
        const key = `${row.table}.${conversion.column}`;
        let statement = updateStatements.get(key);
        if (!statement) {
          statement = db.prepare(
            `UPDATE ${quoteIdentifier(row.table)}
             SET ${quoteIdentifier(conversion.column)} = ?
             WHERE ${quoteIdentifier("id")} = ?
               AND typeof(${quoteIdentifier(conversion.column)}) = 'integer'`
          );
          updateStatements.set(key, statement);
        }
        const result = statement.run(conversion.isoValue, row.id);
        if (result.changes !== 1) {
          throw new Error(
            `Timestamp changed during normalization at ${row.table}.${conversion.column} for row ${row.id}`
          );
        }
        valuesConverted += 1;
        updatedRows.add(`${row.table}\0${row.id}`);
      }
    }
    const remainingIntegerValues = countRemainingIntegers(db, schema);
    if (remainingIntegerValues !== 0) {
      throw new Error("Integer alert timestamps remain after normalization");
    }
    return {
      mode: "applied",
      rowsWithIntegerDates: plans.length,
      valuesToConvert: integerValueCount,
      rowsUpdated: updatedRows.size,
      valuesConverted,
    };
  });

  return transaction.immediate();
}

function parseArguments(argv) {
  let apply = false;
  let explicitDatabase;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) throw new Error("Duplicate --apply flag");
      apply = true;
    } else if (argument === "--database") {
      if (explicitDatabase || !argv[index + 1]) {
        throw new Error("--database requires one absolute path");
      }
      explicitDatabase = argv[index + 1];
      index += 1;
    } else {
      throw new Error("Usage: node scripts/normalize-alert-timestamps.mjs [--apply] [--database ABSOLUTE_PATH]");
    }
  }
  if (explicitDatabase && !isAbsolute(explicitDatabase)) {
    throw new Error("--database requires an absolute path");
  }
  return { apply, explicitDatabase };
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  const { apply, explicitDatabase } = parseArguments(argv);
  const databasePath = explicitDatabase
    ? explicitDatabase
    : parseSqliteDatabasePath(env.DATABASE_URL);
  const db = new Database(databasePath, {
    readonly: !apply,
    fileMustExist: true,
  });
  try {
    const result = normalizeAlertTimestamps(db, { apply });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Alert timestamp normalization failed"}\n`
    );
    process.exitCode = 1;
  }
}
