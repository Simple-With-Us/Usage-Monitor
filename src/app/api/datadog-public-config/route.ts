import { NextResponse } from "next/server";

import {
  DatadogConfigError,
  resolveDatadogRumConfig,
} from "@/lib/datadog-options";

export const dynamic = "force-dynamic";

/**
 * Public RUM/browser-log config.  The client token is a public intake
 * credential (same class as NEXT_PUBLIC_SENTRY_DSN).  Never returns
 * DD_API_KEY or any server secret.  Incomplete config is 503 (fail closed).
 */
export async function GET() {
  try {
    const rum = resolveDatadogRumConfig();
    if (!rum.enabled) {
      return NextResponse.json(
        { configured: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { configured: true, ...rum },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof DatadogConfigError) {
      return NextResponse.json(
        {
          configured: false,
          error: "incomplete_datadog_rum_config",
          missing: error.missing,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }
}
