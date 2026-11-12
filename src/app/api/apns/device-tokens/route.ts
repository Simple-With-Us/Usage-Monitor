import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isDashboardSession(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

function isReadAuthorized(request: NextRequest): boolean {
  if (isDashboardSession(request)) return true;
  if (!resolveUsageReadToken()) return false;
  return isUsageReadAuthorized(request);
}

export async function GET(request: NextRequest) {
  if (!isReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokens = await prisma.apnsDeviceToken.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      deviceToken: true,
      deviceModel: true,
      osVersion: true,
      environment: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    count: tokens.length,
    tokens: tokens.map(({ deviceToken, ...rest }) => ({
      ...rest,
      deviceTokenPreview:
        deviceToken.length > 12
          ? `${deviceToken.slice(0, 6)}...${deviceToken.slice(-6)}`
          : deviceToken,
    })),
  });
}

export async function POST(request: NextRequest) {
  // Registering a device token is a write (it changes which device receives
  // push alerts), so it is dashboard-session only -- USAGE_READ_TOKEN must
  // not be able to enroll a device, the same reasoning already applied to
  // PUT /api/settings (board 154b622e).  The only real caller, the iOS app's
  // APIClient.registerApnsDeviceToken, already authenticates with
  // `.session`, so this tightens nothing a legitimate client relies on.
  if (!isDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { deviceToken, deviceModel, osVersion, environment } = body;

    if (!deviceToken || typeof deviceToken !== "string" || deviceToken.trim().length === 0) {
      return NextResponse.json(
        { error: "deviceToken (non-empty string) is required" },
        { status: 400 }
      );
    }

    const cleanToken = deviceToken.trim().replaceAll(/[\s<>]/g, "");

    const tokenRecord = await prisma.apnsDeviceToken.upsert({
      where: { deviceToken: cleanToken },
      create: {
        deviceToken: cleanToken,
        deviceModel: typeof deviceModel === "string" ? deviceModel.trim() : null,
        osVersion: typeof osVersion === "string" ? osVersion.trim() : null,
        environment: typeof environment === "string" ? environment.trim() : "production",
        isActive: true,
      },
      update: {
        deviceModel: typeof deviceModel === "string" ? deviceModel.trim() : undefined,
        osVersion: typeof osVersion === "string" ? osVersion.trim() : undefined,
        environment: typeof environment === "string" ? environment.trim() : undefined,
        isActive: true,
      },
    });

    return NextResponse.json({
      ok: true,
      id: tokenRecord.id,
      deviceTokenPreview: `${cleanToken.slice(0, 6)}...${cleanToken.slice(-6)}`,
      registeredAt: tokenRecord.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to register APNs token" },
      { status: 500 }
    );
  }
}
