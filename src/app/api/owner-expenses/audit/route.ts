import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession } from "@/lib/auth";
import { listOwnerExpenseAudit } from "@/lib/owner-expense";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /api/owner-expenses/audit
 *
 * Owner-visible history of posted-expense management actions (UM-1659):
 * every delete and edit recorded by the DELETE / PATCH handlers, newest
 * first, with the pre-change snapshot (and the post-edit snapshot for
 * edits).  Dashboard session only — this is the ledger's change log, so
 * there is no read-token fallback.
 *
 * Query params: `limit` (1-500, default 100).
 */
export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const entries = await listOwnerExpenseAudit(limit);
  return NextResponse.json({ entries });
}
