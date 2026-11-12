import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/provider-input";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { bustBudgetStatusCache } from "@/lib/budget-status";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";

import { parseProjectUpdateInput } from "@/lib/project-input";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let parsedInput;
  try {
    const raw = await readJsonBody(request);
    parsedInput = parseProjectUpdateInput(raw);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const updateData: Prisma.ProjectUpdateInput = {};

  if (parsedInput.name !== undefined) {
    const name = parsedInput.name;
    const nameKey = canonicalProjectKey(name);
    const others = await prisma.project.findMany({
      where: { id: { not: id } },
      select: { name: true },
    });
    if (others.some((p) => canonicalProjectKey(p.name) === nameKey)) {
      return NextResponse.json(
        { error: "Project name already exists or is an equivalent attribution alias" },
        { status: 409 }
      );
    }
    updateData.name = name;
    updateData.nameKey = nameKey;
  }

  if (parsedInput.description !== undefined) {
    updateData.description = parsedInput.description;
  }

  if (parsedInput.monthlyBudgetUsd !== undefined) {
    updateData.monthlyBudgetUsd = parsedInput.monthlyBudgetUsd;
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: updateData,
    });
    bustBudgetStatusCache();
    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Project with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.project.delete({ where: { id } });
  bustBudgetStatusCache();
  return NextResponse.json({ success: true });
}
