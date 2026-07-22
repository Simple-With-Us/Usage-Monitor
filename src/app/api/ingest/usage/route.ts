import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type { UsageTelemetryErrorCode } from "@jaywedgeworth22/congress-trading-shared";
import { prisma } from "@/lib/prisma";
import {
  ExternalUsageIdempotencyCollisionError,
  persistExternalUsageEvents,
  syncStatusToUsageSnapshot,
} from "@/lib/external-usage-events";
import {
  MAX_USAGE_TELEMETRY_BODY_BYTES,
  parseUsageTelemetryBatch,
  parseUsageTelemetryV2Batch,
} from "@/lib/usage-telemetry";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import {
  isBillingReceiptIngestAuthorized,
  isUsageIngestAuthorized,
  safeEqual,
} from "@/lib/ingest-auth";
import { resolveProjectIdsByName } from "@/lib/project-resolver";
import { canonicalProjectKey } from "@/lib/provider-identity";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 10 requests per second per source IP — generous enough for normal
// fire-and-forget telemetry pushes while preventing abuse.
const ingestRateLimiter = createRateLimiter(1_000, 10);

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

  const ip = getClientIp(request);
  if (!ingestRateLimiter.check(ip)) {
    return respondError(429, "rate_limited", "Too many requests. Slow down.", {
      retryAfterSeconds: 30,
    });
  }

  const usageAuthorized = isUsageIngestAuthorized(request);
  const receiptAuthorized = isBillingReceiptIngestAuthorized(request);
  if (!usageAuthorized && !receiptAuthorized) {
    return respondError(401, "unauthorized", "Unauthorized");
  }

  // Reject a retry storm before decoding up to 4 MiB of JSON or doing any
  // project/provider lookup. SQLite is single-writer and the incumbent writer
  // remains the only request allowed to consume parsing/DB memory.
  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    return respondError(503, "receiver_busy", "Usage ingest is busy. Retry later.", {
      retryAfterSeconds: INGEST_ADMISSION_RETRY_AFTER_SECONDS,
    });
  }

  try {
    let events;
    try {
      const bytes = await readBoundedRequestBody(request, {
        maxBytes: MAX_USAGE_TELEMETRY_BODY_BYTES,
        label: "Usage ingest payload",
      });
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      usageTelemetryV2 ||= bodyDeclaresUsageTelemetryV2(payload);
      events = usageTelemetryV2
        ? await parseUsageTelemetryV2Batch(payload)
        : parseUsageTelemetryBatch(payload);
    } catch (error) {
      const bodyTooLarge = error instanceof RequestBodyTooLargeError;
      return respondError(
        bodyTooLarge ? 413 : 400,
        bodyTooLarge ? "payload_too_large" : "invalid_request",
        error instanceof Error ? error.message : "Invalid request"
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
          const metadata =
            event.project && !(event.metadata && "project" in event.metadata)
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
          };
        })
      );
    } catch (error) {
      if (error instanceof ExternalUsageIdempotencyCollisionError) {
        return respondError(409, "idempotency_conflict", error.message);
      }
      throw error;
    }

    // Cross-app status metrics integration: Generate UsageSnapshot rows for absolute metrics.
    await syncStatusToUsageSnapshot(persistResult.newEvents);

    // Wave F / E7: soft-stale budget SWR after new rows (keep last-good; force
    // background refresh). Skip pure idempotent replays with zero inserts.
    if (persistResult.persisted > 0) {
      markBudgetStatusSoftStale();
    }

    if (usageTelemetryV2) {
      const duplicates = Math.max(
        0,
        persistResult.attempted - persistResult.persisted - persistResult.skippedPrunedDuplicates
      );
      return NextResponse.json(
        {
          ok: true,
          schemaVersion: 2,
          received: persistResult.attempted,
          persisted: persistResult.persisted,
          duplicates,
          pruned: persistResult.skippedPrunedDuplicates,
          rejected: 0,
        },
        { status: 202 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        accepted: persistResult.persisted,
        ignoredPruned: persistResult.skippedPrunedDuplicates,
      },
      { status: 202 }
    );
  } finally {
    // This lease starts before parsing, so it covers every early validation
    // response as well as all SQLite failures.
    releaseAdmission();
  }
}
