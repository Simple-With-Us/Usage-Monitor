import { NextResponse } from "next/server";
import { getFleetAlerts } from "@/lib/fleet-alerts";

// Fleet alert status, read from the shared alert ingress.  This route is the
// consumer side of "one writer, many readers": the ingress owns alert state and
// publishes it at GET /status, so /ops renders the same truth the Zulip channel
// shows instead of re-deriving health per vendor.
//
// Session-gated like the other ops APIs (it is not in middleware.ts's open
// list), and cached briefly in fleet-alerts.ts so a busy ops page does not fan
// out one request per render.
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getFleetAlerts();
  return NextResponse.json(payload, {
    headers: {
      // Never let a proxy or the browser hold a stale copy: the whole point is
      // that this view is current.
      "Cache-Control": "no-store",
    },
  });
}