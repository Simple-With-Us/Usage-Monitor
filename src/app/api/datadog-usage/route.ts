import { NextResponse } from "next/server";
import { fetchDatadogUsage } from "@/lib/datadog-usage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const usage = await fetchDatadogUsage();
    return NextResponse.json(usage);
  } catch {
    return NextResponse.json({ configured: false, error: "read_failed" }, { status: 502 });
  }
}
