import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { readBoundedJsonBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import { importWorkspacePayload } from "@/lib/workspace-copy";

export const dynamic = "force-dynamic";

const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export async function POST(request: NextRequest) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request, {
      maxBytes: MAX_IMPORT_BYTES,
      label: "Workspace import",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await importWorkspacePayload(body, "merge");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
