import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeProjectBudgetStatus } from "@/lib/budget-status";
import { readJsonBody } from "@/lib/provider-input";
import { parseProjectCreateInput } from "@/lib/project-input";

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

export async function POST(request: Request) {
  let input;
  try {
    input = parseProjectCreateInput(await readJsonBody(request));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  try {
    // Case-insensitive uniqueness: Project.name is only BINARY-unique in SQLite,
    // but project attribution resolves producer-supplied names case-insensitively
    // (project-resolver.ts). Allowing "Foo" and "foo" to coexist would make that
    // resolution ambiguous. The app-level check gives a friendly message; the
    // unique `nameKey` column is the real guarantee (it closes the race two
    // app-level checks can't — both would pass, but the second insert fails).
    const existing = await prisma.project.findMany({ select: { name: true } });
    if (existing.some((p) => p.name.trim().toLowerCase() === input.nameKey)) {
      return NextResponse.json(
        { error: "Project name already exists (names are case-insensitive)" },
        { status: 409 }
      );
    }

    const project = await prisma.project.create({
      data: {
        name: input.name,
        nameKey: input.nameKey,
        description: input.description,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "Project name already exists (names are case-insensitive)" },
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
