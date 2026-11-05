/**
 * Syncs owner-recorded expenses from Usage Monitor into D1.
 *
 * The upstream ledger stays the system of record; D1 is a read cache shaped
 * for the dashboard (plus a stored category per row so a future edit UI can
 * override it without a migration).  Sync is idempotent: rows upsert on the
 * upstream idempotency key, so re-runs never duplicate.
 *
 * Write budget: each stored row costs 3-4 rows written (table plus indexes), and
 * rewriting the whole ledger every run took this one Worker to 74% of the free
 * daily cap.  So a run writes nothing but its state when the upstream text is
 * unchanged, and otherwise only the rows that differ.  Every guard below is
 * checked before the write it protects.
 */
import { BudgetExceeded, createBudget, recordD1 } from "./budget-guard.mjs";
import { categorizeExpense, CATEGORY_RULES_VERSION } from "./categories.mjs";

const WORKER_NAME = "expenses-jays-services";
const UPSTREAM_PAGE_LIMIT = 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;
// D1 batch writes stay small even if the ledger grows: one prepared statement
// per row, flushed in chunks.
const BATCH_CHUNK_SIZE = 100;

export const MAX_PAGES = 3;
export const MAX_UPSTREAM_ROWS = 5000;
export const MAX_CHANGED_ROWS_PER_RUN = 300;
export const DAILY_ROWS_WRITTEN_BUDGET = 5000;
export const MANUAL_SYNC_COOLDOWN_MS = 60_000;

// Worst case for one upsert or delete: an insert writes the table, its primary
// key index and each secondary index.
const MAX_ROWS_PER_STATEMENT = 4;
// A successful run's final state write: last_sync_at, the hash and the counter.
const STATE_WRITE_ROWS = 3;

const UPSTREAM_HASH_KEY = "upstream_hash";
const ROWS_WRITTEN_KEY = "rows_written_today";
const MANUAL_SYNC_KEY = "manual_sync_at";

// Bump when mapUpstreamExpense, dedupeUpstreamRows or the logic of categorizeExpense
// (not its rules, which are hashed) changes what is stored, so the next run compares
// every row even though the upstream text is the same.
const SYNC_SHAPE_VERSION = "1";

const COMPARED_FIELDS = [
  "vendor",
  "amount_usd",
  "occurred_at",
  "kind",
  "label",
  "notes",
  "confidence",
  "category",
  "calendar_sort",
];

// Isolates share no memory, so there is no per-minute cap here: the atomic manual
// cooldown and the daily counter in sync_state are what hold across isolates.
const budget = createBudget({
  worker: WORKER_NAME,
  perInvocation: {
    upstreamFetch: MAX_PAGES,
    d1RowsWritten: MAX_CHANGED_ROWS_PER_RUN * MAX_ROWS_PER_STATEMENT + 300,
  },
});

// Kind preference when one receipt was posted twice under different kinds:
// keep the most canonical filing.  Purely a tiebreaker for display — the
// amounts are identical, so the total is the same either way.
const KIND_PREFERENCE = ["one_time", "prepaid", "subscription", "usage"];

/**
 * Fingerprint for "the same receipt": same vendor, amount, calendar day and
 * label (labels carry the invoice/receipt number).  Two upstream rows sharing
 * a fingerprint are one charge posted twice under different idempotency keys
 * (the Sep 2026 bulk run filed several receipts under both `one_time` and
 * `usage`).  Pure — unit tested.
 */
export function expenseFingerprint(expense) {
  const day = String(expense.occurredAt ?? "").slice(0, 10);
  return [
    String(expense.vendor ?? "").toLowerCase(),
    Number(expense.amountUsd).toFixed(2),
    day,
    String(expense.label ?? "").toLowerCase(),
  ].join("");
}

/** Collapse same-receipt double-posts to a single row.  Pure — unit tested. */
export function dedupeUpstreamRows(expenses) {
  const winners = new Map();
  const rank = (expense) => {
    const i = KIND_PREFERENCE.indexOf(expense.kind ?? "one_time");
    return i === -1 ? KIND_PREFERENCE.length : i;
  };
  for (const expense of expenses) {
    const fp = expenseFingerprint(expense);
    const current = winners.get(fp);
    if (
      !current ||
      rank(expense) < rank(current) ||
      (rank(expense) === rank(current) &&
        String(expense.idempotencyKey) < String(current.idempotencyKey))
    ) {
      winners.set(fp, expense);
    }
  }
  return [...winners.values()];
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
           calendar_sort = excluded.calendar_sort
         WHERE vendor IS NOT excluded.vendor
            OR amount_usd IS NOT excluded.amount_usd
            OR occurred_at IS NOT excluded.occurred_at
            OR kind IS NOT excluded.kind
            OR label IS NOT excluded.label
            OR notes IS NOT excluded.notes
            OR confidence IS NOT excluded.confidence
            OR category IS NOT excluded.category
            OR calendar_sort IS NOT excluded.calendar_sort`
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

/** The mapped rows that differ from the mirror.  Pure — unit tested. */
export function changedRows(rows, mirror) {
  return rows.filter((row) => {
    const stored = mirror.get(row.idempotency_key);
    return !stored || COMPARED_FIELDS.some((field) => stored[field] !== row[field]);
  });
}

async function fetchUpstreamPage(upstreamUrl, token, cursor) {
  const url = new URL("/api/owner-expenses", upstreamUrl);
  url.searchParams.set("limit", String(UPSTREAM_PAGE_LIMIT));
  url.searchParams.set("order", "asc");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`upstream ${response.status} from ${url.pathname}`);
  }
  return response.text();
}

async function sha256Hex(parts) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\0"))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readSyncState(db) {
  const result = await db
    .prepare(
      `SELECT key, value FROM sync_state
       WHERE key IN ('${UPSTREAM_HASH_KEY}', '${ROWS_WRITTEN_KEY}')`
    )
    .all();
  return new Map((result.results ?? []).map((row) => [row.key, row.value]));
}

/** Rows written so far this UTC day.  An unreadable value fails closed. */
export function rowsWrittenToday(value, today) {
  if (value === undefined) return 0;
  const match = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(value);
  if (!match) throw dailyBudgetExceeded();
  return match[1] === today ? Number(match[2]) : 0;
}

function dailyBudgetExceeded() {
  console.warn(
    JSON.stringify({
      event: "budget_exceeded",
      worker: WORKER_NAME,
      kind: "d1RowsWritten",
      scope: "utc-day",
      cap: DAILY_ROWS_WRITTEN_BUDGET,
    })
  );
  return new BudgetExceeded("d1RowsWritten", "utc-day", DAILY_ROWS_WRITTEN_BUDGET);
}

function setStateStatement(db, key, value) {
  return db
    .prepare(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, value);
}

/**
 * Takes the manual-sync slot atomically, so parallel callers cannot both pass.
 * A failed sync keeps the slot too: a caller retrying on errors is cooled as well.
 */
async function claimManualSync(db, now) {
  const cutoff = new Date(now.getTime() - MANUAL_SYNC_COOLDOWN_MS).toISOString();
  return db
    .prepare(
      `INSERT INTO sync_state (key, value) VALUES ('${MANUAL_SYNC_KEY}', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE sync_state.value <= ?`
    )
    .bind(now.toISOString(), cutoff)
    .run();
}

/**
 * Reads the whole ledger before anything is written, so a pagination fault
 * costs subrequests and no rows.  Returns early as soon as the hash matches.
 */
async function readUpstream(env, run, hashPrefix, storedHash) {
  const texts = [];
  const expenses = [];
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    run.spend("upstreamFetch");
    texts.push(await fetchUpstreamPage(env.UPSTREAM_URL, env.USAGE_READ_TOKEN, cursor));
    // A one-page match proves the whole ledger is unchanged: a stored hash that
    // covers several pages can never equal the hash of its first page alone.
    if (texts.length === 1) {
      const hash = await sha256Hex([...hashPrefix, texts[0]]);
      if (hash === storedHash) return { unchanged: true, pages: 1, hash };
    }
    const data = JSON.parse(texts[texts.length - 1]);
    if (!Array.isArray(data.expenses)) {
      throw new Error("upstream response has no expenses list");
    }
    expenses.push(...data.expenses);
    if (expenses.length > MAX_UPSTREAM_ROWS) {
      throw new Error(`upstream returned over ${MAX_UPSTREAM_ROWS} rows`);
    }
    if (!data.hasMore) break;
    // Ending here would record a partial ledger as a full sync.
    if (!data.nextCursor) throw new Error("upstream hasMore without a cursor");
    if (seenCursors.has(data.nextCursor)) throw new Error("upstream repeated a cursor");
    seenCursors.add(data.nextCursor);
    cursor = data.nextCursor;
  }
  const hash = await sha256Hex([...hashPrefix, ...texts]);
  return { unchanged: hash === storedHash, pages: texts.length, hash, expenses };
}

/**
 * Run one full sync.  Returns { upserted, pages, unchanged, ... }, or
 * { cooldown, retryAfterSeconds } for a manual run inside the cooldown.
 * Throws on upstream or D1 failure and on every guard; the scheduled handler
 * rethrows, so a failed run shows as failed in analytics.
 *
 * last_sync_at advances only when the mirror really matches upstream, so the
 * dashboard footer shows the true age of the data.
 */
export async function syncExpenses(env, { manual = false } = {}) {
  if (!env.UPSTREAM_URL || !env.USAGE_READ_TOKEN) {
    throw new Error("UPSTREAM_URL and USAGE_READ_TOKEN must be configured");
  }
  const db = env.EXPENSES_DB;
  const now = new Date();
  const syncedAt = now.toISOString();
  const today = syncedAt.slice(0, 10);
  const run = budget.invocation();
  const written = () => run.used().d1RowsWritten ?? 0;

  const state = await readSyncState(db);
  const spentBefore = rowsWrittenToday(state.get(ROWS_WRITTEN_KEY), today);
  const requireRoom = (rows) => {
    if (spentBefore + written() + rows > DAILY_ROWS_WRITTEN_BUDGET) {
      throw dailyBudgetExceeded();
    }
  };
  // Saves the state of this run, and counts the rows that very write costs.
  const saveState = async (entries = []) => {
    const statements = entries.map(([key, value]) => setStateStatement(db, key, value));
    const total = spentBefore + written() + statements.length + 1;
    statements.push(setStateStatement(db, ROWS_WRITTEN_KEY, `${today}:${total}`));
    recordD1(run, await db.batch(statements));
  };

  requireRoom(STATE_WRITE_ROWS);
  if (manual) {
    const claim = await claimManualSync(db, now);
    if ((claim?.meta?.changes ?? 0) === 0) {
      return { cooldown: true, retryAfterSeconds: MANUAL_SYNC_COOLDOWN_MS / 1000 };
    }
    recordD1(run, claim);
  }

  const suppressed = await loadSuppressedKeys(db);
  const hashPrefix = [SYNC_SHAPE_VERSION, CATEGORY_RULES_VERSION, ...[...suppressed].sort()];
  const upstream = await readUpstream(env, run, hashPrefix, state.get(UPSTREAM_HASH_KEY));
  if (upstream.unchanged) {
    requireRoom(STATE_WRITE_ROWS);
    await saveState([["last_sync_at", syncedAt]]);
    return {
      upserted: 0,
      pages: upstream.pages,
      syncedAt,
      suppressedCount: 0,
      dedupedCount: 0,
      unchanged: true,
    };
  }

  const visible = upstream.expenses.filter((expense) => !suppressed.has(expense.idempotencyKey));
  const stored = await db
    .prepare(`SELECT idempotency_key, ${COMPARED_FIELDS.join(", ")} FROM expenses`)
    .all();
  const mirror = new Map((stored.results ?? []).map((row) => [row.idempotency_key, row]));
  const staleKeys = [...mirror.keys()].filter((key) => suppressed.has(key));
  // An empty answer over a full mirror means upstream is wrong (eight days of
  // this went unnoticed from Oct 26).  Keep the footer's age true and fail loudly.
  if (visible.length === 0 && mirror.size > staleKeys.length) {
    throw new Error("upstream returned no rows but the mirror has rows");
  }

  const unique = dedupeUpstreamRows(visible);
  const changed = changedRows(unique.map(mapUpstreamExpense), mirror);
  const toWrite = changed.slice(0, MAX_CHANGED_ROWS_PER_RUN);
  const capped = toWrite.length < changed.length;

  if (staleKeys.length > 0 || toWrite.length > 0) {
    // Reserved first: a run killed mid-write still counts against the day.
    const clearHash = state.has(UPSTREAM_HASH_KEY) ? 1 : 0;
    const reserved =
      (staleKeys.length + toWrite.length) * MAX_ROWS_PER_STATEMENT + STATE_WRITE_ROWS + clearHash;
    requireRoom(reserved + 1);
    const reservation = await setStateStatement(
      db,
      ROWS_WRITTEN_KEY,
      `${today}:${spentBefore + written() + reserved + 1}`
    ).run();
    recordD1(run, reservation);
    // The mirror stops matching the stored hash from here until the run finishes.
    // Left in place, a run that stops part way and an upstream that then goes back
    // to the old text would skip the sync over a half-written mirror.
    if (clearHash) {
      recordD1(
        run,
        await db.prepare("DELETE FROM sync_state WHERE key = ?").bind(UPSTREAM_HASH_KEY).run()
      );
    }
  } else {
    requireRoom(STATE_WRITE_ROWS);
  }

  if (staleKeys.length > 0) {
    // Rows written before they were suppressed would otherwise linger.
    run.check("d1RowsWritten");
    recordD1(
      run,
      await db
        .prepare(
          "DELETE FROM expenses WHERE idempotency_key IN (SELECT idempotency_key FROM suppressed_expenses)"
        )
        .run()
    );
  }
  const statements = buildUpsertStatements(db, toWrite, syncedAt);
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    run.check("d1RowsWritten");
    recordD1(run, await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE)));
  }

  if (capped) {
    // The rows just written match on the next run, which takes the next slice.
    await saveState();
    throw new Error(
      `changed rows over ${MAX_CHANGED_ROWS_PER_RUN}: wrote ${toWrite.length} of ${changed.length}`
    );
  }
  // The hash is stored only now: stored earlier, a killed run would make every
  // later run skip the rows it never wrote.
  await saveState([
    ["last_sync_at", syncedAt],
    [UPSTREAM_HASH_KEY, upstream.hash],
  ]);
  return {
    upserted: toWrite.length,
    pages: upstream.pages,
    syncedAt,
    suppressedCount: upstream.expenses.length - visible.length,
    dedupedCount: visible.length - unique.length,
    unchanged: false,
  };
}
