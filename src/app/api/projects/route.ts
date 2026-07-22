import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeProjectBudgetStatus, bustBudgetStatusCache } from "@/lib/budget-status";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { backfillProjectIdFromMetadataName } from "@/lib/project-resolver";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const status = await computeProjectBudgetStatus();
    if (request.nextUrl.searchParams.get("includeSummary") === "1") {
      return NextResponse.json({ projects: status.projects, summary: status.summary });
    }
    return NextResponse.json(status.projects);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  // Wave G / E18: defense-in-depth session re-check (middleware also gates).
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name, description, monthlyBudgetUsd } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Project name is required" },
        { status: 400 }
      );
    }

    // Case-insensitive uniqueness: Project.name is only BINARY-unique in SQLite,
    // but project attribution resolves producer-supplied names case-insensitively
    // (project-resolver.ts). Allowing "Foo" and "foo" to coexist would make that
    // resolution ambiguous. The app-level check gives a friendly message; the
    // unique `nameKey` column is the real guarantee (it closes the race two
    // app-level checks can't — both would pass, but the second insert fails).
    const nameKey = canonicalProjectKey(String(name));
    const existing = await prisma.project.findMany({ select: { name: true } });
    if (existing.some((p) => canonicalProjectKey(p.name) === nameKey)) {
      return NextResponse.json(
        { error: "Project name already exists or is an equivalent attribution alias" },
        { status: 400 }
      );
    }

    const project = await prisma.project.create({
      data: {
        name,
        nameKey,
        description,
        monthlyBudgetUsd,
      },
    });

    // Wave G / E6: attach this projectId to prior untagged events whose
    // metadata.project matches (no producer replay required).
    let backfilledEvents = 0;
    try {
      backfilledEvents = await backfillProjectIdFromMetadataName(
        project.id,
        project.name
      );
    } catch (error) {
      console.warn(
        "[projects] metadata.project backfill failed (non-fatal):",
        error instanceof Error ? error.message : error
      );
    }

    bustBudgetStatusCache();

    return NextResponse.json({
      ...project,
      ...(backfilledEvents > 0 ? { backfilledEvents } : {}),
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "Project name already exists or is an equivalent attribution alias" },
        { status: 409 }
      );
    }
    console.error("Failed to create project:", error);
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    );
  }
}
