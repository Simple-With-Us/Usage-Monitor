import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { readBoundedJsonBody } from "@/lib/bounded-request-body";
import {
  patchReceiptInboxStatus,
  receiptInboxEvidenceConfigured,
} from "@/lib/receipt-inbox-admin";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!receiptInboxEvidenceConfigured()) {
    return NextResponse.json(
      { error: "Receipt evidence token is not configured on this host" },
      { status: 503 }
    );
  }
  try {
    const body = await readBoundedJsonBody(request, {
      label: "Receipt inbox status",
      maxBytes: 1024,
    });
    const status =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { status?: unknown }).status
        : null;
    if (status !== "reviewed" && status !== "ignored") {
      return NextResponse.json(
        { error: "status must be reviewed or ignored" },
        { status: 400 }
      );
    }
    const { id } = await params;
    const upstream = await patchReceiptInboxStatus(id, status);
    const payload = await upstream.json().catch(() => ({ ok: upstream.ok }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update status";
    const statusCode = message.includes("64 hex") ? 400 : 503;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
