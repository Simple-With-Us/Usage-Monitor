import { NextRequest, NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import {
  fetchReceiptEvidence,
  receiptInboxEvidenceConfigured,
} from "@/lib/receipt-inbox-admin";

export async function GET(
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
    const { id } = await params;
    const upstream = await fetchReceiptEvidence(id);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: upstream.status === 404 ? "Not found" : "Inbox request failed" },
        { status: upstream.status === 401 ? 503 : upstream.status }
      );
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "message/rfc822",
        "Content-Disposition":
          upstream.headers.get("Content-Disposition") ??
          `attachment; filename="receipt-${id}.eml"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch evidence";
    const status = message.includes("64 hex") ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
