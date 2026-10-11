import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { ExternalUsageIdempotencyCollisionError } from "@/lib/external-usage-events";
import {
  isUsageIngestAuthorized,
  resolveUsageIngestCredential,
  tokenFromRequest,
} from "@/lib/ingest-auth";
import {
  getIngestIdentityRateLimitKey,
  getLoginBackstopKey,
  getNamedRateLimiter,
} from "@/lib/rate-limit";
import { decodeMetricsJson } from "@/lib/otlp/json-decode";
import { decodeMetricsProtobuf } from "@/lib/otlp/protobuf-decode";
import { BoundedLogOnce } from "@/lib/otlp/bounded-log-once";
import { mapClaudeCodeMetrics } from "@/lib/otlp/claude-code-mapper";
import { mapGenAiMetrics } from "@/lib/otlp/gen-ai-mapper";
import { mapSystemMetrics } from "@/lib/otlp/system-mapper";
import { ensureAnthropicProviderSeeded } from "@/lib/otlp/ensure-anthropic-provider";
import { resolveProjectIdsByName } from "@/lib/project-resolver";
import { canonicalProjectKey } from "@/lib/provider-identity";
import {
  OtlpMetricStateCapacityError,
  persistOtlpUsageEvents,
} from "@/lib/otlp/cumulative-state";
import { readBoundedBody, validateMetricsRequest } from "@/lib/otlp/validation";
import {
  INGEST_ADMISSION_RETRY_AFTER_SECONDS,
  isOtlpMetricsIngestEnabled,
  isOtlpSystemMetricsIngestEnabled,
  OTLP_METRICS_DISABLED_RETRY_AFTER_SECONDS,
  tryAcquireIngestAdmission,
} from "@/lib/ingest-admission";
import { markBudgetStatusSoftStale } from "@/lib/budget-status";
import { fanoutPersistedUsage } from "@/lib/usage-fanout";

// OTLP-HTTP metrics ingest: POST /api/otlp/v1/metrics
//
// This is the standard OTLP-HTTP receiver path (the "/v1/metrics" suffix is
// part of the OTLP spec itself, not app-specific routing:
// https://opentelemetry.io/docs/specs/otlp/#otlphttp-request). Point Claude
// Code (or any OTLP exporter) at this with:
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://usage.jays.services/api/otlp
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json   (or http/protobuf)
//   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <USAGE_INGEST_TOKEN>
//
// Encodings accepted:
//   - Content-Type: application/json         -> decodeMetricsJson (primary target)
//   - Content-Type: application/x-protobuf    -> decodeMetricsProtobuf
// NOT accepted: gRPC (OTEL_EXPORTER_OTLP_PROTOCOL=grpc, Claude Code's
// default). gRPC needs HTTP/2 + trailers, which a plain Next.js Route
// Handler cannot terminate. A gRPC-configured client gets a 415 with a
// message pointing at the two supported protocol env var values, rather
// than a confusing hang/connection-reset.
//
// Auth: identical bearer/header scheme to POST /api/ingest/usage
// (Authorization: Bearer <USAGE_INGEST_TOKEN>, or x-usage-ingest-token
// header) — see src/lib/ingest-auth.ts.
//
// Idempotency: OTLP exporters retry an entire export batch on transient
// failure (e.g. a 5xx or timeout), which would double-count usage/cost on
// naive insert. Every mapped row's idempotencyKey is a hash of the metric
// name + all resource/point attributes + the data point's time window +
// its value (see claude-code-mapper.ts's deriveIdempotencyKey) and rows are
// upserted on that key exactly like the existing usage-ingest route, so a
// byte-identical retry is a no-op.
//
// Sum temporality: delta points are additive as sent. Cumulative points are
// converted to adjacent deltas using OtlpMetricState checkpoints written in
// the same transaction as usage rows; resets are detected by start time/value,
// and points at or behind the checkpoint are ignored as out-of-order.
//
// Unknown metrics: never rejected or 500'd. mapClaudeCodeMetrics tallies any
// metric name outside the known Claude Code set and this route logs it once
// per request (not once per data point, to avoid log-spam from a single
// unrecognized high-cardinality metric) via console.warn — future Claude
// Code releases that add new metrics degrade to "ignored" rather than
// breaking ingest.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same generosity as /api/ingest/usage: OTLP exporters batch on a fixed
// interval (default 60s) rather than per-event, so request volume is low,
// but keep a rate limiter for the same abuse-prevention reasons.
//
// Like /api/ingest/usage (X1), limiting runs AFTER authentication and is
// keyed on identity: authenticated requests get a per-credential bucket (a
// SHA-256 of the presented token — every OTLP producer arrives through
// Cloudflare's shared egress IP, so the old pre-auth per-IP bucket let one
// source 429 every producer), while unauthenticated requests are throttled
// by the topology-aware IP backstop (getLoginBackstopKey).
const otlpMetricsIdentityRateLimiter = getNamedRateLimiter(
  "otlp-metrics-identity",
  1_000,
  10
);
const otlpMetricsUnauthenticatedRateLimiter = getNamedRateLimiter(
  "otlp-metrics-unauthenticated",
  1_000,
  10
);

const loggedUnknownMetrics = new BoundedLogOnce(1_000);

function unsupportedProtocolResponse(contentType: string) {
  return NextResponse.json(
    {
      error:
        `Unsupported Content-Type "${contentType}" for OTLP metrics ingest. ` +
        "Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json or http/protobuf (gRPC is not supported by this endpoint).",
    },
    { status: 415 }
  );
}

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ingestEnabled = isOtlpMetricsIngestEnabled();
  const rateLimitedResponse = () =>
    NextResponse.json(
      { error: "Too many requests. Slow down." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            ingestEnabled ? 30 : OTLP_METRICS_DISABLED_RETRY_AFTER_SECONDS
          ),
        },
      }
    );

  // Authenticate first, then rate-limit on identity (see limiter comment).
  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    if (!otlpMetricsUnauthenticatedRateLimiter.check(getLoginBackstopKey(request))) {
      return rateLimitedResponse();
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const presentedToken = tokenFromRequest(request, "x-usage-ingest-token");
  if (!otlpMetricsIdentityRateLimiter.check(getIngestIdentityRateLimitKey(presentedToken))) {
    return rateLimitedResponse();
  }

  if (!ingestEnabled) {
    return NextResponse.json(
      { error: "OTLP metrics ingest is temporarily disabled. Retry later." },
      {
        status: 503,
        headers: {
          "Retry-After": String(OTLP_METRICS_DISABLED_RETRY_AFTER_SECONDS),
        },
      }
    );
  }

  // NOTE: scoped-credential enforcement happens post-mapping below (per
  // mapped sourceApp, covering claude_code.*, system.*, and generic gen_ai
  // rows alike), so gen_ai-scoped producer tokens are honored without a
  // pre-parse allowlist that would need to enumerate every platform.

  // Do not parse/map a potentially large exporter batch while another usage
  // write owns SQLite. Returning the producer-visible backpressure response
  // before body allocation is what prevents retry storms from recreating the
  // receiver's memory/CPU failure mode.
  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    void import("@/lib/sentry-ops").then(({ recordIngestAdmissionRejected }) =>
      recordIngestAdmissionRejected({ route: "otlp/v1/metrics" })
    );
    return NextResponse.json(
      { error: "Usage ingest is busy. Retry later." },
      {
        status: 503,
        headers: { "Retry-After": String(INGEST_ADMISSION_RETRY_AFTER_SECONDS) },
      }
    );
  }

  try {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let parsed;
    try {
      const bytes = await readBoundedBody(request);
      if (contentType === "" || contentType === "application/json") {
        parsed = decodeMetricsJson(JSON.parse(new TextDecoder().decode(bytes)));
      } else if (contentType === "application/x-protobuf" || contentType === "application/protobuf") {
        parsed = decodeMetricsProtobuf(bytes);
      } else {
        return unsupportedProtocolResponse(contentType);
      }
      validateMetricsRequest(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid OTLP payload";
      return NextResponse.json(
        { error: message },
        { status: message.includes("exceeds") ? 413 : 400 }
      );
    }

  const claudeResult = mapClaudeCodeMetrics(parsed);
  const systemResult = mapSystemMetrics(parsed);
  // Wave G / E9: system.* host metrics are opt-in (default off) so an OTLP
  // exporter that also ships host gauges cannot flood ExternalUsageEvent /
  // mis-attribute cash under the hardcoded "hetzner" provider label.
  const systemMetricsPersistEnabled = isOtlpSystemMetricsIngestEnabled();
  const systemEvents = systemMetricsPersistEnabled ? systemResult.events : [];
  const ignoredSystemMetrics = systemMetricsPersistEnabled
    ? 0
    : systemResult.events.length;

  // Generic gen_ai mapper (fleet-telemetry-relay path). Overlap platforms
  // with an exact local JSONL collector are skipped inside the mapper
  // unless OTLP_GEN_AI_ALLOW_OVERLAP=1 / allowlisted, so one turn cannot
  // land twice in the ledger.
  const genAiResult = mapGenAiMetrics(parsed);

  const events = [...claudeResult.events, ...systemEvents, ...genAiResult.events];

  if (credential.allowedSourceApps) {
    const unauthorizedEvent = events.find(
      (e) => !credential.allowedSourceApps!.has(e.sourceApp)
    );
    if (unauthorizedEvent) {
      return NextResponse.json(
        { error: `Credential is not authorized for sourceApp "${unauthorizedEvent.sourceApp}"` },
        { status: 403 }
      );
    }
  }

  // A metric is only truly "unknown" if no mapper understood it.
  const unknownMetrics = claudeResult.unknownMetrics.filter(
    (claudeUnknown) =>
      systemResult.unknownMetrics.some((systemUnknown) => systemUnknown.name === claudeUnknown.name) &&
      genAiResult.unknownMetrics.some((genAiUnknown) => genAiUnknown.name === claudeUnknown.name)
  );

  for (const unknown of unknownMetrics) {
    const key = unknown.name;
    if (loggedUnknownMetrics.remember(key)) {
      console.warn(
        `[otlp/metrics] unrecognized metric "${unknown.name}" (${unknown.dataPointCount} data point(s) this request) — accepted, not mapped`
      );
    }
  }

  let skippedPrunedDuplicates = 0;
  let ignoredOutOfOrder = 0;
  let idempotentRetries = 0;
  let accepted = 0;
  if (events.length > 0) {
      // Resolve any `project` resource attribute (OTEL_RESOURCE_ATTRIBUTES) to a
      // Project.id. Unknown names stay null; the allowlisted raw project name is
      // preserved in metadata so a later-created Project can be back-filled.
      const projectIdByName = await resolveProjectIdsByName(
        events.map((event) => event.projectName).filter((name): name is string => !!name)
      );

      let persistResult: Awaited<ReturnType<typeof persistOtlpUsageEvents>>;
      try {
        persistResult = await persistOtlpUsageEvents(
          events.map((event) => ({
            point: event.otlp,
            event: {
              idempotencyKey: event.idempotencyKey,
              sourceApp: event.sourceApp,
              environment: event.environment,
              provider: event.provider,
              service: event.service,
              projectId: event.projectName
                ? projectIdByName.get(canonicalProjectKey(event.projectName)) ?? null
                : null,
              label: event.label,
              keyRef: event.keyRef,
              billingMode: event.billingMode,
              metricType: event.metricType,
              quantity: event.quantity,
              unit: event.unit,
              costUsd: event.costUsd,
              requests: event.requests,
              occurredAt: event.occurredAt,
              metadata: (event.projectName
                ? { ...(event.metadata ?? {}), project: event.projectName }
                : event.metadata) as Prisma.InputJsonObject,
            },
          }))
        );
      } catch (error) {
        if (error instanceof ExternalUsageIdempotencyCollisionError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        if (error instanceof OtlpMetricStateCapacityError) {
          return NextResponse.json(
            { error: error.message, limit: error.limit },
            { status: 503, headers: { "Retry-After": "900" } }
          );
        }
        throw error;
      }
      skippedPrunedDuplicates = persistResult.skippedPrunedDuplicates;
      ignoredOutOfOrder = persistResult.ignoredOutOfOrder;
      idempotentRetries = persistResult.idempotentRetries;
      accepted = persistResult.persisted + idempotentRetries;

      // Wave F / E7: soft-stale budget SWR after newly persisted OTLP rows.
      if (persistResult.persisted > 0) {
        markBudgetStatusSoftStale();
        void fanoutPersistedUsage(
          persistResult.newEvents.map((event) => ({
            provider: event.provider,
            sourceApp: event.sourceApp,
            model: event.keyRef,
            costUsd: event.costUsd,
          })),
          "otlp/v1/metrics"
        );
      }

      // Best-effort: give the owner a Provider row to attach a budget to (see
      // ensure-anthropic-provider.ts for why this is lazy-on-first-ingest
      // rather than a one-off seed script, and why it's a no-op if an
      // "anthropic" provider already exists from the poll adapter). Never lets
      // a seeding failure fail the ingest itself — the usage row above is
      // already durably written by this point.
      try {
        await ensureAnthropicProviderSeeded();
      } catch (error) {
        console.warn(
          "[otlp/metrics] failed to seed anthropic provider row (non-fatal):",
          error instanceof Error ? error.message : error
        );
      }
  }

  return NextResponse.json(
    {
      ok: true,
      accepted,
      ignoredPruned: skippedPrunedDuplicates || undefined,
      ignoredOutOfOrder: ignoredOutOfOrder || undefined,
      idempotentRetries: idempotentRetries || undefined,
      // Dropped system.* points when OTLP_SYSTEM_METRICS_INGEST_ENABLED is off.
      ignoredSystemMetrics: ignoredSystemMetrics || undefined,
      // gen_ai points skipped because the platform already has a JSONL collector
      // (or is outside OTLP_GEN_AI_PLATFORM_ALLOWLIST).
      ignoredOverlap: genAiResult.ignoredOverlap || undefined,
      unknownMetrics: unknownMetrics.length > 0 ? unknownMetrics : undefined,
    },
    { status: 202 }
  );
  } catch (error) {
    // X6: unexpected failures (e.g. non-collision persistence errors) surface
    // as a typed, retryable contract error — never an untyped HTML 500.
    console.error(
      "[otlp/metrics] unhandled failure:",
      error instanceof Error ? error.message : error
    );
    // Audit 2026-09-20 (board item c0fe8d9c): the ingest/usage sibling route
    // emits ingest.failed via Sentry.logger + Sentry.metrics + the fleet-infra
    // mirror. Mirror the same observability here so the OTLP path is not a
    // silent failure sink (Codex re-review found the same gap on the
    // beforeSend hooks; this is the same shape, different layer).
    try {
      const { logIngestFailed } = await import("@/lib/sentry-ops");
      void logIngestFailed({
        reason: error instanceof Error ? error.name : "unknown",
        route: "otlp/v1/metrics",
      });
    } catch {
      // Sentry is best-effort; never let observability break the response.
    }
    return NextResponse.json(
      {
        ok: false,
        schemaVersion: 2,
        error: {
          code: "internal_error",
          message: "Internal error",
          retryable: true,
          retryAfterSeconds: 30,
        },
      },
      { status: 500, headers: { "Retry-After": "30" } }
    );
  } finally {
    releaseAdmission();
  }
}
