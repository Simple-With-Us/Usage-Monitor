import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { fetchJson, parseNumber } from "@/lib/adapters/helpers";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

/**
 * Per-call OpenRouter cost verification (DESIGN-usage-compliance-classifier §3c).
 *
 * Producers (Congress.Trade / Socratic.Trade) attach OpenRouter's generation id
 * to each pushed telemetry event as `providerRequestId`. This worker calls
 * `GET /api/v1/generation?id=<providerRequestId>` for a bounded batch of
 * not-yet-verified events, stores the provider's AUTHORITATIVE cost in
 * `verifiedCostUsd`, and compares it to the self-reported `costUsd` so drift
 * surfaces instead of being silently trusted.
 *
 * Bounded, idempotent, and safe to run every maintenance pass:
 *   - at most MAX_EVENTS_PER_PASS events per pass, deterministically ordered,
 *     with `truncated` reported so a backlog is visible rather than hidden;
 *   - network I/O happens OUTSIDE the single-writer admission lock (the same
 *     discipline alert-delivery uses) so verification can never stall ingest;
 *   - already-settled events ("match"/"discrepancy") are never re-fetched;
 *   - a transient failure records "error" and is retried on a later pass, up to
 *     MAX_VERIFICATION_ATTEMPTS, after which the event is parked in the
 *     TERMINAL "unverifiable" state so it can never be re-selected.
 *
 * The terminal state matters: "error" is a RETRYABLE status that the due-scan
 * selects. Parking an exhausted event as "error" would let it be picked up
 * forever — and because the exhausted marker is not an attempt marker, its
 * attempt counter would reset to 0 on every re-selection, yielding a permanent
 * 5-pass cycle. Since the scan is ordered oldest-first, a pile of permanently
 * dead ids (e.g. generations OpenRouter has pruned) would fill every batch and
 * starve newly-ingested events indefinitely while burning API calls.
 */

const MAX_EVENTS_PER_PASS = 25;

/**
 * Tolerance for calling a reported cost a match. Both are absolute-OR-ratio:
 * an event matches when |reported - verified| <= max(abs, ratio * verified).
 * Sub-cent LLM calls need the absolute floor; larger calls need the ratio.
 * Optional env overrides — never REQUIRED (no new deploy-time configuration).
 */
const DEFAULT_ABS_TOLERANCE_USD = 0.005;
const DEFAULT_RATIO_TOLERANCE = 0.05;

/**
 * A generation id that keeps failing is not retried forever. Attempts are
 * tracked in `verifiedSource` rather than a new column so this stays a
 * code-only change on an already-migrated schema.
 */
const MAX_VERIFICATION_ATTEMPTS = 5;

export const VERIFIED_SOURCE = "openrouter-generation";
const EXHAUSTED_SOURCE = "openrouter-generation-exhausted";
const ATTEMPT_PREFIX = "openrouter-generation-attempt-";

export interface OpenRouterVerificationResult {
  examined: number;
  matched: number;
  discrepancies: number;
  errors: number;
  /** Events whose retry budget ran out this pass. */
  exhausted: number;
  /** Kept for the maintenance summary: events that reached a settled state. */
  verifiedCount: number;
  truncated: boolean;
  /**
   * True when the pass stopped early because the key cannot read generations
   * (401/403). Surfaced to maintenance health rather than thrown, so a scoped
   * key problem degrades the audit layer without failing the whole tick.
   */
  degraded: boolean;
}

function resolveTolerance(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function attemptsFromSource(verifiedSource: string | null): number {
  if (!verifiedSource?.startsWith(ATTEMPT_PREFIX)) return 0;
  const parsed = Number.parseInt(verifiedSource.slice(ATTEMPT_PREFIX.length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Extracts OpenRouter's authoritative cost from a get-generation payload.
 * `total_cost` is the documented credit-charge field; `usage` is accepted as a
 * fallback for older payload shapes. A missing/unparseable cost is `null`, which
 * the caller treats as a transient error rather than a $0 verification — a
 * fabricated zero would read as "provider says this was free" and silently
 * cancel real drift.
 */
export function extractGenerationCostUsd(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return parseNumber(record.total_cost) ?? parseNumber(record.usage);
}

/**
 * True when the reported cost is within tolerance of the provider-verified
 * cost. A null reported cost counts as 0: an event that pushed no cost while
 * the provider charged real money IS under-reporting, not a match.
 */
export function isCostWithinTolerance(
  reportedCostUsd: number | null,
  verifiedCostUsd: number,
  absTolerance: number,
  ratioTolerance: number
): boolean {
  const reported = reportedCostUsd ?? 0;
  const allowed = Math.max(
    absTolerance,
    Math.abs(verifiedCostUsd) * ratioTolerance
  );
  return Math.abs(reported - verifiedCostUsd) <= allowed;
}

/**
 * Prefer a true OpenRouter Management/Admin (Provisioning) key over a
 * per-app inference key. GET /generation and account-wide reads return 403
 * for non-management keys; picking the oldest openrouter Provider by
 * createdAt often selected Congress.Trade/Socratic.Trade inference keys.
 */
async function resolveOpenRouterKey(): Promise<string | null> {
  for (const envName of ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_ADMIN_KEY"] as const) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
  }

  const providers = await prisma.provider.findMany({
    where: { name: "openrouter", isActive: true, apiKey: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { apiKey: true, label: true, displayName: true },
  });
  if (providers.length === 0) return null;

  const preferred =
    providers.find((provider) =>
      /management|admin|provisioning/i.test(
        `${provider.label ?? ""} ${provider.displayName ?? ""}`
      )
    ) ?? providers[0];

  if (!preferred.apiKey) return null;
  try {
    return decrypt(preferred.apiKey);
  } catch {
    return null;
  }
}

type PendingUpdate = {
  id: string;
  data: {
    verificationStatus: string;
    verifiedCostUsd?: number | null;
    verifiedAt?: Date | null;
    verifiedSource?: string | null;
  };
};

export async function verifyOpenRouterGenerations(): Promise<OpenRouterVerificationResult> {
  const empty: OpenRouterVerificationResult = {
    examined: 0,
    matched: 0,
    discrepancies: 0,
    errors: 0,
    exhausted: 0,
    verifiedCount: 0,
    truncated: false,
    degraded: false,
  };

  // Due-scan predicate per DESIGN §3c (AMENDED): SQL `IN (NULL, ...)` never
  // matches NULL, so freshly-ingested events (verificationStatus IS NULL) must
  // be selected explicitly alongside the retryable states.
  const candidates = await prisma.externalUsageEvent.findMany({
    where: {
      provider: "openrouter",
      providerRequestId: { not: null },
      OR: [
        { verificationStatus: null },
        { verificationStatus: { in: ["pending", "error"] } },
      ],
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: MAX_EVENTS_PER_PASS + 1,
    select: {
      id: true,
      providerRequestId: true,
      costUsd: true,
      verifiedSource: true,
    },
  });

  const truncated = candidates.length > MAX_EVENTS_PER_PASS;
  const events = candidates.slice(0, MAX_EVENTS_PER_PASS);
  if (events.length === 0) return { ...empty, truncated };

  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) {
    console.warn(
      "[openrouter-verification] no OpenRouter key available; skipping pass"
    );
    return { ...empty, truncated, degraded: true };
  }

  const absTolerance = resolveTolerance(
    "OPENROUTER_VERIFICATION_ABS_TOLERANCE_USD",
    DEFAULT_ABS_TOLERANCE_USD
  );
  const ratioTolerance = resolveTolerance(
    "OPENROUTER_VERIFICATION_RATIO_TOLERANCE",
    DEFAULT_RATIO_TOLERANCE
  );

  // PHASE 1 — network only. Deliberately outside the write-admission lock: a
  // slow provider must never hold the single SQLite writer against ingest.
  const updates: PendingUpdate[] = [];
  let matched = 0;
  let discrepancies = 0;
  let errors = 0;
  let exhausted = 0;
  let degraded = false;

  for (const event of events) {
    const generationId = event.providerRequestId;
    if (!generationId) continue;

    const attempts = attemptsFromSource(event.verifiedSource);

    let status: number | null = null;
    let data: unknown = null;
    try {
      const response = await fetchJson(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      status = response.status;
      data = response.ok ? response.data : null;
    } catch (error) {
      console.error(
        `[openrouter-verification] fetch failed for event ${event.id}:`,
        error instanceof Error ? error.message : error
      );
      status = null;
    }

    // A key that cannot read generations will fail identically for every row.
    // Stop the pass and report degraded instead of burning the retry budget of
    // every pending event on the same configuration problem.
    if (status === 401 || status === 403) {
      console.warn(
        "[openrouter-verification] key rejected (HTTP " +
          status +
          "); stopping pass — generation read scope required"
      );
      degraded = true;
      break;
    }

    const envelope =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).data
        : null;
    const verifiedCostUsd =
      status === 200 ? extractGenerationCostUsd(envelope) : null;

    if (verifiedCostUsd == null) {
      // 404 / 429 / 5xx / unparseable — retryable until the budget runs out.
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_VERIFICATION_ATTEMPTS) {
        exhausted += 1;
        updates.push({
          id: event.id,
          data: {
            // TERMINAL — deliberately NOT "error". "error" is retryable and
            // would re-select this row every pass forever (see the header
            // comment): its attempt counter resets, so it would cycle 1..5
            // indefinitely, consume a batch slot, and starve fresh events.
            verificationStatus: "unverifiable",
            verifiedSource: EXHAUSTED_SOURCE,
          },
        });
      } else {
        errors += 1;
        updates.push({
          id: event.id,
          data: {
            verificationStatus: "error",
            verifiedSource: `${ATTEMPT_PREFIX}${nextAttempts}`,
          },
        });
      }
      continue;
    }

    const withinTolerance = isCostWithinTolerance(
      event.costUsd,
      verifiedCostUsd,
      absTolerance,
      ratioTolerance
    );
    if (withinTolerance) matched += 1;
    else discrepancies += 1;

    updates.push({
      id: event.id,
      data: {
        verificationStatus: withinTolerance ? "match" : "discrepancy",
        verifiedCostUsd,
        verifiedAt: new Date(),
        verifiedSource: VERIFIED_SOURCE,
      },
    });
  }

  // PHASE 2 — writes only, under admission. Bounded (<= MAX_EVENTS_PER_PASS
  // single-row updates) so the writer lock is held briefly.
  if (updates.length > 0) {
    await withInternalUsageWriteAdmission(async () => {
      for (const update of updates) {
        await prisma.externalUsageEvent.update({
          where: { id: update.id },
          data: update.data,
        });
      }
    });
  }

  return {
    examined: events.length,
    matched,
    discrepancies,
    errors,
    exhausted,
    verifiedCount: matched + discrepancies,
    truncated,
    degraded,
  };
}
