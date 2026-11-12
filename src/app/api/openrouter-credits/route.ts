import { NextResponse } from "next/server";
import {
  probeOpenRouterCredits,
  toPublicOpenRouterCreditProbe,
} from "@/lib/openrouter-credit-probe";

/**
 * GET /api/openrouter-credits — public (middleware isPublicPath) OpenRouter
 * prepaid-credit + per-key spend-limit probe for external monitors.
 *
 * UptimeRobot keyword (ALERT_EXISTS):
 *   `"openrouterCredits":{"ok":false`
 *
 * Never 503s for low money (a restart cannot refill credits). Always HTTP 200
 * when the route itself runs; fail-open on OpenRouter read errors.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const probe = await probeOpenRouterCredits();
  const body = toPublicOpenRouterCreditProbe(probe);
  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
