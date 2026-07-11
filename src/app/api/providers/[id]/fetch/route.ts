import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordProviderUsage } from "@/lib/usage-recorder";
import { AdapterError } from "@/lib/adapters/helpers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
