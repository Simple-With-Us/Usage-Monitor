import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import { buildWorkspaceExport } from "@/lib/workspace-copy";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  return hasValidDashboardSession(request) || isUsageReadAuthorized(request);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await buildWorkspaceExport();
    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition":
          'attachment; filename="usage-monitor-workspace-export.json"',
      },
    });
  } catch (error) {
    console.error("workspace export failed:", error);
    return NextResponse.json(
      { error: "Failed to export workspace" },
      { status: 500 }
    );
  }
}
