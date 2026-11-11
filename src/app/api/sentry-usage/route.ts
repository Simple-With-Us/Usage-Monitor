import { NextResponse } from "next/server";
import { fetchSentryUsage } from "@/lib/sentry-usage";

// GET /api/sentry-usage — dashboard-session gated (not on isPublicPath).
// Reads the latest Sentry provider snapshot.  Never calls a billing API
// and never returns prepaid balance / invoice fields.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const usage = await fetchSentryUsage();
    return NextResponse.json(usage);
  } catch {
    return NextResponse.json({ configured: false, error: "read_failed" }, { status: 502 });
  }
}
