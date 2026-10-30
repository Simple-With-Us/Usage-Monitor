import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type { UsageTelemetryErrorCode } from "@jaywedgeworth22/congress-trading-shared";
import { prisma } from "@/lib/prisma";
import {
  ExternalUsageIdempotencyCollisionError,
  NegativeSubscriptionWindowLimitExceededError,
  persistExternalUsageEvents,
} from "@/lib/external-usage-events";
import {
  MAX_USAGE_TELEMETRY_BODY_BYTES,
  parseUsageTelemetryBatch,
  parseUsageTelemetryV2Batch,
  type ParsedUsageTelemetryEvent,
  type UsageTelemetryV2EventRejection,
} from "@/lib/usage-telemetry";
import { applyIngestCostDerivation } from "@/lib/pricing/derive-ingest-cost";
import {
  getIngestIdentityRateLimitKey,
  getLoginBackstopKey,
  getNamedRateLimiter,
} from "@/lib/rate-limit";
import {
  isBillingReceiptIngestAuthorized,
  isUsageIngestAuthorized,
  resolveUsageIngestCredential,
  safeEqual,
  tokenFromRequest,
} from "@/lib/ingest-auth";
import { resolveProjectIdsByName } from "@/lib/project-resolver";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { fanoutPersistedUsage } from "@/lib/usage-fanout";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  looksLikeReceiptCashEvent,
  receiptCashIdentity,
  stripReceiptTransportSignature,
  verifyReceiptCashEvent,
} from "@/lib/receipt-cash";
import {
  INGEST_ADMISSION_RETRY_AFTER_SECONDS,
  tryAcquireIngestAdmission,
} from "@/lib/ingest-admission";
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody,
} from "@/lib/bounded-request-body";
import { SUBSCRIPTION_SOURCE_APP } from "@/lib/subscription-charge-identity";
import { markBudgetStatusSoftStale } from "@/lib/budget-status";
import { dropEventsCoveredByNative } from "@/lib/native-telemetry-coverage";
import { dropEventsCoveredByBotFleet, stampBotFleetReceiptCredential } from "@/lib/botfleet-coverage";
import { sqliteWriteContentionCode } from "@/lib/sqlite-write-contention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rate limiting runs AFTER authentication and is keyed on identity, not the
// shared egress IP (X1 — the login route solved the same topology problem):
//
// - Authenticated requests are keyed on a SHA-256 hash of the presented token
//   (getIngestIdentityRateLimitKey), 10 rps per credential. Producers all
//   arrive through Cloudflare's shared egress IP, so the old pre-auth per-IP
//   bucket let one bursting producer (or bad-token hammering) 429 every
//   other producer. Per-credential buckets keep legitimate traffic at the
//   same 10 rps it always had, without cross-producer interference.
// - Unauthenticated requests fall back to an IP backstop keyed via
//   getLoginBackstopKey, which re-aggregates by the one unspoofable identity
//   for the request's topology (CF-Connecting-IP behind Cloudflare, the
//   rightmost XFF hop otherwise) so bad-token hammering is throttled per
//   real source instead of per shared egress IP.
const ingestIdentityRateLimiter = getNamedRateLimiter("ingest-identity", 1_000, 10);
const ingestUnauthenticatedRateLimiter = getNamedRateLimiter(
  "ingest-unauthenticated",
  1_000,
  10
);

function wantsUsageTelemetryV2(request: NextRequest): boolean {
  return request.headers.get("x-usage-telemetry-version")?.trim() === "2";
}

function bodyDeclaresUsageTelemetryV2(payload: unknown): boolean {
  return !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { schemaVersion?: unknown }).schemaVersion === 2;
}

function ingestError(
  request: NextRequest,
  status: number,
  code: UsageTelemetryErrorCode,
  message: string,
  options: { retryAfterSeconds?: number; usageTelemetryV2?: boolean } = {}
) {
  const headers = options.retryAfterSeconds == null
    ? undefined
    : { "Retry-After": String(options.retryAfterSeconds) };
  if (!(options.usageTelemetryV2 ?? wantsUsageTelemetryV2(request))) {
    return NextResponse.json({ error: message }, { status, headers });
  }
  return NextResponse.json(
    {
      ok: false,
      schemaVersion: 2,
      error: {
        code,
        message,
        retryable: status === 429 || status >= 500,
        ...(options.retryAfterSeconds == null
          ? {}
          : { retryAfterSeconds: options.retryAfterSeconds }),
      },
    },
    { status, headers }
  );
}

export async function POST(request: NextRequest) {
  let usageTelemetryV2 = wantsUsageTelemetryV2(request);
  const respondError = (
    status: number,
    code: UsageTelemetryErrorCode,
    message: string,
    options: { retryAfterSeconds?: number } = {}
  ) => ingestError(request, status, code, message, {
    ...options,
    usageTelemetryV2,
  });

  const usageToken = process.env.USAGE_INGEST_TOKEN?.trim() ?? "";
  const receiptToken = process.env.BILLING_RECEIPT_INGEST_TOKEN?.trim() ?? "";
  if (!usageToken && !receiptToken) {
    return respondError(503, "not_configured", "Usage ingest is not configured");
  }
  if (usageToken && receiptToken && safeEqual(usageToken, receiptToken)) {
    return respondError(
      503,
      "not_configured",
      "Billing receipt ingest token must be distinct from usage ingest"
    );
  }

  const credential = resolveUsageIngestCredential(request);
  const usageAuthorized = credential !== null;
  const receiptAuthorized = isBillingReceiptIngestAuthorized(request);
  if (!usageAuthorized && !receiptAuthorized) {
    // Unauthenticated traffic: throttle by the topology-aware IP backstop
    // before 401ing, so bad-token hammering can't consume unlimited CPU.
    if (!ingestUnauthenticatedRateLimiter.check(getLoginBackstopKey(request))) {
      return respondError(429, "rate_limited", "Too many requests. Slow down.", {
        retryAfterSeconds: 30,
      });
    }
    return respondError(401, "unauthorized", "Unauthorized");
  }

  // Authenticated traffic: throttle per credential (see limiter comment
  // above), never by the shared Cloudflare egress IP.
  const presentedToken =
    tokenFromRequest(request, "x-usage-ingest-token") ||
    tokenFromRequest(request, "x-billing-receipt-ingest-token");
  if (!ingestIdentityRateLimiter.check(getIngestIdentityRateLimitKey(presentedToken))) {
    return respondError(429, "rate_limited", "Too many requests. Slow down.", {
      retryAfterSeconds: 30,
    });
  }

  // Reject a retry storm before decoding up to 4 MiB of JSON or doing any
  // project/provider lookup. SQLite is single-writer and the incumbent writer
  // remains the only request allowed to consume parsing/DB memory.
  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    void import("@/lib/sentry-ops").then(({ recordIngestAdmissionRejected }) =>
      recordIngestAdmissionRejected({ route: "ingest/usage" })
    );
    return respondError(503, "receiver_busy", "Usage ingest is busy. Retry later.", {
      retryAfterSeconds: INGEST_ADMISSION_RETRY_AFTER_SECONDS,
    });
  }

  try {
    let events: ParsedUsageTelemetryEvent[];
    let v2Rejected = 0;
    let v2Rejections: UsageTelemetryV2EventRejection[] = [];
    try {
      const bytes = await readBoundedRequestBody(request, {
        maxBytes: MAX_USAGE_TELEMETRY_BODY_BYTES,
        label: "Usage ingest payload",
      });
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      usageTelemetryV2 ||= bodyDeclaresUsageTelemetryV2(payload);
      if (usageTelemetryV2) {
        const parsed = await parseUsageTelemetryV2Batch(payload);
        events = parsed.events;
        v2Rejected = parsed.rejected;
        v2Rejections = parsed.rejections;
      } else {
        events = parseUsageTelemetryBatch(payload);
      }
    } catch (error) {
      const bodyTooLarge = error instanceof RequestBodyTooLargeError;
      return respondError(
        bodyTooLarge ? 413 : 400,
        bodyTooLarge ? "payload_too_large" : "invalid_request",
        error instanceof Error ? error.message : "Invalid request"
      );
    }

    // X5: a v2 batch whose events ALL failed per-event validation has nothing
    // to persist — ACK it with rejected === received instead of the old
    // all-or-nothing 400.
    if (usageTelemetryV2 && events.length === 0) {
      void import("@/lib/sentry-ops").then(({ recordIngestEventsRejected }) =>
        recordIngestEventsRejected(v2Rejected, {
          route: "ingest/usage",
          outcome: "all_rejected",
        })
      ).catch(() => undefined);
      return NextResponse.json(
        {
          ok: true,
          schemaVersion: 2,
          received: v2Rejected,
          persisted: 0,
          duplicates: 0,
          pruned: 0,
          rejected: v2Rejected,
          ...(v2Rejections.length > 0 ? { rejections: v2Rejections } : {}),
        },
        { status: 202 }
      );
    }

  // SUBSCRIPTION_SOURCE_APP is reserved for the internal subscription
  // materializer, which writes its own charge events directly via
  // persistExternalUsageEvents (see subscription-materializer.ts) and never
  // goes through this HTTP route. Reject any event that claims it here so an
  // external caller cannot forge a materializer-owned charge that
  // budget-status cross-references by metadata.subscriptionId.
  if (events.some((event) => event.sourceApp === SUBSCRIPTION_SOURCE_APP)) {
    return respondError(
      400,
      "invalid_request",
      `sourceApp "${SUBSCRIPTION_SOURCE_APP}" is reserved`
    );
  }

  if (
    credential?.allowedSourceApps &&
    events.some((e) => !credential.allowedSourceApps!.has(e.sourceApp))
  ) {
    void import("@/lib/sentry-ops").then(({ recordIngestScopeRejected }) =>
      recordIngestScopeRejected({
        route: "ingest/usage",
        dimension: "sourceApp",
        value: events.find((e) => !credential.allowedSourceApps!.has(e.sourceApp))?.sourceApp,
      })
    );
    return respondError(
      403,
      "unauthorized",
      "Credential is not authorized for this producer"
    );
  }

  // Server-owned authority never comes from producer metadata or an unscoped token.
  events = stampBotFleetReceiptCredential(events, credential);

  // Native-vs-local coverage (UM-1636): when a producer's native feed is
  // healthy it already carries the same calls a local transcript collector
  // would send, so the transcript-sourced events are dropped instead of
  // double-counted.  When the native feed is dead the transcript events are
  // kept and the gap is filled.  The dropped events are counted as duplicates
  // in the ACK, because the usage they describe IS already in the ledger.
  const nativeCoverage = await dropEventsCoveredByNative(events);
  if (nativeCoverage.skippedNativeCovered > 0) {
    events = nativeCoverage.events;
  }

  // BotFleet-vs-child coverage: a child harness row the collector tagged as
  // BotFleet-launched is dropped only against an authenticated, exactly
  // reconciled single-call receipt; anything unproven is kept
  // (duplicates over loss).  Counted as duplicates in the ACK, like above.
  const botFleetCoverage = await dropEventsCoveredByBotFleet(events);
  if (botFleetCoverage.skippedBotFleetCovered > 0) {
    events = botFleetCoverage.events;
  }
  const skippedCoveredElsewhere =
    nativeCoverage.skippedNativeCovered + botFleetCoverage.skippedBotFleetCovered;

  // Default-off LiteLLM cost derivation (INGEST_COST_DERIVATION_ENABLED):
  // stamps `_derivedCostUsd` into metadata for unpriced token events whose
  // keyRef resolves in the bundled pricing snapshot. Metadata only —
  // `costUsd` stays null, so pushed-cash and priced/unpriced coverage
  // semantics are untouched. Placed after the reserved-sourceApp guard and
  // before receipt classification: receipt-shaped events are metricType
  // "cost"/unit "usd", which the derivation never matches by construction.
  applyIngestCostDerivation(events);

  const receiptLikeEvents = events.filter(looksLikeReceiptCashEvent);
  if (receiptLikeEvents.length > 0) {
    if (!receiptAuthorized) {
      return respondError(401, "unauthorized", "Unauthorized");
    }
    if (receiptLikeEvents.length !== events.length) {
      return respondError(
        400,
        "invalid_request",
        "Billing receipt and ordinary usage events cannot share a batch"
      );
    }
  } else if (!usageAuthorized) {
    return respondError(401, "unauthorized", "Unauthorized");
  }

    const receiptTargets: Array<{ providerId: string; providerName: string }> = [];
    if (receiptLikeEvents.length > 0) {
      const hmacKey = process.env.BILLING_RECEIPT_HMAC_KEY?.trim() ?? "";
      if (hmacKey.length < 32) {
        return respondError(
          503,
          "not_configured",
          "Billing receipt signature verification is not configured"
        );
      }
      for (const event of receiptLikeEvents) {
        const identity = receiptCashIdentity(event);
        if (!identity || !verifyReceiptCashEvent(event, hmacKey)) {
          return respondError(
            400,
            "invalid_request",
            "Billing receipt event signature or format is invalid"
          );
        }
        receiptTargets.push({
          providerId: identity.providerId,
          providerName: event.provider,
        });
      }
    }
    if (receiptTargets.length > 0) {
      const providerIds = Array.from(
        new Set(receiptTargets.map((target) => target.providerId))
      );
      const providers = await prisma.provider.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, name: true },
      });
      const providerById = new Map(providers.map((provider) => [provider.id, provider]));
      for (const target of receiptTargets) {
        const provider = providerById.get(target.providerId);
        if (
          !provider ||
          canonicalProviderKey(provider.name) !==
            canonicalProviderKey(target.providerName)
        ) {
          return respondError(
            400,
            "invalid_request",
            "Billing receipt provider ID and provider name do not match"
          );
        }
      }
    }

    const persistenceEvents =
      receiptLikeEvents.length > 0
        ? events.map((event) => ({
            ...event,
            metadata: stripReceiptTransportSignature(event.metadata),
          }))
        : events;

    // Resolve any top-level `project` field to a Project.id. Unknown names stay
    // null but are preserved in metadata so a later-created Project can be
    // back-filled.
    const projectIdByName = await resolveProjectIdsByName(
      persistenceEvents
        .map((event) => event.project)
        .filter((name): name is string => !!name)
    );

    let persistResult: Awaited<ReturnType<typeof persistExternalUsageEvents>>;
    try {
      persistResult = await persistExternalUsageEvents(
        persistenceEvents.map((event) => {
          const projectId = event.project
            ? projectIdByName.get(canonicalProjectKey(event.project)) ?? null
            : null;
          // Top-level `project` is authoritative: it is stamped into
          // metadata.project (overwriting any producer-supplied value) AND
          // carried separately as authoritativeProject so the persistence
          // layer's existing-row branch can distinguish an authoritative
          // attribution overwrite (pre-#887 rows stored the producer's raw
          // metadata.project) from a genuine producer-metadata conflict.
          const metadata = event.project
            ? { ...(event.metadata ?? {}), project: event.project }
            : event.metadata;
          return {
            idempotencyKey: event.idempotencyKey,
            sourceApp: event.sourceApp,
            environment: event.environment,
            provider: event.provider,
            service: event.service,
            projectId,
            label: event.label,
            keyRef: event.keyRef,
            billingMode: event.billingMode,
            metricType: event.metricType,
            quantity: event.quantity,
            unit: event.unit,
            costUsd: event.costUsd,
            requests: event.requests,
            credits: event.credits,
            limit: event.limit,
            limitWindow: event.limitWindow,
            tier: event.tier,
            confidence: event.confidence,
            windowStart: event.windowStart,
            windowEnd: event.windowEnd,
            occurredAt: event.occurredAt,
            metadata: metadata as Prisma.InputJsonObject | undefined,
            providerRequestId: event.providerRequestId,
            authoritativeProject: event.project,
          };
        })
      );
    } catch (error) {
      if (error instanceof ExternalUsageIdempotencyCollisionError) {
        return respondError(409, "idempotency_conflict", error.message);
      }
      if (error instanceof NegativeSubscriptionWindowLimitExceededError) {
        // Cumulative negative-adjustment window bound (see
        // external-usage-events.ts): a policy rejection of the whole batch,
        // not a server fault — non-retryable 400 so producers don't loop.
        return respondError(400, "invalid_request", error.message);
      }
      throw error;
    }

    // UM-1592: single-call events that carried the typed `ai` block also land
    // one row each in the per-request AiRequest store (UM-1590).  Best effort:  the usage
    // event above is the record of truth and is already persisted, so a store
    // failure is logged rather than failing the ACK.  Replays are duplicates.
    await persistIngestAiRequests(persistenceEvents);

    // Wave F / E7: soft-stale budget SWR after new rows (keep last-good; force
    // background refresh). Skip pure idempotent replays with zero inserts.
    if (persistResult.persisted > 0) {
      markBudgetStatusSoftStale();
      void fanoutPersistedUsage(
        persistResult.newEvents.map((event) => ({
          provider: event.provider,
          sourceApp: event.sourceApp,
          model: event.keyRef,
          costUsd: event.costUsd,
        })),
        "ingest/usage"
      );
    }

    if (usageTelemetryV2) {
      if (v2Rejected > 0) {
        void import("@/lib/sentry-ops").then(({ recordIngestEventsRejected }) =>
          recordIngestEventsRejected(v2Rejected, {
            route: "ingest/usage",
            outcome: "partial",
          })
        ).catch(() => undefined);
      }
      const duplicates = Math.max(
        0,
        persistResult.attempted -
          persistResult.persisted -
          persistResult.skippedPrunedDuplicates +
          skippedCoveredElsewhere
      );
      return NextResponse.json(
        {
          ok: true,
          schemaVersion: 2,
          // `received` counts every submitted event (valid + rejected), so the
          // shared ACK invariant holds: persisted + duplicates + pruned +
          // rejected === received.  The native-covered and BotFleet-covered
          // events are counted as duplicates: they were not stored twice
          // because another feed already carries that usage.
          received:
            persistResult.attempted + v2Rejected + skippedCoveredElsewhere,
          persisted: persistResult.persisted,
          duplicates,
          pruned: persistResult.skippedPrunedDuplicates,
          rejected: v2Rejected,
          ...(v2Rejections.length > 0 ? { rejections: v2Rejections } : {}),
        },
        { status: 202 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        accepted: persistResult.persisted,
        // X7: additive replay visibility for legacy v1 consumers — `accepted`
        // stays "newly inserted rows" (unchanged semantics), while `received`
        // and `duplicates` now make a full idempotent replay visible instead
        // of ACKing accepted: 0.
        received: persistResult.attempted,
        duplicates: Math.max(
          0,
          persistResult.attempted -
            persistResult.persisted -
            persistResult.skippedPrunedDuplicates
        ),
        ignoredPruned: persistResult.skippedPrunedDuplicates,
      },
      { status: 202 }
    );
  } catch (error) {
    const contentionCode = sqliteWriteContentionCode(error);
    if (contentionCode) {
      console.warn("[ingest/usage] SQLite writer busy:", contentionCode);
      return respondError(503, "receiver_busy", "Usage ingest is busy. Retry later.", {
        retryAfterSeconds: INGEST_ADMISSION_RETRY_AFTER_SECONDS,
      });
    }
    // X6: any non-collision persistence/unexpected failure must surface as the
    // typed contract error, not an untyped HTML 500.
    console.error(
      "[ingest/usage] unhandled failure:",
      error instanceof Error ? error.message : error
    );
    const { logIngestFailed } = await import("@/lib/sentry-ops");
    void logIngestFailed({
      reason: error instanceof Error ? error.name : "unknown",
      route: "ingest/usage",
    });
    return respondError(500, "internal_error", "Internal error", {
      retryAfterSeconds: 30,
    });
  } finally {
    // This lease starts before parsing, so it covers every early validation
    // response as well as all SQLite failures.
    releaseAdmission();
  }
}

async function persistIngestAiRequests(
  events: Array<{
    idempotencyKey: string;
    sourceApp: string;
    project?: string;
    costUsd?: number;
    requests?: number;
    windowStart?: Date;
    windowEnd?: Date;
    occurredAt: Date;
    metadata?: Record<string, string | number | boolean | null>;
  }>
): Promise<void> {
  const { aiRequestFromUsageEvent } = await import("@/lib/ai-usage-metadata");
  const requests = events
    .map((event) => aiRequestFromUsageEvent(event))
    .filter((request): request is NonNullable<typeof request> => request !== null);
  if (requests.length === 0) return;
  try {
    const { persistAiRequests } = await import("@/lib/ai-requests");
    const result = await persistAiRequests(requests);
    if (result.inserted + result.merged > 0) {
      const { fanoutAiRequests } = await import("@/lib/usage-fanout");
      void fanoutAiRequests(result.persistedInputs ?? requests, "ingest/usage");
    }
  } catch (error) {
    console.error(
      "[ingest/usage] failed to persist AI requests:",
      error instanceof Error ? error.message : error
    );
  }
}
