import { NextResponse } from "next/server";
import { getPublicR2WeeklyHealth, getRuntimeIdentity } from "@/lib/runtime-health";

// Unauthenticated liveness check for external uptime monitors. Deliberately
// excluded from src/middleware.ts's session gate, since the dashboard's own
// pages/APIs now redirect/401 unauthenticated requests and a health check
// shouldn't need to authenticate (or follow a redirect) just to confirm the
// service is up.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      status: "live",
      ...getRuntimeIdentity(),
      uptimeSeconds: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
      // Fleet-standard shape (matches Socratic.Trade / Congress.Trade) so
      // fleet-backup-status.ts's peer parser and external monitors can read
      // this app's own weekly R2 archive freshness off the public path.
      checks: {
        storage: {
          r2Weekly: getPublicR2WeeklyHealth(),
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
