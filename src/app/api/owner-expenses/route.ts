import { NextRequest, NextResponse } from "next/server";
import {
  hasValidDashboardSession,
  isCsrfSafeRequest,
  shouldEnforceDashboardSession,
} from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import {
  isUsageReadAuthorized,
  safeEqual,
  tokenFromRequest,
} from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";
import {
  OWNER_EXPENSE_SOURCE_APP,
  deleteOwnerExpenses,
  editOwnerExpense,
  parseOwnerExpenseInput,
  recordOwnerExpense,
  snapshotOwnerExpenseRow,
  type OwnerExpenseSnapshot,
  type OwnerExpenseUpdates,
} from "@/lib/owner-expense";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * Parse a from/to date param.  A bare YYYY-MM-DD `to` means the end of that
 * day (inclusive range); a full ISO timestamp is used as-is.
 */
function parseDayParam(value: string | null, endOfDay: boolean): Date | undefined {
  if (value == null) return undefined;
  const iso =
    endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  return new Date(iso);
}

function hasOwnerExpenseToken(request: NextRequest): boolean {
  const expected = process.env.OWNER_EXPENSE_TOKEN?.trim() ?? "";
  if (!expected || expected.length < 32) return false;
  const actual = tokenFromRequest(request, "x-owner-expense-token");
  return Boolean(actual) && safeEqual(actual, expected);
}

export async function POST(request: NextRequest) {
  const sessionOk = hasValidDashboardSession(request);
  if (shouldEnforceDashboardSession() && !sessionOk && !hasOwnerExpenseToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = parseOwnerExpenseInput(
      await readBoundedJsonBody(request, { label: "Owner expense body" })
    );
    const recorded = await recordOwnerExpense(input);
    if (recorded.quarantined) {
      // Held for owner review as a suspected exact duplicate: accepted but
      // NOT posted.  202 signals "received, pending a decision".
      return NextResponse.json(recorded, { status: 202 });
    }
    return NextResponse.json(recorded, { status: recorded.persisted > 0 ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = message.includes("must") || message.includes("Body") ? 400 : 500;
    if (status === 500) {
      console.error("Failed to record owner expense:", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}

interface OwnerExpenseTotals {
  count: number;
  totalUsd: number;
  byCategory: { Tech: number; Other: number; uncategorized: number };
  counts: { Tech: number; Other: number; uncategorized: number };
}

function computeTotals(expenses: OwnerExpenseSnapshot[]): OwnerExpenseTotals {
  const totals: OwnerExpenseTotals = {
    count: expenses.length,
    totalUsd: 0,
    byCategory: { Tech: 0, Other: 0, uncategorized: 0 },
    counts: { Tech: 0, Other: 0, uncategorized: 0 },
  };
  for (const expense of expenses) {
    const amount = expense.amountUsd ?? 0;
    totals.totalUsd += amount;
    if (expense.category === "Tech") {
      totals.byCategory.Tech += amount;
      totals.counts.Tech += 1;
    } else if (expense.category === "Other") {
      totals.byCategory.Other += amount;
      totals.counts.Other += 1;
    } else {
      totals.byCategory.uncategorized += amount;
      totals.counts.uncategorized += 1;
    }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  totals.totalUsd = round(totals.totalUsd);
  totals.byCategory.Tech = round(totals.byCategory.Tech);
  totals.byCategory.Other = round(totals.byCategory.Other);
  totals.byCategory.uncategorized = round(totals.byCategory.uncategorized);
  return totals;
}

/**
 * GET /api/owner-expenses
 *
 * Read-only list of owner-recorded expenses (sourceApp "owner-recorded-expense").
 * Dual-auth: dashboard session cookie or USAGE_READ_TOKEN Bearer <redacted> the same
 * pattern as /api/quota-windows — so the expenses dashboard worker can sync
 * without a session cookie.
 *
 * Query params: `limit` (1-1000, default 200), `cursor` (idempotencyKey to page
 * from), `order` (asc|desc, default desc), `from`/`to` (ISO dates, inclusive).
 *
 * Management params (UM-1659, used by the Posted Expenses dashboard card):
 * `q` (case-insensitive substring over vendor / label / notes), `provider`
 * (case-insensitive substring), `category` (tech | other | uncategorized),
 * `sort` (occurredAt | amountUsd, default occurredAt), and `totals=1` to
 * include a `totals` block (count, total, Tech vs Other split) computed over
 * the full filtered set.  With none of these present the response is exactly
 * the historical shape and the query stays on the indexed cursor path; the
 * filtered path loads the (small) owner ledger and filters/sorts in JS,
 * mirroring findDuplicateOwnerExpenses.
 */
export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request) && !isUsageReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const cursor = searchParams.get("cursor");
  const order = searchParams.get("order") === "asc" ? "asc" : "desc";

  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const from = parseDayParam(fromParam, false);
  const to = parseDayParam(toParam, true);
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return NextResponse.json(
      { error: "from/to must be valid ISO dates" },
      { status: 400 }
    );
  }

  const q = searchParams.get("q")?.trim().toLowerCase() || null;
  const providerFilter = searchParams.get("provider")?.trim().toLowerCase() || null;
  const categoryParam = searchParams.get("category")?.trim().toLowerCase() || null;
  if (
    categoryParam &&
    categoryParam !== "tech" &&
    categoryParam !== "other" &&
    categoryParam !== "uncategorized"
  ) {
    return NextResponse.json(
      { error: "category must be tech, other, or uncategorized" },
      { status: 400 }
    );
  }
  const sort = searchParams.get("sort") === "amountUsd" ? "amountUsd" : "occurredAt";
  const wantsTotals = searchParams.get("totals") === "1";
  const filtered = Boolean(q || providerFilter || categoryParam) || sort === "amountUsd" || wantsTotals;

  const where = {
    sourceApp: OWNER_EXPENSE_SOURCE_APP,
    ...(from || to
      ? {
          occurredAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
  const select = {
    idempotencyKey: true,
    provider: true,
    service: true,
    label: true,
    costUsd: true,
    confidence: true,
    occurredAt: true,
    metadata: true,
  };

  if (!filtered) {
    const rows = await prisma.externalUsageEvent.findMany({
      where,
      orderBy: [{ occurredAt: order }, { idempotencyKey: order }],
      take: limit + 1,
      ...(cursor ? { cursor: { idempotencyKey: cursor }, skip: 1 } : {}),
      select,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json({
      expenses: page.map(snapshotOwnerExpenseRow),
      nextCursor: hasMore ? page[page.length - 1]?.idempotencyKey ?? null : null,
      hasMore,
    });
  }

  const rows = await prisma.externalUsageEvent.findMany({ where, select });
  let expenses = rows.map(snapshotOwnerExpenseRow);
  if (providerFilter) {
    expenses = expenses.filter((expense) =>
      expense.vendor.toLowerCase().includes(providerFilter)
    );
  }
  if (categoryParam) {
    expenses = expenses.filter((expense) => {
      if (categoryParam === "uncategorized") return expense.category === null;
      return expense.category?.toLowerCase() === categoryParam;
    });
  }
  if (q) {
    expenses = expenses.filter((expense) =>
      [expense.vendor, expense.label ?? "", expense.notes ?? ""].some((field) =>
        field.toLowerCase().includes(q)
      )
    );
  }
  const direction = order === "asc" ? 1 : -1;
  expenses.sort((a, b) => {
    const primary =
      sort === "amountUsd"
        ? (a.amountUsd ?? 0) - (b.amountUsd ?? 0)
        : a.occurredAt.localeCompare(b.occurredAt);
    if (primary !== 0) return primary * direction;
    return a.idempotencyKey.localeCompare(b.idempotencyKey) * direction;
  });

  const totals = computeTotals(expenses);
  let start = 0;
  if (cursor) {
    const cursorIndex = expenses.findIndex(
      (expense) => expense.idempotencyKey === cursor
    );
    if (cursorIndex >= 0) start = cursorIndex + 1;
  }
  const page = expenses.slice(start, start + limit);
  const hasMore = start + page.length < expenses.length;

  return NextResponse.json({
    expenses: page,
    nextCursor: hasMore ? page[page.length - 1]?.idempotencyKey ?? null : null,
    hasMore,
    ...(wantsTotals ? { totals } : {}),
  });
}

const DELETE_MAX_KEYS = 100;
const OWNER_EXPENSE_KEY_RE = /^owner-recorded-expense:v1:[0-9a-f]{64}$/;

/**
 * DELETE /api/owner-expenses
 *
 * Admin-only removal of owner-recorded expense rows by idempotency key.
 * Dashboard session cookie required — there is intentionally no
 * OWNER_EXPENSE_TOKEN fallback; deleting ledger rows is destructive and
 * stays behind the admin session.  The CSRF guard applies because this is
 * a cookie-authenticated mutator.
 *
 * Two independent safety pins keep a key from ever deleting a non-expense
 * row: the key format is validated against the owner-expense idempotency
 * shape, and the delete WHERE clause is pinned to
 * sourceApp "owner-recorded-expense".
 *
 * A delete that removes at least one row busts the budget-status caches,
 * matching recordOwnerExpense.  A no-op delete leaves the caches alone.
 *
 * Body: { "idempotencyKeys": ["owner-recorded-expense:v1:<64hex>", ...] }
 * Response: { requested, deleted, notFound: [...] }
 */
export async function DELETE(request: NextRequest) {
  if (!hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCsrfSafeRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, {
      label: "Owner expense delete body",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const rawKeys =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).idempotencyKeys
      : undefined;
  if (
    !Array.isArray(rawKeys) ||
    rawKeys.length === 0 ||
    rawKeys.length > DELETE_MAX_KEYS ||
    rawKeys.some(
      (key) => typeof key !== "string" || !OWNER_EXPENSE_KEY_RE.test(key)
    )
  ) {
    return NextResponse.json(
      {
        error:
          "idempotencyKeys must be a non-empty array of at most 100 owner-recorded-expense idempotency keys",
      },
      { status: 400 }
    );
  }
  const keys = [...new Set(rawKeys as string[])];

  // UM-1659: deletion is permanent.  deleteOwnerExpenses writes an audit
  // snapshot and an idempotency-key tombstone for every removed row in the
  // same transaction, so a deleted expense can never be resurrected by a
  // receipt-intake replay or re-forward.
  const result = await deleteOwnerExpenses(keys);

  return NextResponse.json(result);
}

/**
 * PATCH /api/owner-expenses
 *
 * Edit one posted owner expense (UM-1659).  Dashboard session + CSRF guard,
 * same as DELETE: edits rewrite ledger rows, so there is intentionally no
 * token fallback.  Body: { "idempotencyKey": "<key>", ...fieldsToUpdate }
 * where a field set to null clears it (notes / receiptInboxId / dueDate /
 * nextDueDate / calendarSort) and an absent field is unchanged.  The merged
 * values are validated by parseOwnerExpenseInput; an edit that changes a
 * key field rekeys the row and tombstones the old key (see editOwnerExpense).
 *
 * Response: { expense, rekeyed }
 */
export async function PATCH(request: NextRequest) {
  if (!hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCsrfSafeRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, {
      label: "Owner expense edit body",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object" },
      { status: 400 }
    );
  }
  const { idempotencyKey, ...fields } = body as Record<string, unknown>;
  if (
    typeof idempotencyKey !== "string" ||
    !OWNER_EXPENSE_KEY_RE.test(idempotencyKey)
  ) {
    return NextResponse.json(
      { error: "idempotencyKey must be an owner-recorded-expense idempotency key" },
      { status: 400 }
    );
  }

  const updates: OwnerExpenseUpdates = {};
  const stringField = (name: keyof OwnerExpenseUpdates) => {
    const value = fields[name];
    if (value === undefined) return;
    if (value !== null && typeof value !== "string") {
      throw new Error(`${name} must be a string or null`);
    }
    (updates as Record<string, unknown>)[name] = value;
  };
  try {
    stringField("provider");
    stringField("occurredAt");
    stringField("kind");
    stringField("label");
    stringField("notes");
    stringField("confidence");
    stringField("receiptInboxId");
    stringField("dueDate");
    stringField("nextDueDate");
    stringField("calendarSort");
    if (fields.amountUsd !== undefined) {
      if (typeof fields.amountUsd !== "number") {
        throw new Error("amountUsd must be a number");
      }
      updates.amountUsd = fields.amountUsd;
    }
    if (fields.cancelledNoRenew !== undefined) {
      if (typeof fields.cancelledNoRenew !== "boolean") {
        throw new Error("cancelledNoRenew must be a boolean");
      }
      updates.cancelledNoRenew = fields.cancelledNoRenew;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  // provider / occurredAt / kind / label / confidence do not accept null
  // (clearing them is meaningless); the lib's parser would reject the
  // resulting empty values anyway, but say so plainly here.
  for (const name of ["provider", "occurredAt", "kind", "label", "confidence"] as const) {
    if ((updates as Record<string, unknown>)[name] === null) {
      return NextResponse.json(
        { error: `${name} cannot be null` },
        { status: 400 }
      );
    }
  }

  try {
    const result = await editOwnerExpense(idempotencyKey, updates);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = message.includes("not found")
      ? 404
      : message.includes("conflicts")
        ? 409
        : message.includes("must")
          ? 400
          : 500;
    if (status === 500) {
      console.error("Failed to edit owner expense:", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
