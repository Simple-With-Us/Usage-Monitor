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
 *   POST /api/sync      — manual sync trigger, Bearer USAGE_READ_TOKEN
 *   scheduled (cron)    — syncExpenses every 15 minutes
 */
import { syncExpenses } from "./sync.mjs";
import { formatAmount, formatDate, renderDashboard } from "./render.mjs";

const SIX_MONTHS_SQL = "date('now', '-6 months')";

async function readDashboardRows(db, category) {
  const where =
    category && category !== "all"
      ? "WHERE occurred_at >= " + SIX_MONTHS_SQL + " AND category = ?"
      : "WHERE occurred_at >= " + SIX_MONTHS_SQL;
  const stmt =
    category && category !== "all"
      ? db.prepare(
          `SELECT idempotency_key, vendor, amount_usd, occurred_at, kind,
                  label, notes, confidence, category, calendar_sort
           FROM expenses ${where} ORDER BY occurred_at DESC LIMIT 1000`
        ).bind(category)
      : db.prepare(
          `SELECT idempotency_key, vendor, amount_usd, occurred_at, kind,
                  label, notes, confidence, category, calendar_sort
           FROM expenses ${where} ORDER BY occurred_at DESC LIMIT 1000`
        );
  const result = await stmt.all();
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorizedSync(request, env) {
  const expected = (env.USAGE_READ_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  return bearer.length > 0 && bearer === expected;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/sync" && request.method === "POST") {
      if (!authorizedSync(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      try {
        const result = await syncExpenses(env);
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ ok: false, error: String(error && error.message || error) }, 502);
      }
    }

    if (url.pathname === "/api/expenses") {
      const category = url.searchParams.get("category") || "all";
      const [expenses, asOf, totalCount] = await Promise.all([
        readDashboardRows(env.EXPENSES_DB, category),
        readSyncState(env.EXPENSES_DB),
        readTotalCount(env.EXPENSES_DB),
      ]);
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
        })),
        asOf,
        totalCount,
        totalUsd: expenses.reduce((s, e) => s + Number(e.amount_usd || 0), 0),
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const [expenses, asOf, totalCount] = await Promise.all([
        readDashboardRows(env.EXPENSES_DB, "all"),
        readSyncState(env.EXPENSES_DB),
        readTotalCount(env.EXPENSES_DB),
      ]);
      return new Response(renderDashboard(expenses, asOf, totalCount), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncExpenses(env));
  },
};

// Re-exported for unit tests.
export { formatAmount, formatDate };
