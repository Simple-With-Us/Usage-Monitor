import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-turns?platform=cursor-agent&limit=50
 *
 * Recent per-turn rows from POST /api/otlp/v1/traces for the Agents tab.
 * Dual-auth like /api/agents-overview: dashboard session cookie OR bearer
 * USAGE_READ_TOKEN. Prompt/response text is already truncated at ingest
 * (4000 chars) and expires via contentExpiresAt; rows are newest-first.
 */
export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isSessionAuth = sessionCookie ? verifySessionToken(sessionCookie) : false;
  if (!isSessionAuth && !isUsageReadAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Connect a valid dashboard session or USAGE_READ_TOKEN." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform")?.trim().toLowerCase() || undefined;
  const limitRaw = Number(searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;

  try {
    const turns = await prisma.agentTurn.findMany({
      where: platform ? { platform } : undefined,
      orderBy: { occurredAt: "desc" },
      take: limit,
      select: {
        id: true,
        platform: true,
        seat: true,
        repo: true,
        conversationId: true,
        generationId: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheTokens: true,
        costUsd: true,
        durationMs: true,
        toolCount: true,
        toolNames: true,
        error: true,
        promptText: true,
        responseText: true,
        occurredAt: true,
      },
    });
    return NextResponse.json({ ok: true, turns });
  } catch (error) {
    console.error("[agent-turns] failed to list turns:", error);
    return NextResponse.json({ ok: false, error: "Failed to list agent turns" }, { status: 500 });
  }
}
