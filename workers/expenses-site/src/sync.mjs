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

// Kind preference when one receipt was posted twice under different kinds:
// keep the most canonical filing.  Purely a tiebreaker for display — the
// amounts are identical, so the total is the same either way.
const KIND_PREFERENCE = ["one_time", "prepaid", "subscription", "usage"];

/**
 * Fingerprint for "the same receipt": same vendor, amount, full timestamp and
 * label (labels carry the invoice/receipt number).  Two upstream rows sharing
 * a fingerprint are one charge posted twice under different idempotency keys
 * (the Sep 2026 bulk run filed several receipts under both `one_time` and
 * `usage`).  Fields are joined with NUL so adjacent values cannot bleed into
 * each other.  Pure — unit tested.
 */
export function expenseFingerprint(expense) {
  return [
    String(expense.vendor ?? "").toLowerCase(),
    Number(expense.amountUsd).toFixed(2),
    String(expense.occurredAt ?? ""),
    String(expense.label ?? "").toLowerCase(),
  ].join("");
}

/**
 * Collapse same-receipt double-posts.  Returns { kept, dropped }: the sync
 * upserts `kept` and deletes `dropped` keys from D1, so a loser row mirrored
 * before this deploy stops rendering instead of lingering next to the winner.
 * Deterministic winner: preferred kind first, then lowest idempotency key.
 * Pure — unit tested.
 */
export function dedupeUpstreamRows(expenses) {
  const winners = new Map();
  const dropped = [];
  const rank = (expense) => {
    const i = KIND_PREFERENCE.indexOf(expense.kind ?? "one_time");
    return i === -1 ? KIND_PREFERENCE.length : i;
  };
  for (const expense of expenses) {
    const fp = expenseFingerprint(expense);
    const current = winners.get(fp);
    if (!current) {
      winners.set(fp, expense);
      continue;
    }
    const expenseWins =
      rank(expense) < rank(current) ||
      (rank(expense) === rank(current) &&
        String(expense.idempotencyKey) < String(current.idempotencyKey));
    if (expenseWins) {
      dropped.push(current);
      winners.set(fp, expense);
    } else {
      dropped.push(expense);
    }
  }
  return { kept: [...winners.values()], dropped };
}

/**
 * Idempotency keys the dashboard must never render, even though they still
 * exist upstream (see suppressed_expenses in schema.sql).  Covers ledger rows
 * posted in error — double-posted receipts and superseded gross/discount or
 * correction rows — that were corrected at the display layer.
 */
export async function loadSuppressedKeys(db) {
  const result = await db
    .prepare("SELECT idempotency_key FROM suppressed_expenses")
    .all();
  return new Set((result.results ?? []).map((row) => row.idempotency_key));
}

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
  const suppressed = await loadSuppressedKeys(env.EXPENSES_DB);
  let cursor = null;
  let upserted = 0;
  let pages = 0;
  let suppressedCount = 0;
  let dedupedCount = 0;
  for (;;) {
    const data = await fetchUpstreamPage(upstreamUrl, token, cursor);
    const expenses = Array.isArray(data.expenses) ? data.expenses : [];
    if (expenses.length > 0) {
      const visible = expenses.filter((expense) => {
        if (suppressed.has(expense.idempotencyKey)) {
          suppressedCount += 1;
          return false;
        }
        return true;
      });
      const unique = dedupeUpstreamRows(visible);
      dedupedCount += unique.dropped.length;
      // Remove the losers from D1 too: a double-post mirrored before this
      // deploy would otherwise keep rendering next to the winner.
      for (const loser of unique.dropped) {
        await env.EXPENSES_DB.prepare(
          "DELETE FROM expenses WHERE idempotency_key = ?"
        )
          .bind(loser.idempotencyKey)
          .run();
      }
      const rows = unique.kept.map(mapUpstreamExpense);
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
  return { upserted, pages, syncedAt, suppressedCount, dedupedCount };
}
