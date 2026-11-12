import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { refreshStalePollableProviders } from "@/lib/refresh-stale-providers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshStalePollableProviders();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("refresh-stale failed:", error);
    return NextResponse.json(
      { error: "Failed to refresh old snapshots" },
      { status: 500 }
    );
  }
}
