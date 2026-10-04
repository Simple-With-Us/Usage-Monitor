import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  appSettings,
  resolveInfisicalEnvironment,
} from "@/lib/app-settings";
import { InfisicalWriteError } from "@jaywedgeworth22/congress-trading-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin surface for the Infisical sole-source-of-truth tunable knobs
 * (see INFISICAL.md and src/lib/app-settings.ts).
 *
 * This app is single-admin: the dashboard session (DASHBOARD_PASSWORD login)
 * IS the admin.  Any request without a valid dashboard session gets 403 —
 * the surface is hidden from non-admins entirely.  All values here are
 * non-secret tunable knobs; secret keys are never readable or writable
 * through this route (they ride the Infisical→Coolify env sync).
 */
function isAdmin(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) return forbidden();
  return NextResponse.json({
    ok: true,
    mode: appSettings.isInfisicalMode ? "infisical" : "env",
    environment: resolveInfisicalEnvironment(),
    settings: appSettings.getAllMeta(),
  });
}

export async function PUT(request: NextRequest) {
  if (!isAdmin(request)) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { key, value } = (body ?? {}) as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || !key.trim()) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }
  if (typeof value !== "string") {
    return NextResponse.json(
      { error: "value must be a string" },
      { status: 400 }
    );
  }

  try {
    const normalized = await appSettings.set(key.trim(), value);
    return NextResponse.json({
      ok: true,
      key: key.trim(),
      value: normalized,
      mode: appSettings.isInfisicalMode ? "infisical" : "env",
    });
  } catch (error) {
    if (error instanceof InfisicalWriteError) {
      // Write-through contract: the Infisical write failed, so the save
      // fails — cache and Infisical are never left diverged.
      return NextResponse.json(
        { error: `Infisical write failed for "${key}": save rejected` },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update setting" },
      { status: 400 }
    );
  }
}

/**
 * On-demand refresh: re-read Infisical now ("Reload settings" admin action;
 * SIGHUP does the same for operators).  Refresh failures keep serving the
 * last-known-good cache and surface here as a 502 with the cache intact.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) return forbidden();
  try {
    await appSettings.refresh();
    return NextResponse.json({
      ok: true,
      mode: appSettings.isInfisicalMode ? "infisical" : "env",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Refresh failed; serving last-known-good cache",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }
}
