import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { fetchAllDueProviders } from "@/lib/usage-recorder";
import { runUsageMaintenance } from "@/lib/usage-maintenance";

// Constant-time secret comparison. Hashing both sides first fixes the length
// to the digest size, so timingSafeEqual never throws (and doesn't leak
// anything) when the caller-supplied secret is a different length than
// CRON_SECRET - a plain `!==` (or a naive length-checked timingSafeEqual)
// leaks that length/mismatch signal via response timing.
function isAuthorizedCronSecret(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

// This endpoint is no longer called on a schedule (usage polling now runs
// in-process, see src/instrumentation.ts / src/lib/usage-recorder.ts). It's
// kept as an authenticated manual-trigger/debug route - cheap to keep and
// useful for on-demand triggering.
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret || !isAuthorizedCronSecret(cronSecret, expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await fetchAllDueProviders();
  const maintenance = await runUsageMaintenance();

  return NextResponse.json({ ...result, maintenance });
}
