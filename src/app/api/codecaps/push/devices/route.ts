import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readBoundedJsonBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import {
  codeCapsPushRegistrationConfigured,
  CodeCapsPushDeviceRegistrationSchema,
  CodeCapsPushDeviceRemovalSchema,
  isCodeCapsPushRegistrationAuthorized,
  loadCodeCapsApnsConfig,
} from "@/lib/codecaps-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "P2002");
}

function authorize(request: NextRequest): NextResponse | null {
  if (!codeCapsPushRegistrationConfigured()) {
    return NextResponse.json({ error: "CodeCaps push registration is not configured" }, { status: 503 });
  }
  if (!isCodeCapsPushRegistrationAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  if (!loadCodeCapsApnsConfig()) {
    return NextResponse.json({ error: "CodeCaps APNs delivery is not configured" }, { status: 503 });
  }

  try {
    const body = await readBoundedJsonBody(request, {
      maxBytes: 16_384,
      label: "CodeCaps push device registration",
    });
    const parsed = CodeCapsPushDeviceRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid CodeCaps push device registration" }, { status: 400 });
    }

    const generation = BigInt(parsed.data.generation);
    const applyRegistration = () => prisma.$transaction(async (tx) => {
      const changed = await tx.codeCapsPushDevice.updateMany({
        where: {
          installationId: parsed.data.installationId,
          OR: [{ generation: { lt: generation } }, { generation, isActive: true }],
        },
        data: {
          generation,
          deviceToken: parsed.data.deviceToken,
          environment: parsed.data.environment,
          preferences: parsed.data.preferences as Prisma.InputJsonValue,
          isActive: true,
        },
      });
      if (changed.count > 0) {
        const device = await tx.codeCapsPushDevice.findUniqueOrThrow({
          where: { installationId: parsed.data.installationId },
          select: { id: true, installationId: true, generation: true, isActive: true, updatedAt: true },
        });
        return { device, applied: true };
      }

      const existing = await tx.codeCapsPushDevice.findUnique({
        where: { installationId: parsed.data.installationId },
        select: { id: true, installationId: true, generation: true, isActive: true, updatedAt: true },
      });
      if (existing) return { device: existing, applied: false };

      const device = await tx.codeCapsPushDevice.create({
        data: {
          ...parsed.data,
          generation,
          preferences: parsed.data.preferences as Prisma.InputJsonValue,
          isActive: true,
        },
        select: { id: true, installationId: true, generation: true, isActive: true, updatedAt: true },
      });
      return { device, applied: true };
    });

    let result: Awaited<ReturnType<typeof applyRegistration>>;
    try {
      result = await applyRegistration();
    } catch (error) {
      // If another request created this installation after our read, retry the
      // compare-and-set transaction. A device-token collision still returns 409.
      if (!isUniqueConflict(error)) throw error;
      result = await applyRegistration();
    }
    return NextResponse.json({
      ok: true,
      applied: result.applied,
      device: { ...result.device, generation: Number(result.device.generation) },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Registration body is too large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (
      error && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return NextResponse.json({ error: "APNs token is already registered to another installation" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to register CodeCaps push device" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    const body = await readBoundedJsonBody(request, {
      maxBytes: 2_048,
      label: "CodeCaps push device removal",
    });
    const parsed = CodeCapsPushDeviceRemovalSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid CodeCaps push device removal" }, { status: 400 });
    }
    const generation = BigInt(parsed.data.generation);
    const applyRemoval = () => prisma.$transaction(async (tx) => {
      const changed = await tx.codeCapsPushDevice.updateMany({
        where: {
          installationId: parsed.data.installationId,
          OR: [{ generation: { lt: generation } }, { generation, isActive: true }],
        },
        data: {
          generation,
          isActive: false,
          deviceToken: null,
          environment: null,
          preferences: Prisma.DbNull,
        },
      });
      if (changed.count > 0) return { applied: true, generation };

      const existing = await tx.codeCapsPushDevice.findUnique({
        where: { installationId: parsed.data.installationId },
        select: { generation: true },
      });
      if (existing) return { applied: false, generation: existing.generation };

      await tx.codeCapsPushDevice.create({
        data: {
          installationId: parsed.data.installationId,
          generation,
          isActive: false,
          deviceToken: null,
          environment: null,
          preferences: Prisma.DbNull,
        },
      });
      return { applied: true, generation };
    });
    let result: Awaited<ReturnType<typeof applyRemoval>>;
    try {
      result = await applyRemoval();
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      result = await applyRemoval();
    }
    return NextResponse.json({
      ok: true,
      removed: result.applied,
      applied: result.applied,
      generation: Number(result.generation),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Removal body is too large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to remove CodeCaps push device" }, { status: 500 });
  }
}
