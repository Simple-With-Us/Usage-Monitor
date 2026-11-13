import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FleetBudgetLedger } from "@/lib/fleet-budget/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ledger = new FleetBudgetLedger(prisma);
const headers = { "cache-control": "no-store" };

// This route stays behind the existing session middleware and rechecks the
// same verified session itself.  It never accepts ingest/read/client tokens.
export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    // Keep outstanding costs visible even when new admissions are stopped.
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      enabled: process.env.FLEET_BUDGET_ENABLED === "true",
      admissionEnabled: process.env.FLEET_BUDGET_ENABLED === "true" && process.env.FLEET_BUDGET_ADMISSION_ENABLED === "true",
      snapshot: await ledger.status(),
    }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Fleet budget status unavailable" }, { status: 503, headers });
  }
}
