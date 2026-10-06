import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import {
  isUsageReadAuthorized,
  safeEqual,
  tokenFromRequest,
} from "@/lib/ingest-auth";
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
