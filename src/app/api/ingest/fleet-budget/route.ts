import { prisma } from "@/lib/prisma";
import { budgetHandlers } from "@/lib/fleet-budget/http";
import { FleetBudgetLedger } from "@/lib/fleet-budget/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The existing /api/ingest middleware exclusion permits dedicated bearer auth.
// Both service and admission default off.  No caller is enabled by this route.
const handlers = budgetHandlers(new FleetBudgetLedger(prisma));
export const GET = handlers.GET;
export const POST = handlers.POST;
