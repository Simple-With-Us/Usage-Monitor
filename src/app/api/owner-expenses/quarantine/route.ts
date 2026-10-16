import { NextRequest, NextResponse } from "next/server";
import {
  hasValidDashboardSession,
  isCsrfSafeRequest,
  shouldEnforceDashboardSession,
} from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";
import { resolveQuarantinedOwnerExpense } from "@/lib/owner-expense";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMatchedEntries(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapRow(row: {
  id: string;
  quarantinedAt: Date;
  provider: string;
  amountUsd: number;
  occurredAt: Date;
  kind: string;
  label: string;
  notes: string | null;
  confidence: string;
  receiptInboxId: string | null;
  matchedEntries: string;
  matchReason: string;
}) {
  return {
    id: row.id,
    quarantinedAt: row.quarantinedAt.toISOString(),
    provider: row.provider,
    amountUsd: row.amountUsd,
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind,
    label: row.label,
    notes: row.notes,
    confidence: row.confidence,
    receiptInboxId: row.receiptInboxId,
    matchedEntries: parseMatchedEntries(row.matchedEntries),
    matchReason: row.matchReason,
  };
}

/**
 * GET /api/owner-expenses/quarantine
 *
 * Read-only list of owner expenses held by the duplicate quarantine,
 * newest first.  Each item carries `matchReason` (why it was held) and
 * `matchedEntries` (the posted rows it matched).  Dual-auth: dashboard
 * session cookie or USAGE_READ_TOKEN, like GET /api/owner-expenses.
 */
export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request) && !isUsageReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await prisma.quarantinedOwnerExpense.findMany({
    where: { status: "held" },
    orderBy: { quarantinedAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ quarantined: rows.map(mapRow) });
}

/**
 * POST /api/owner-expenses/quarantine
 *
 * Resolve one held item.  Dashboard session only (+ CSRF guard): resolving
 * is an owner decision, never a token-holder action.
 *
 * Body: { "id": "<quarantine uuid>", "action": "post" | "discard" }
 * - "post": force-records the original input (the duplicate quarantine is
 *   bypassed; the idempotency-key replay guard still applies).
 * - "discard": drops the held entry permanently.  Posted ledger rows are
 *   never touched by either action.
 */
export async function POST(request: NextRequest) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCsrfSafeRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, {
      label: "Quarantine resolve body",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = typeof record.id === "string" ? record.id : "";
  const action = record.action;
  if (!UUID_RE.test(id) || (action !== "post" && action !== "discard")) {
    return NextResponse.json(
      { error: 'Body must be { "id": "<uuid>", "action": "post" | "discard" }' },
      { status: 400 }
    );
  }
  try {
    const result = await resolveQuarantinedOwnerExpense(id, action);
    return NextResponse.json({ id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    const status = message.includes("not found") ? 404 : 500;
    if (status === 500) console.error("Failed to resolve quarantine:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
