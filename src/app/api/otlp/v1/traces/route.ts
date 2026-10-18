import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  resolveUsageIngestCredential,
  tokenFromRequest,
} from "@/lib/ingest-auth";
import {
  getIngestIdentityRateLimitKey,
  getLoginBackstopKey,
  getNamedRateLimiter,
} from "@/lib/rate-limit";
import { readBoundedBody } from "@/lib/otlp/validation";
import {
  mapDirectTurnsRequest,
  mapOtlpTracesRequest,
} from "@/lib/otlp/traces-mapper";
import {
  INGEST_ADMISSION_RETRY_AFTER_SECONDS,
  tryAcquireIngestAdmission,
} from "@/lib/ingest-admission";
import { fanoutAgentTurns } from "@/lib/usage-fanout";

// OTLP-HTTP traces ingest: POST /api/otlp/v1/traces
//
// Accepts standard OTLP-JSON `{ resourceSpans: [...] }` (gen_ai semconv span
// attributes) or a direct relay payload `{ turns: [...] }` for producers
// without an OTLP span pipeline (e.g. the hook shim v2). Persists per-turn
// rows to AgentTurn — diagnostic/per-turn analytics ONLY — and Claude Code
// claude_code.llm_request spans to AiRequest (per model call, UM-1590). This route never
// writes ExternalUsageEvent, so token/cost ledger math (budgets, rollups,
// llm-burn) cannot double count against /api/otlp/v1/metrics or the local
// JSONL collectors that already feed the ledger.
//
// Auth/rate-limit/admission mirror the sibling metrics route: same bearer
// scheme (USAGE_INGEST_TOKEN / per-producer scoped tokens), identity-keyed
// rate limiting, and the shared process-global SQLite admission token
// (503 + Retry-After instead of queueing). Only application/json is
// accepted; protobuf/gRPC get a 415 pointing at json.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const otlpTracesIdentityRateLimiter = getNamedRateLimiter("otlp-traces-identity", 1_000, 10);
const otlpTracesUnauthenticatedRateLimiter = getNamedRateLimiter(
  "otlp-traces-unauthenticated",
  1_000,
  10
);

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    if (!otlpTracesUnauthenticatedRateLimiter.check(getLoginBackstopKey(request))) {
      return NextResponse.json(
        { error: "Too many requests. Slow down." },
        { status: 429, headers: { "Retry-After": "30" } }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const presentedToken = tokenFromRequest(request, "x-usage-ingest-token");
  if (!otlpTracesIdentityRateLimiter.check(getIngestIdentityRateLimitKey(presentedToken))) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }

  const releaseAdmission = tryAcquireIngestAdmission();
  if (!releaseAdmission) {
    void import("@/lib/sentry-ops").then(({ recordIngestAdmissionRejected }) =>
      recordIngestAdmissionRejected({ route: "otlp/v1/traces" })
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
    if (
      contentType !== "" &&
      contentType !== "application/json"
    ) {
      return NextResponse.json(
        {
          error:
            `Unsupported Content-Type "${contentType}" for OTLP traces ingest. ` +
            "Send application/json (OTLP-HTTP JSON resourceSpans or a { turns: [...] } relay payload).",
        },
        { status: 415 }
      );
    }

    let body: unknown;
    try {
      const bytes = await readBoundedBody(request);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid OTLP payload";
      return NextResponse.json(
        { error: message },
        { status: message.includes("exceeds") ? 413 : 400 }
      );
    }

    const hasSpans =
      !!body && typeof body === "object" && Array.isArray((body as { resourceSpans?: unknown }).resourceSpans);
    const hasTurns =
      !!body && typeof body === "object" && Array.isArray((body as { turns?: unknown }).turns);
    if (!hasSpans && !hasTurns) {
      return NextResponse.json(
        { error: "Invalid OTLP traces payload: expected { resourceSpans: [...] } or { turns: [...] }" },
        { status: 400 }
      );
    }

    const mapped = hasSpans ? mapOtlpTracesRequest(body) : mapDirectTurnsRequest(body);

    if (credential.allowedSourceApps) {
      const unauthorized = mapped.turns.find((t) => !credential.allowedSourceApps!.has(t.platform));
      if (unauthorized) {
        return NextResponse.json(
          { error: `Credential is not authorized for platform "${unauthorized.platform}"` },
          { status: 403 }
        );
      }
      const unauthorizedRequest = mapped.aiRequests.find(
        (r) => !credential.allowedSourceApps!.has(r.harness)
      );
      if (unauthorizedRequest) {
        return NextResponse.json(
          { error: `Credential is not authorized for harness "${unauthorizedRequest.harness}"` },
          { status: 403 }
        );
      }
    }

    let persisted = 0;
    if (mapped.turns.length > 0) {
      const result = await prisma.agentTurn.createMany({
        data: mapped.turns.map((t) => ({
          platform: t.platform,
          seat: t.seat,
          repo: t.repo,
          conversationId: t.conversationId,
          generationId: t.generationId,
          model: t.model,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cacheTokens: t.cacheTokens,
          costUsd: t.costUsd,
          durationMs: t.durationMs,
          toolCount: t.toolCount ?? 0,
          toolNames: t.toolNames ?? undefined,
          error: t.error,
          promptText: t.promptText,
          responseText: t.responseText,
          occurredAt: t.occurredAt,
          contentExpiresAt: t.contentExpiresAt,
        })),
      });
      persisted = result.count;
      void fanoutAgentTurns(mapped.turns);
    }

    // claude_code.llm_request spans -> AiRequest (UM-1590).  Upserts on the
    // same request_id key as the api_request log event, so a request reported
    // by both signals stays one row and the span adds ttft_ms.
    let aiRequests: number | undefined;
    if (mapped.aiRequests.length > 0) {
      const { persistAiRequests } = await import("@/lib/ai-requests");
      const result = await persistAiRequests(mapped.aiRequests);
      aiRequests = result.inserted + result.merged;
    }

    return NextResponse.json(
      {
        ok: true,
        accepted: persisted,
        aiRequests,
        ignored: mapped.ignored || undefined,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error(
      "[otlp/traces] unhandled failure:",
      error instanceof Error ? error.message : error
    );
    try {
      const { logIngestFailed } = await import("@/lib/sentry-ops");
      void logIngestFailed({
        reason: error instanceof Error ? error.name : "unknown",
        route: "otlp/v1/traces",
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  } finally {
    releaseAdmission();
  }
}
