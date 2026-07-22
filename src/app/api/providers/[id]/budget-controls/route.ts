import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  applyManualBudgetControl,
  ManualBudgetControlError,
  type ManualBudgetControlAction,
} from "@/lib/budget-controls";
import { computeBudgetStatus, bustBudgetStatusCache } from "@/lib/budget-status";

const ACTIONS = new Set<ManualBudgetControlAction>([
  "enable",
  "disable",
  "pause",
  "resume",
]);

/**
 * Owner manual budget-control actions (session-gated by middleware).
 *
 * Auto-controls never pause polling (read-only observer). This route is the
 * only way to pause/resume a provider's poll or flip per-provider opt-in.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action =
    body && typeof body === "object" && "action" in body
      ? String((body as { action: unknown }).action)
      : "";
  if (!ACTIONS.has(action as ManualBudgetControlAction)) {
    return NextResponse.json(
      {
        error:
          "action must be one of: enable | disable | pause | resume",
      },
      { status: 400 }
    );
  }
  const reason =
    body && typeof body === "object" && "reason" in body
      ? String((body as { reason: unknown }).reason ?? "")
      : null;

  try {
    // Pull live coverage for pause safety checks.
    const budget = await computeBudgetStatus();
    const row = budget.providers.find((p) => p.id === id);
    const result = await applyManualBudgetControl(id, {
      action: action as ManualBudgetControlAction,
      reason,
      spendCoverage: row?.spendCoverage ?? null,
      monthlyBudgetUsd: row?.monthlyBudgetUsd ?? null,
      spentUsd: row?.spentUsd ?? null,
      observedVariableUsageUsd: row?.observedVariableUsageUsd ?? null,
      fixedAccruedUsd: row?.fixedAccruedUsd ?? null,
    });
    bustBudgetStatusCache();
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ManualBudgetControlError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error("[budget-controls] manual action failed", error);
    return NextResponse.json(
      { error: "Failed to apply budget control action" },
      { status: 500 }
    );
  }
}
