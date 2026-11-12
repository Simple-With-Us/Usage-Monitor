import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface FleetTargetResult {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
  critical: boolean;
}

export interface FleetTargetDefinition {
  name: string;
  url: string;
  critical: boolean;
}

export const FLEET_TARGETS: FleetTargetDefinition[] = [
  { name: "Socratic.Trade", url: "https://socratictrade.com/api/health", critical: true },
  { name: "Congress.Trade", url: "https://congress.trade/api/health", critical: true },
  { name: "Congress.Trade Polling", url: "https://congress.trade/api/health/polling", critical: false },
  { name: "Congress.Trade Latency", url: "https://congress.trade/api/health/latency", critical: false },
  { name: "BotFleet Web", url: "https://botfleet.app/", critical: true },
  { name: "DealDex", url: "https://dealdex.online/", critical: true },
  { name: "Autorotate", url: "https://autorotate.vercel.app/", critical: true },
  { name: "ContactLogo", url: "https://contactlogo.com/", critical: true },
  { name: "Coolify Host", url: "https://host.jays.services/api/health", critical: true },
  { name: "Jays Services Apex", url: "https://jays.services/", critical: true },
];

export async function checkFleetTarget(target: FleetTargetDefinition, timeoutMs = 8000): Promise<FleetTargetResult> {
  const start = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        "User-Agent": "UsageMonitor-FleetHealth/1.0",
      },
    });
    const latencyMs = Date.now() - start;
    const ok = res.status >= 200 && res.status < 400;
    return {
      name: target.name,
      url: target.url,
      ok,
      status: res.status,
      latencyMs,
      critical: target.critical,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      name: target.name,
      url: target.url,
      ok: false,
      status: null,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
      critical: target.critical,
    };
  }
}

export async function GET() {
  const startedAt = Date.now();
  const results = await Promise.all(FLEET_TARGETS.map((t) => checkFleetTarget(t)));
  const totalDurationMs = Date.now() - startedAt;

  const failures = results.filter((r) => !r.ok);
  const criticalFailures = results.filter((r) => !r.ok && r.critical);
  const ok = criticalFailures.length === 0;

  return NextResponse.json(
    {
      ok,
      status: ok ? (failures.length === 0 ? "healthy" : "degraded") : "unhealthy",
      checkedAt: new Date().toISOString(),
      durationMs: totalDurationMs,
      totalTargets: results.length,
      passingCount: results.filter((r) => r.ok).length,
      failedCount: failures.length,
      criticalFailedCount: criticalFailures.length,
      failures: failures.map((f) => ({
        name: f.name,
        url: f.url,
        status: f.status,
        error: f.error,
        critical: f.critical,
      })),
      targets: results,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    }
  );
}
