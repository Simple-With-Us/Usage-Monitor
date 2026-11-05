/**
 * Syncs owner-recorded expenses from Usage Monitor into D1.
 *
 * The upstream ledger stays the system of record; D1 is a read cache shaped
 * for the dashboard (plus a stored category per row so a future edit UI can
 * override it without a migration).  Sync is idempotent: rows upsert on the
 * upstream idempotency key, so re-runs never duplicate.
 *
 * Write budget, as sync.workers.test.mjs pins it on local D1 with this schema: the
 * upsert below costs 3 rows written to insert a row, 2 to change one (it sets the
 * indexed occurred_at), and 0 when no field differs.  Live D1 still has a second index
 * until the migration runs, so each costs one more there.  Rewriting the whole ledger
 * every run measured 3,076 rows an hour live, 74% of the Free plan's daily cap.  So a run
 * writes nothing but its state when the upstream text is unchanged, and otherwise only
 * the rows that differ.  Every guard below is checked before the write it protects.
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

// What a run reserves for one upsert or delete: the most live D1 measured, an insert
// with both indexes.
export const MAX_ROWS_PER_STATEMENT = 4;
// A successful run's final state write: last_sync_at, the hash, the category basis
// and the counter.
export const STATE_WRITE_ROWS = 4;
// A manual run's cooldown claim and the counter update in the same batch.
const CLAIM_WRITE_ROWS = 2;

const UPSTREAM_HASH_KEY = "upstream_hash";
const CATEGORY_BASIS_KEY = "category_basis";
const ROWS_WRITTEN_KEY = "rows_written_today";
const MANUAL_SYNC_KEY = "manual_sync_at";

// Bump when mapUpstreamExpense, dedupeUpstreamRows or the logic of categorizeExpense
// (not its rules, which are hashed) changes what is stored, so the next run compares
// every row even though the upstream text is the same.
const SYNC_SHAPE_VERSION = "1";
// Every stored field but category, the one that costs CPU (about 80 rules per row).
const PLAIN_FIELDS = [
  "vendor",
  "amount_usd",
  "occurred_at",
  "kind",
  "label",
  "notes",
  "confidence",
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
 * A failure whose message is fixed text written here, with no upstream or D1 content
 * in it, so the Worker's handlers may log it.  See logFailure in index.mjs.
 */
export class SyncFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncFailure";
  }
}

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

function plainRow(expense) {
  return {
    idempotency_key: expense.idempotencyKey,
    vendor: expense.vendor,
    amount_usd: expense.amountUsd,
    occurred_at: expense.occurredAt,
    kind: expense.kind ?? "one_time",
    label: expense.label ?? null,
    notes: expense.notes ?? null,
    confidence: expense.confidence ?? "actual",
    calendar_sort: expense.calendarSort ?? null,
  };
}

/** Map one upstream expense object to a D1 row. Pure — unit tested. */
export function mapUpstreamExpense(expense) {
  return { ...plainRow(expense), category: categorizeExpense(expense.vendor, expense.label) };
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

/**
 * The upstream expenses that differ from the mirror.  Categorizes only when the rules
 * changed since the mirror was written and every other field matches: at the row
 * ceiling, categorizing the whole ledger on a cold isolate took a third of the 100 ms
 * CPU limit.  Pure — unit tested.
 */
export function changedExpenses(expenses, mirror, { recategorize = true } = {}) {
  return expenses.filter((expense) => {
    const stored = mirror.get(expense.idempotencyKey);
    if (!stored) return true;
    const row = plainRow(expense);
    if (PLAIN_FIELDS.some((field) => stored[field] !== row[field])) return true;
    return recategorize && stored.category !== categorizeExpense(expense.vendor, expense.label);
  });
}

const isOptionalText = (value) => value === undefined || value === null || typeof value === "string";

// The name of the first field the sync could not use, or null.
function badExpenseField(expense) {
  if (expense === null || typeof expense !== "object") return "row";
  if (typeof expense.idempotencyKey !== "string" || expense.idempotencyKey === "") {
    return "idempotencyKey";
  }
  if (typeof expense.vendor !== "string") return "vendor";
  if (!Number.isFinite(expense.amountUsd)) return "amountUsd";
  if (typeof expense.occurredAt !== "string" || Number.isNaN(Date.parse(expense.occurredAt))) {
    return "occurredAt";
  }
  for (const field of ["kind", "label", "notes", "confidence", "calendarSort"]) {
    if (!isOptionalText(expense[field])) return field;
  }
  return null;
}

/**
 * The page contract of GET /api/owner-expenses, checked in full before any of it is
 * used, so one bad row fails the run with nothing written.  Plain checks rather than
 * a schema library, because this Worker has no dependencies and a 100 ms CPU limit.
 * Messages name a position and a field, never a value.  Pure — unit tested.
 */
export function parseUpstreamPage(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // The parser's own message quotes the body.
    throw new SyncFailure("upstream answered with invalid JSON");
  }
  if (data === null || typeof data !== "object" || !Array.isArray(data.expenses)) {
    throw new SyncFailure("upstream response has no expenses list");
  }
  if (typeof data.hasMore !== "boolean") {
    throw new SyncFailure("upstream response has no hasMore flag");
  }
  if (data.nextCursor !== null && typeof data.nextCursor !== "string") {
    throw new SyncFailure("upstream response has a bad nextCursor");
  }
  data.expenses.forEach((expense, index) => {
    const field = badExpenseField(expense);
    if (field) throw new SyncFailure(`upstream expense ${index} has a bad ${field}`);
  });
  return { expenses: data.expenses, hasMore: data.hasMore, nextCursor: data.nextCursor };
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
    throw new SyncFailure(`upstream ${response.status} from ${url.pathname}`);
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
       WHERE key IN ('${UPSTREAM_HASH_KEY}', '${ROWS_WRITTEN_KEY}', '${CATEGORY_BASIS_KEY}')`
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
 * Adds to the day's counter inside SQL, so overlapping runs add up instead of each
 * writing a total from its own stale read.  rows may be negative when a run settles a
 * reservation.  With claimedAt, it adds only if that manual claim is the stored one,
 * so a refused claim in the same batch writes nothing (a refusal in the very same
 * millisecond as the claim counts 2 rows too many, which is harmless).  A stored value
 * from a later day is left alone; one that does not parse is too, and still fails
 * closed on read.
 * D1 binds a JS number as REAL, hence the casts: 5.0 would not parse.
 */
function addToCounterStatement(db, today, rows, claimedAt = null) {
  return db
    .prepare(
      `INSERT INTO sync_state (key, value)
       SELECT '${ROWS_WRITTEN_KEY}', ?1 || ':' || MAX(0, CAST(?2 AS INTEGER))
       WHERE ?3 IS NULL OR (SELECT value FROM sync_state WHERE key = '${MANUAL_SYNC_KEY}') = ?3
       ON CONFLICT(key) DO UPDATE SET value = CASE
         WHEN substr(sync_state.value, 1, 10) = ?1
         THEN ?1 || ':' || MAX(0, CAST(substr(sync_state.value, 12) AS INTEGER) + CAST(?2 AS INTEGER))
         ELSE excluded.value
       END
       WHERE substr(sync_state.value, 1, 10) <= ?1`
    )
    .bind(today, rows, claimedAt);
}

/**
 * Takes the manual-sync slot atomically, so parallel callers cannot both pass, and
 * counts the claim in the same batch, so a run that fails later still has it counted.
 * A failed sync keeps the slot too: a caller retrying on errors is cooled as well.
 */
async function claimManualSync(db, now, today) {
  const claimedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - MANUAL_SYNC_COOLDOWN_MS).toISOString();
  return db.batch([
    db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES ('${MANUAL_SYNC_KEY}', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE sync_state.value <= ?`
      )
      .bind(claimedAt, cutoff),
    addToCounterStatement(db, today, CLAIM_WRITE_ROWS, claimedAt),
  ]);
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
    // Only a hash miss gets here: a match is text that passed these checks when it was
    // stored, and skipping them is most of why an unchanged run costs so little CPU.
    const data = parseUpstreamPage(texts[texts.length - 1]);
    expenses.push(...data.expenses);
    if (expenses.length > MAX_UPSTREAM_ROWS) {
      throw new SyncFailure(`upstream returned over ${MAX_UPSTREAM_ROWS} rows`);
    }
    if (!data.hasMore) break;
    // Ending here would record a partial ledger as a full sync.
    if (!data.nextCursor) throw new SyncFailure("upstream hasMore without a cursor");
    if (seenCursors.has(data.nextCursor)) throw new SyncFailure("upstream repeated a cursor");
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
    throw new SyncFailure("UPSTREAM_URL and USAGE_READ_TOKEN must be configured");
  }
  const db = env.EXPENSES_DB;
  const now = new Date();
  const syncedAt = now.toISOString();
  const today = syncedAt.slice(0, 10);
  const run = budget.invocation();
  const written = () => run.used().d1RowsWritten ?? 0;
  // What this run has added to the stored counter so far.
  let counted = 0;

  const state = await readSyncState(db);
  const spentBefore = rowsWrittenToday(state.get(ROWS_WRITTEN_KEY), today);
  const requireRoom = (rows) => {
    if (spentBefore + written() + rows > DAILY_ROWS_WRITTEN_BUDGET) {
      throw dailyBudgetExceeded();
    }
  };
  // Saves the state of this run, and settles the counter to what the run really wrote,
  // including this very write.
  const saveState = async (entries = []) => {
    const statements = entries.map(([key, value]) => setStateStatement(db, key, value));
    const total = written() + statements.length + 1;
    statements.push(addToCounterStatement(db, today, total - counted));
    recordD1(run, await db.batch(statements));
  };

  requireRoom(STATE_WRITE_ROWS + (manual ? CLAIM_WRITE_ROWS : 0));
  if (manual) {
    const claim = await claimManualSync(db, now, today);
    if ((claim[0]?.meta?.changes ?? 0) === 0) {
      return { cooldown: true, retryAfterSeconds: MANUAL_SYNC_COOLDOWN_MS / 1000 };
    }
    recordD1(run, claim);
    counted += CLAIM_WRITE_ROWS;
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
    .prepare(`SELECT idempotency_key, category, ${PLAIN_FIELDS.join(", ")} FROM expenses`)
    .all();
  const mirror = new Map((stored.results ?? []).map((row) => [row.idempotency_key, row]));
  const staleKeys = [...mirror.keys()].filter((key) => suppressed.has(key));
  // An empty answer over a full mirror looks the same whether upstream is broken (eight
  // days of this went unnoticed from Oct 26) or the ledger was really emptied, so nothing
  // here can trust it.  Keep the footer's age true and fail loudly until someone who
  // knows clears the mirror; the README has the command, and the next run then finishes.
  if (visible.length === 0 && mirror.size > staleKeys.length) {
    throw new SyncFailure("upstream returned no rows but the mirror has rows");
  }

  const unique = dedupeUpstreamRows(visible);
  // What the stored categories were computed under, hashed because the rules are long.
  // A rule edit changes it by itself.  While it matches, a category cannot have changed
  // unless the vendor or label did.
  const basis = await sha256Hex([SYNC_SHAPE_VERSION, CATEGORY_RULES_VERSION]);
  const basisChanged = state.get(CATEGORY_BASIS_KEY) !== basis;
  const changed = changedExpenses(unique, mirror, { recategorize: basisChanged });
  const toWrite = changed.slice(0, MAX_CHANGED_ROWS_PER_RUN).map(mapUpstreamExpense);
  const capped = toWrite.length < changed.length;

  if (staleKeys.length > 0 || toWrite.length > 0) {
    // Reserved first: a run killed mid-write still counts against the day.
    const clearHash = state.has(UPSTREAM_HASH_KEY) ? 1 : 0;
    const reserved =
      (staleKeys.length + toWrite.length) * MAX_ROWS_PER_STATEMENT + STATE_WRITE_ROWS + clearHash;
    requireRoom(reserved + 1);
    recordD1(run, await addToCounterStatement(db, today, reserved + 1).run());
    counted += reserved + 1;
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
    throw new SyncFailure(
      `changed rows over ${MAX_CHANGED_ROWS_PER_RUN}: wrote ${toWrite.length} of ${changed.length}`
    );
  }
  // The hash is stored only now: stored earlier, a killed run would make every
  // later run skip the rows it never wrote.
  await saveState([
    ["last_sync_at", syncedAt],
    [UPSTREAM_HASH_KEY, upstream.hash],
    ...(basisChanged ? [[CATEGORY_BASIS_KEY, basis]] : []),
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
