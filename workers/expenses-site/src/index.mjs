/**
 * expenses.jays.services — business expense dashboard.
 *
 * Reads from the D1 mirror of Usage Monitor's owner-expense ledger (see
 * sync.mjs).  Financial data: this hostname sits behind Cloudflare Access
 * ("Jay emails only"), same as the other internal dashboards.
 *
 * Routes:
 *   GET  /              — dashboard HTML (last 6 months, rolling)
 *   GET  /api/expenses  — JSON: { expenses, asOf, totalCount }
 *   GET  /health        — deploy probe: { ok }, no financial data
 *   POST /api/sync      — manual sync trigger, the configured usage-read bearer, one per
 *                         minute (429 otherwise)
 *   scheduled (cron)    — syncExpenses every hour
 */
import { guardOff, guardOffResponse } from "./budget-guard.mjs";
import { syncExpenses } from "./sync.mjs";
import { formatAmount, formatDate, renderDashboard } from "./render.mjs";
import { CATEGORIES, sideForCategory } from "./categories.mjs";

const SIX_MONTHS_SQL = "date('now', '-6 months')";
// Side is derived from category (personal -> Personal, everything else ->
// Tech), so the SQL mirrors sideForCategory without a schema change.
const SIDE_SQL = "CASE WHEN category = 'personal' THEN 'personal' ELSE 'tech' END";

// Dashboard reads (up to 1000 rows per filter, plus a COUNT over the whole ledger) are
// shared by every caller for a short time, so a client that reloads in a loop costs one D1
// read per window per isolate instead of one per request.  The data is one ledger with no
// per-caller variation: the Worker does no identity checks, so nothing in the cache depends
// on who asked.  Isolates share no memory, so this bounds each isolate, not the account.
// /api/expenses accepts only a known filter (see isKnownFilter), so the cache holds at most
// 10 entries (one snapshot per known filter) and a query string cannot choose a new one.
// A failed read is not kept.
// /health is not cached: it reads no table rows, and a monitor should see D1 fail at once.
export const READ_CACHE_TTL_MS = 15_000;
const readCache = new Map();

export function resetReadCache() {
  readCache.clear();
}

function cachedRead(key, load, now = Date.now()) {
  const hit = readCache.get(key);
  if (hit && now - hit.at < READ_CACHE_TTL_MS) return hit.promise;
  const entry = { at: now, promise: load() };
  readCache.set(key, entry);
  // Concurrent callers share the in-flight promise; a rejection leaves no entry behind.
  entry.promise.catch(() => {
    if (readCache.get(key) === entry) readCache.delete(key);
  });
  return entry.promise;
}

// Every stored category comes from categorizeExpense, which returns a CATEGORIES slug
// (the column also defaults to 'other'), and the side filters are personal and tech.  Any
// other value matches no row, so it is refused instead of being sent to D1 as a full scan.
export function isKnownFilter(filter) {
  return filter === "all" || filter === "personal" || filter === "tech" || Object.hasOwn(CATEGORIES, filter);
}

// One entry per filter holds rows, footer time and total together, read in one go and
// expiring as one.  Separate entries expired on their own clocks, so a page could pair
// rows from one read with the footer or count of another (and could be built from a
// mix of reads on either side of a sync).  Entries still cost 3 D1 statements per window
// and filter.  Reads inside one load are three statements, not one transaction, so the
// parts can differ if a sync commits between them, exactly as before the cache.
function dashboardData(db, filter) {
  return cachedRead("snapshot:" + filter, () =>
    Promise.all([readDashboardRows(db, filter), readSyncState(db), readTotalCount(db)])
  );
}

async function readDashboardRows(db, filter) {
  let where = "WHERE occurred_at >= " + SIX_MONTHS_SQL;
  let params = [];
  if (filter === "personal" || filter === "tech") {
    where += " AND " + SIDE_SQL + " = ?";
    params = [filter];
  } else if (filter && filter !== "all") {
    where += " AND category = ?";
    params = [filter];
  }
  const stmt = db.prepare(
    `SELECT idempotency_key, vendor, amount_usd, occurred_at, kind,
            label, notes, confidence, category, calendar_sort
     FROM expenses ${where} ORDER BY occurred_at DESC LIMIT 1000`
  );
  const result = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();
  return result.results ?? [];
}

async function readSyncState(db) {
  const row = await db
    .prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'")
    .first();
  return row ? row.value : "never";
}

async function readTotalCount(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM expenses").first();
  return row ? row.n : 0;
}

// Fixed text from the sync or the guard is safe to log.  Anything else logs its name
// only, because a raw error can carry upstream or D1 content into the Worker's logs.
const FIXED_TEXT_ERRORS = new Set(["SyncFailure", "BudgetExceeded"]);

function logFailure(event, error) {
  const reason = FIXED_TEXT_ERRORS.has(error?.name) ? error.message : (error?.name ?? "unknown");
  console.error(JSON.stringify({ event, reason }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorizedSync(request, env) {
  const expected = (env.USAGE_READ_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  return bearer.length > 0 && timingSafeEqual(bearer, expected);
}

export default {
  async fetch(request, env) {
    if (guardOff(env)) return guardOffResponse();
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      try {
        await env.EXPENSES_DB.prepare("SELECT 1").first();
        return json({ ok: true });
      } catch (error) {
        logFailure("expenses.health_check_failed", error);
        return json({ ok: false }, 503);
      }
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      if (!authorizedSync(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      try {
        const result = await syncExpenses(env, { manual: true });
        if (!result.cooldown) resetReadCache();
        if (result.cooldown) {
          const response = json({ ok: false, error: "Sync cooldown" }, 429);
          response.headers.set("retry-after", String(result.retryAfterSeconds));
          return response;
        }
        return json({ ok: true, ...result });
      } catch (error) {
        // Never leak upstream/D1 error detail to the caller or the logs.
        logFailure("expenses.manual_sync_failed", error);
        return json({ ok: false, error: "Sync failed" }, 502);
      }
    }

    if (url.pathname === "/api/expenses") {
      const category = url.searchParams.get("category") || "all";
      if (!isKnownFilter(category)) {
        return json({ error: "Unknown category", categories: ["all", "personal", "tech", ...Object.keys(CATEGORIES)] }, 400);
      }
      const [expenses, asOf, totalCount] = await dashboardData(env.EXPENSES_DB, category);
      return json({
        expenses: expenses.map((e) => ({
          id: e.idempotency_key,
          vendor: e.vendor,
          amountUsd: e.amount_usd,
          date: formatDate(e.occurred_at),
          occurredAt: e.occurred_at,
          kind: e.kind,
          label: e.label,
          category: e.category,
          side: sideForCategory(e.category),
        })),
        asOf,
        totalCount,
        totalUsd: expenses.reduce((s, e) => s + Number(e.amount_usd || 0), 0),
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const [expenses, asOf, totalCount] = await dashboardData(env.EXPENSES_DB, "all");
      return new Response(renderDashboard(expenses, asOf, totalCount), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env) {
    if (guardOff(env)) return;
    // The next hourly run is the retry; a retried failure would only spend more.
    controller.noRetry?.();
    try {
      await syncExpenses(env);
      resetReadCache();
    } catch (error) {
      // Re-thrown so the invocation counts as failed: a swallowed error hid the
      // sync failures and the empty-ledger gap of Oct 26 to Nov 3 from analytics.
      logFailure("expenses.scheduled_sync_failed", error);
      throw error;
    }
  },
};

// Re-exported for unit tests.
export { formatAmount, formatDate };
