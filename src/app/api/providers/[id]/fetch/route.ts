import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordProviderUsage } from "@/lib/usage-recorder";
import { AdapterError } from "@/lib/adapters/helpers";
import {
  hasStPrimaryCredentialOwnership,
  providerCredentialManagementForClient,
} from "@/lib/managed-provider-credential";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const management = providerCredentialManagementForClient(
    provider.config,
    provider.secretConfig
  );
  const credentialManaged = hasStPrimaryCredentialOwnership(
    provider.config,
    provider.secretConfig,
    provider.label
  );
  if (credentialManaged && !management) {
    return NextResponse.json(
      { error: "This provider's managed credential metadata is unreadable" },
      { status: 409 }
    );
  }
  if (management?.alias) {
    return NextResponse.json(
      { error: "This provider is an inactive alias of an identical managed credential" },
      { status: 409 }
    );
  }

  try {
    const snapshot = await recordProviderUsage(provider);

    return NextResponse.json(
      {
        id: snapshot.id,
        providerId: snapshot.providerId,
        fetchedAt: snapshot.fetchedAt,
        balance: snapshot.balance,
        totalCost: snapshot.totalCost,
        totalRequests: snapshot.totalRequests,
        credits: snapshot.credits,
        createdAt: snapshot.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch";
    const typed = error instanceof AdapterError ? error : null;
    const status =
      typed?.code === "CONFIGURATION_ERROR" ||
      typed?.code === "UNSAFE_OUTBOUND_URL"
        ? 400
        : typed?.code === "UNSUPPORTED"
          ? 422
          : typed?.retryable
            ? 503
            : 502;
    return NextResponse.json(
      {
        error: message,
        code: typed?.code ?? "UNKNOWN",
        retryable: typed?.retryable ?? false,
      },
      { status }
    );
  }
}
