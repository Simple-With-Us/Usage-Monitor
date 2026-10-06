/**
 * Syncs owner-recorded expenses from Usage Monitor into D1.
 *
 * The upstream ledger stays the system of record; D1 is a read cache shaped
 * for the dashboard (plus a stored category per row so a future edit UI can
 * override it without a migration).  Sync is idempotent: rows upsert on the
 * upstream idempotency key, so re-runs never duplicate.
 *
 * Free-tier budget: the ledger holds dozens of rows.  Each sync is one
 * paginated upstream read plus one D1 batch write — far under D1's free
 * limits (5M row reads/day, 100K writes/day).
 */
import { categorizeExpense } from "./categories.mjs";

const UPSTREAM_PAGE_LIMIT = 1000;
// D1 batch writes stay small even if the ledger grows: one prepared statement
// per row, flushed in chunks.
const BATCH_CHUNK_SIZE = 100;

/** Map one upstream expense object to a D1 row. Pure — unit tested. */
export function mapUpstreamExpense(expense) {
  return {
    idempotency_key: expense.idempotencyKey,
    vendor: expense.vendor,
    amount_usd: expense.amountUsd,
    occurred_at: expense.occurredAt,
    kind: expense.kind ?? "one_time",
    label: expense.label ?? null,
    notes: expense.notes ?? null,
    confidence: expense.confidence ?? "actual",
    category: categorizeExpense(expense.vendor, expense.label),
    calendar_sort: expense.calendarSort ?? null,
  };
}

/** Build the D1 upsert statements for a page of mapped rows. */
export function buildUpsertStatements(db, rows, syncedAt) {
  return rows.map((row) =>
    db
      .prepare(
        `INSERT INTO expenses
           (idempotency_key, vendor, amount_usd, occurred_at, kind, label,
            notes, confidence, category, calendar_sort, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           vendor = excluded.vendor,
           amount_usd = excluded.amount_usd,
           occurred_at = excluded.occurred_at,
           kind = excluded.kind,
           label = excluded.label,
           notes = excluded.notes,
           confidence = excluded.confidence,
           category = excluded.category,
           calendar_sort = excluded.calendar_sort,
           synced_at = excluded.synced_at`
      )
      .bind(
        row.idempotency_key,
        row.vendor,
        row.amount_usd,
        row.occurred_at,
        row.kind,
        row.label,
        row.notes,
        row.confidence,
        row.category,
        row.calendar_sort,
        syncedAt
      )
  );
}

async function fetchUpstreamPage(upstreamUrl, token, cursor) {
  const url = new URL("/api/owner-expenses", upstreamUrl);
  url.searchParams.set("limit", String(UPSTREAM_PAGE_LIMIT));
  url.searchParams.set("order", "asc");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`upstream ${response.status} from ${url.pathname}`);
  }
  return response.json();
}

/**
 * Run one full sync.  Returns { upserted, pages }.
 * Throws on upstream or D1 failure so the cron retry/alarms fire.
 */
export async function syncExpenses(env) {
  const upstreamUrl = env.UPSTREAM_URL;
  const token = env.USAGE_READ_TOKEN;
  if (!upstreamUrl || !token) {
    throw new Error("UPSTREAM_URL and USAGE_READ_TOKEN must be configured");
  }
  const syncedAt = new Date().toISOString();
  let cursor = null;
  let upserted = 0;
  let pages = 0;
  for (;;) {
    const data = await fetchUpstreamPage(upstreamUrl, token, cursor);
    const expenses = Array.isArray(data.expenses) ? data.expenses : [];
    if (expenses.length > 0) {
      const rows = expenses.map(mapUpstreamExpense);
      const statements = buildUpsertStatements(env.EXPENSES_DB, rows, syncedAt);
      for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
        await env.EXPENSES_DB.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
      }
      upserted += rows.length;
    }
    pages += 1;
    cursor = data.hasMore ? data.nextCursor : null;
    if (!cursor) break;
    if (pages > 50) throw new Error("sync page guard tripped");
  }
  await env.EXPENSES_DB.prepare(
    `INSERT INTO sync_state (key, value) VALUES ('last_sync_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(syncedAt)
    .run();
  return { upserted, pages, syncedAt };
}
