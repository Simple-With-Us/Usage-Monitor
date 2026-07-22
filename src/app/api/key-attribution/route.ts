import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import {
  displayProviderKeyFingerprint,
  fingerprintProviderReportedKeyId,
  parseAttributionDate,
  parseOptionalAttributionString,
  parseRequiredAttributionString,
  resolveProviderKeyAttribution,
  type AttributionBinding,
  type AttributionIdentity,
} from "@/lib/provider-key-attribution";
import { prisma } from "@/lib/prisma";

interface CoverageRow {
  producerId: string;
  providerName: string;
  producerKeyRef: string | null;
  providerConnectionRef: string | null;
  billingAccountRef: string | null;
  projectId: string | null;
  coverageMode: string | null;
  coverageRelationship: string | null;
  costUsd: number | null;
  eventCount: bigint | number;
  costEventCount: bigint | number;
}

function unauthorized(request: NextRequest): NextResponse | null {
  return shouldEnforceDashboardSession() && !hasValidDashboardSession(request)
    ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    : null;
}

function serializeIdentity(identity: {
  id: string;
  providerId: string;
  alias: string;
  description: string | null;
  providerReportedKeyIdFingerprint: string | null;
  status: string;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  provider: { name: string; displayName: string };
  bindings: Array<{
    id: string;
    projectId: string | null;
    producerId: string;
    producerKeyRef: string;
    providerConnectionRef: string | null;
    billingAccountRef: string | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    project: { id: string; name: string } | null;
  }>;
}) {
  return {
    id: identity.id,
    providerId: identity.providerId,
    provider: identity.provider,
    alias: identity.alias,
    description: identity.description,
    providerKeyFingerprint: displayProviderKeyFingerprint(
      identity.providerReportedKeyIdFingerprint
    ),
    status: identity.status,
    retiredAt: identity.retiredAt?.toISOString() ?? null,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt.toISOString(),
    bindings: identity.bindings.map((binding) => ({
      ...binding,
      effectiveFrom: binding.effectiveFrom.toISOString(),
      effectiveTo: binding.effectiveTo?.toISOString() ?? null,
    })),
  };
}

function constraintsOverlap(left: string | null, right: string | null): boolean {
  return left == null || right == null || left === right;
}

async function loadCoverage(
  identities: readonly AttributionIdentity[],
  bindings: readonly AttributionBinding[]
) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const boundaries = new Set<number>([monthStart.getTime(), now.getTime()]);
  for (const binding of bindings) {
    const from = binding.effectiveFrom.getTime();
    const to = binding.effectiveTo?.getTime();
    if (from > monthStart.getTime() && from < now.getTime()) boundaries.add(from);
    if (to != null && to > monthStart.getTime() && to < now.getTime()) boundaries.add(to);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const totals = {
    scope: "pushed_v2_cost_events" as const,
    aggregation: "proven_disjoint_point_or_window_event_sum" as const,
    note: "Cost sums include only v2 point/window records explicitly marked disjoint. Cumulative, overlapping, and unknown coverage remains unclassified. Provider polling/account totals are excluded.",
    totalCostUsd: 0,
    identityMatchedCostUsd: 0,
    identityUnattributedCostUsd: 0,
    projectAttributedCostUsd: 0,
    projectUnattributedCostUsd: 0,
    totalEventCount: 0,
    identityMatchedEventCount: 0,
    identityUnattributedEventCount: 0,
    unclassifiedCostEventCount: 0,
    reasons: {} as Record<string, { costUsd: number; eventCount: number }>,
    byIdentity: {} as Record<string, { costUsd: number; eventCount: number; projectId: string | null }>,
  };

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = new Date(ordered[index]);
    const end = new Date(ordered[index + 1]);
    const rows = await prisma.$queryRaw<CoverageRow[]>(Prisma.sql`
      SELECT
        "sourceApp" AS "producerId",
        "provider" AS "providerName",
        "keyRef" AS "producerKeyRef",
        json_extract("metadata", '$._providerConnectionRef') AS "providerConnectionRef",
        json_extract("metadata", '$._billingAccountRef') AS "billingAccountRef",
        "projectId" AS "projectId",
        json_extract("metadata", '$._coverageMode') AS "coverageMode",
        json_extract("metadata", '$._coverageRelationship') AS "coverageRelationship",
        SUM("costUsd") AS "costUsd",
        COUNT(*) AS "eventCount",
        SUM(CASE WHEN "costUsd" IS NULL THEN 0 ELSE 1 END) AS "costEventCount"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= ${start}
        AND "occurredAt" < ${end}
        AND CAST(json_extract("metadata", '$._usageTelemetrySchemaVersion') AS INTEGER) = 2
      GROUP BY
        "sourceApp", "provider", "keyRef", "providerConnectionRef",
        "billingAccountRef", "projectId", "coverageMode", "coverageRelationship"
    `);

    for (const row of rows) {
      const isProvenAdditive =
        (row.coverageMode === "point" || row.coverageMode === "window") &&
        row.coverageRelationship === "disjoint";
      const costUsd = isProvenAdditive ? Number(row.costUsd ?? 0) : 0;
      const eventCount = Number(row.eventCount);
      if (!isProvenAdditive) totals.unclassifiedCostEventCount += Number(row.costEventCount);
      const resolution = resolveProviderKeyAttribution(
        {
          providerName: row.providerName,
          producerId: row.producerId,
          producerKeyRef: row.producerKeyRef,
          providerConnectionRef: row.providerConnectionRef,
          billingAccountRef: row.billingAccountRef,
          occurredAt: start,
        },
        identities,
        bindings
      );
      totals.totalCostUsd += costUsd;
      totals.totalEventCount += eventCount;
      if (resolution.status === "matched") {
        totals.identityMatchedCostUsd += costUsd;
        totals.identityMatchedEventCount += eventCount;
        const identityTotal = totals.byIdentity[resolution.identityId] ?? {
          costUsd: 0,
          eventCount: 0,
          projectId: row.projectId ?? resolution.projectId,
        };
        identityTotal.costUsd += costUsd;
        identityTotal.eventCount += eventCount;
        totals.byIdentity[resolution.identityId] = identityTotal;
        if (row.projectId || resolution.projectId) totals.projectAttributedCostUsd += costUsd;
        else totals.projectUnattributedCostUsd += costUsd;
      } else {
        totals.identityUnattributedCostUsd += costUsd;
        totals.identityUnattributedEventCount += eventCount;
        if (row.projectId) totals.projectAttributedCostUsd += costUsd;
        else totals.projectUnattributedCostUsd += costUsd;
        const reason = totals.reasons[resolution.reason] ?? { costUsd: 0, eventCount: 0 };
        reason.costUsd += costUsd;
        reason.eventCount += eventCount;
        totals.reasons[resolution.reason] = reason;
      }
    }
  }
  return totals;
}

export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const [identityRows, providers, projects] = await Promise.all([
      prisma.providerKeyIdentity.findMany({
        orderBy: [{ status: "asc" }, { provider: { displayName: "asc" } }, { alias: "asc" }],
        include: {
          provider: { select: { name: true, displayName: true } },
          bindings: {
            orderBy: { effectiveFrom: "desc" },
            include: { project: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.provider.findMany({
        where: { isActive: true },
        orderBy: { displayName: "asc" },
        select: { id: true, name: true, displayName: true },
      }),
      prisma.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    const identities: AttributionIdentity[] = identityRows.map((identity) => ({
      id: identity.id,
      providerId: identity.providerId,
      providerName: identity.provider.name,
      status: identity.status,
      retiredAt: identity.retiredAt,
      providerReportedKeyIdFingerprint: identity.providerReportedKeyIdFingerprint,
    }));
    const bindings: AttributionBinding[] = identityRows.flatMap((identity) =>
      identity.bindings.map((binding) => ({
        id: binding.id,
        identityId: identity.id,
        projectId: binding.projectId,
        producerId: binding.producerId,
        producerKeyRef: binding.producerKeyRef,
        providerConnectionRef: binding.providerConnectionRef,
        billingAccountRef: binding.billingAccountRef,
        effectiveFrom: binding.effectiveFrom,
        effectiveTo: binding.effectiveTo,
      }))
    );
    return NextResponse.json({
      identities: identityRows.map(serializeIdentity),
      providers,
      projects,
      coverage: await loadCoverage(identities, bindings),
    });
  } catch (error) {
    console.error("Failed to load provider key attribution:", error);
    return NextResponse.json({ error: "Failed to load provider key attribution" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    body = value as Record<string, unknown>;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  try {
    if (body.action === "create_identity") {
      const providerId = parseRequiredAttributionString(body.providerId, "providerId");
      const alias = parseRequiredAttributionString(body.alias, "alias", 120);
      const description = parseOptionalAttributionString(body.description, "description", 500);
      const providerReportedKeyId = parseOptionalAttributionString(
        body.providerReportedKeyId,
        "providerReportedKeyId",
        512
      );
      if (!(await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true } }))) {
        return NextResponse.json({ error: "providerId does not match a known provider" }, { status: 400 });
      }
      const identity = await prisma.providerKeyIdentity.create({
        data: {
          providerId,
          alias,
          description,
          providerReportedKeyIdFingerprint: providerReportedKeyId
            ? fingerprintProviderReportedKeyId(providerId, providerReportedKeyId)
            : null,
        },
        include: {
          provider: { select: { name: true, displayName: true } },
          bindings: { include: { project: { select: { id: true, name: true } } } },
        },
      });
      return NextResponse.json(serializeIdentity(identity), { status: 201 });
    }

    if (body.action === "create_binding") {
      const identityId = parseRequiredAttributionString(body.identityId, "identityId");
      const producerId = parseRequiredAttributionString(body.producerId, "producerId");
      const producerKeyRef = parseRequiredAttributionString(body.producerKeyRef, "producerKeyRef");
      const providerConnectionRef = parseOptionalAttributionString(
        body.providerConnectionRef,
        "providerConnectionRef"
      );
      const billingAccountRef = parseOptionalAttributionString(
        body.billingAccountRef,
        "billingAccountRef"
      );
      const projectId = parseOptionalAttributionString(body.projectId, "projectId");
      const effectiveFrom = parseAttributionDate(body.effectiveFrom, "effectiveFrom");

      const binding = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ProviderKeyIdentity" SET "alias" = "alias" WHERE "id" = ${identityId}`;
        const identity = await tx.providerKeyIdentity.findUnique({ where: { id: identityId } });
        if (!identity || identity.status !== "active") throw new Error("identity_not_active");
        if (projectId && !(await tx.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
          throw new Error("project_not_found");
        }
        const candidates = await tx.providerKeyBinding.findMany({
          where: {
            producerId,
            producerKeyRef,
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
          },
        });
        const collision = candidates.some(
          (candidate) =>
            constraintsOverlap(candidate.providerConnectionRef, providerConnectionRef) &&
            constraintsOverlap(candidate.billingAccountRef, billingAccountRef)
        );
        if (collision) throw new Error("binding_overlap");
        return tx.providerKeyBinding.create({
          data: {
            identityId,
            projectId,
            producerId,
            producerKeyRef,
            providerConnectionRef,
            billingAccountRef,
            effectiveFrom,
          },
          include: { project: { select: { id: true, name: true } } },
        });
      });
      return NextResponse.json({
        ...binding,
        effectiveFrom: binding.effectiveFrom.toISOString(),
        effectiveTo: binding.effectiveTo?.toISOString() ?? null,
      }, { status: 201 });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "This provider key identity or binding already exists" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "identity_not_active") {
      return NextResponse.json({ error: "identityId does not match an active identity" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "project_not_found") {
      return NextResponse.json({ error: "projectId does not match a known project" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "binding_overlap") {
      return NextResponse.json(
        { error: "An overlapping binding already exists; close it before reassigning this key" },
        { status: 409 }
      );
    }
    if (error instanceof Error && /required|characters|ISO date|string/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to mutate provider key attribution:", error);
    return NextResponse.json({ error: "Failed to mutate provider key attribution" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    const body = value as Record<string, unknown>;
    const effectiveTo = parseAttributionDate(body.effectiveTo, "effectiveTo");
    if (body.action === "close_binding") {
      const bindingId = parseRequiredAttributionString(body.bindingId, "bindingId");
      const binding = await prisma.providerKeyBinding.findUnique({ where: { id: bindingId } });
      if (!binding) return NextResponse.json({ error: "Binding not found" }, { status: 404 });
      if (binding.effectiveTo) {
        return NextResponse.json({ error: "Binding is already closed" }, { status: 409 });
      }
      if (effectiveTo.getTime() <= binding.effectiveFrom.getTime()) {
        return NextResponse.json({ error: "effectiveTo must be after effectiveFrom" }, { status: 400 });
      }
      const closed = await prisma.providerKeyBinding.update({
        where: { id: bindingId },
        data: { effectiveTo },
      });
      return NextResponse.json({ ...closed, effectiveTo: closed.effectiveTo?.toISOString() ?? null });
    }
    if (body.action === "retire_identity") {
      const identityId = parseRequiredAttributionString(body.identityId, "identityId");
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ProviderKeyIdentity" SET "alias" = "alias" WHERE "id" = ${identityId}`;
        const identity = await tx.providerKeyIdentity.findUnique({ where: { id: identityId } });
        if (!identity) throw new Error("identity_not_found");
        const openBindings = await tx.providerKeyBinding.findMany({
          where: { identityId, effectiveTo: null },
          select: { id: true, effectiveFrom: true },
        });
        for (const binding of openBindings) {
          await tx.providerKeyBinding.update({
            where: { id: binding.id },
            data: {
              effectiveTo:
                binding.effectiveFrom.getTime() < effectiveTo.getTime()
                  ? effectiveTo
                  : binding.effectiveFrom,
            },
          });
        }
        await tx.providerKeyIdentity.update({
          where: { id: identityId },
          data: { status: "retired", retiredAt: effectiveTo },
        });
      });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && /required|characters|ISO date|string|Invalid request/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") ||
      (error instanceof Error && error.message === "identity_not_found")
    ) {
      return NextResponse.json({ error: "Identity not found" }, { status: 404 });
    }
    console.error("Failed to update provider key attribution:", error);
    return NextResponse.json({ error: "Failed to update provider key attribution" }, { status: 500 });
  }
}
