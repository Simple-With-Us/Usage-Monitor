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
import { bustBudgetStatusCache } from "@/lib/budget-status";
import { prisma } from "@/lib/prisma";
import {
  OWNER_EXPENSE_SOURCE_APP,
  parseOwnerExpenseInput,
  recordOwnerExpense,
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

  const rows = await prisma.externalUsageEvent.findMany({
    where: {
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ occurredAt: order }, { idempotencyKey: order }],
    take: limit + 1,
    ...(cursor ? { cursor: { idempotencyKey: cursor }, skip: 1 } : {}),
    select: {
      idempotencyKey: true,
      provider: true,
      service: true,
      label: true,
      costUsd: true,
      confidence: true,
      occurredAt: true,
      metadata: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    expenses: page.map((row) => {
      const metadata =
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};
      const str = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      return {
        idempotencyKey: row.idempotencyKey,
        vendor: row.provider,
        amountUsd: row.costUsd,
        occurredAt: row.occurredAt.toISOString(),
        kind: str(metadata.kind) ?? row.service ?? "one_time",
        label: row.label,
        notes: str(metadata.notes),
        confidence: row.confidence,
        receiptInboxId: str(metadata.receiptInboxId),
        dueDate: str(metadata.dueDate),
        nextDueDate: str(metadata.nextDueDate),
        calendarSort: str(metadata.calendarSort),
      };
    }),
    nextCursor: hasMore ? page[page.length - 1]?.idempotencyKey ?? null : null,
    hasMore,
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

  const existing = await prisma.externalUsageEvent.findMany({
    where: {
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      idempotencyKey: { in: keys },
    },
    select: { idempotencyKey: true },
  });
  const existingKeys = new Set(existing.map((row) => row.idempotencyKey));

  const deleted = await prisma.externalUsageEvent.deleteMany({
    where: {
      sourceApp: OWNER_EXPENSE_SOURCE_APP,
      idempotencyKey: { in: keys },
    },
  });

  if (deleted.count > 0) {
    bustBudgetStatusCache();
  }

  return NextResponse.json({
    requested: keys.length,
    deleted: deleted.count,
    notFound: keys.filter((key) => !existingKeys.has(key)),
  });
}
