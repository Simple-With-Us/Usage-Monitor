import { NextRequest, NextResponse } from "next/server";
import { resolveUsageIngestCredential } from "@/lib/ingest-auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { decodeLogsJson } from "@/lib/otlp/json-decode";
import { decodeLogsProtobuf } from "@/lib/otlp/protobuf-decode";
import { readBoundedBody } from "@/lib/otlp/validation";
import { mapOtlpLogsToAiRequests } from "@/lib/otlp/ai-request-mapper";
import {
  INGEST_ADMISSION_RETRY_AFTER_SECONDS,
  tryAcquireIngestAdmission,
} from "@/lib/ingest-admission";
import type { OtlpExportLogsServiceRequest } from "@/lib/otlp/types";

// OTLP-HTTP logs ingest: POST /api/otlp/v1/logs
//
// Per-request events are stored; everything else is accept-and-drop.
//
// Stored (UM-1590), one AiRequest row per model call, via
// src/lib/otlp/ai-request-mapper.ts and src/lib/ai-requests.ts:
//   - claude_code.api_request (model, duration, tokens incl. cache read and
//     cache creation, cost_usd, request_id, speed, effort, query_source)
//   - codex.api_request / codex.websocket_request, stitched to the later
//     codex.sse_event response.completed that carries the token counts
// Only allowlisted scalar attributes are read.  Prompt and response bodies,
// user.email and every other attribute are never stored.
//
// Dropped (unchanged since the stub): user_prompt, tool_result, tool_decision,
// api_error, api_request_body and every other log record.  They are
// free-text-shaped, and errors/health live in Sentry per the owner's goal
// split.  Do not overload ExternalUsageEvent with log rows: its consumers
// (budget-status, rollups) assume one row = one usage/cost observation, and
// AiRequest is diagnostic only, so it can never double count the ledger that
// /api/otlp/v1/metrics feeds.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const otlpLogsRateLimiter = createRateLimiter(1_000, 20);

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const ip = getClientIp(request);
  if (!otlpLogsRateLimiter.check(ip)) {
    return NextResponse.json({ error: "Too many requests. Slow down." }, { status: 429 });
  }

  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  let parsed: OtlpExportLogsServiceRequest;
  try {
    const bytes = await readBoundedBody(request);
    if (contentType === "" || contentType === "application/json") {
      parsed = decodeLogsJson(JSON.parse(new TextDecoder().decode(bytes)));
    } else if (contentType === "application/x-protobuf" || contentType === "application/protobuf") {
      parsed = decodeLogsProtobuf(bytes);
    } else {
      return NextResponse.json(
        {
          error: `Unsupported Content-Type "${contentType}" for OTLP logs ingest. Use application/json or application/x-protobuf.`,
        },
        { status: 415 }
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid OTLP payload";
    return NextResponse.json(
      { error: message },
      { status: message.includes("exceeds") ? 413 : 400 }
    );
  }

  const logRecordCount = countLogRecords(parsed.resourceLogs);
  const mapped = mapOtlpLogsToAiRequests(parsed);
  if (mapped.requests.length === 0) {
    return NextResponse.json(
      { ok: true, accepted: 0, received: logRecordCount, stored: false },
      { status: 202 }
    );
  }

  if (credential.allowedSourceApps) {
    const unauthorized = mapped.requests.find((r) => !credential.allowedSourceApps!.has(r.harness));
    if (unauthorized) {
      void import("@/lib/sentry-ops").then(({ recordIngestScopeRejected }) =>
        recordIngestScopeRejected({
          route: "otlp/v1/logs",
          dimension: "harness",
          value: unauthorized.harness,
        })
      );
      return NextResponse.json(
        { error: `Credential is not authorized for harness "${unauthorized.harness}"` },
        { status: 403 }
      );
    }
  }

  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    void import("@/lib/sentry-ops").then(({ recordIngestAdmissionRejected }) =>
      recordIngestAdmissionRejected({ route: "otlp/v1/logs" })
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
    const { persistAiRequests } = await import("@/lib/ai-requests");
    const result = await persistAiRequests(mapped.requests);
    if (result.inserted + result.merged > 0) {
      const { fanoutAiRequests } = await import("@/lib/usage-fanout");
      void fanoutAiRequests(mapped.requests, "otlp/v1/logs");
    }
    return NextResponse.json(
      {
        ok: true,
        received: logRecordCount,
        accepted: result.inserted + result.merged,
        inserted: result.inserted,
        merged: result.merged,
        duplicates: result.duplicates,
        stored: result.inserted + result.merged > 0,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error(
      "[otlp/logs] failed to persist AI requests:",
      error instanceof Error ? error.message : error
    );
    try {
      const { logIngestFailed } = await import("@/lib/sentry-ops");
      void logIngestFailed({
        reason: error instanceof Error ? error.name : "unknown",
        route: "otlp/v1/logs",
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  } finally {
    releaseAdmission();
  }
}

function countLogRecords(resourceLogs: { scopeLogs?: { logRecords?: unknown[] }[] }[] | undefined): number {
  let count = 0;
  for (const resource of resourceLogs ?? []) {
    for (const scope of resource.scopeLogs ?? []) {
      count += scope.logRecords?.length ?? 0;
    }
  }
  return count;
}
