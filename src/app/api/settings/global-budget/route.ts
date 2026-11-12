import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  loadGlobalBudgetSnapshot,
  parseGlobalBudgetBody,
  upsertGlobalMonthlyBudget,
} from "@/lib/global-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isDashboardSession(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

/** GET — global / portfolio budget (session only). */
export async function GET(request: NextRequest) {
  if (!isDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snapshot = await loadGlobalBudgetSnapshot();
  return NextResponse.json({ ok: true, ...snapshot });
}

/** PUT — set or clear Global Budget override (session only). */
export async function PUT(request: NextRequest) {
  if (!isDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    const parsed = parseGlobalBudgetBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const snapshot = await upsertGlobalMonthlyBudget(parsed.value);
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update global budget",
      },
      { status: 500 }
    );
  }
}
