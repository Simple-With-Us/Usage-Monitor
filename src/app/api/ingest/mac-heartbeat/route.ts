import { NextRequest, NextResponse } from "next/server";
import { resolveUsageIngestCredential } from "@/lib/ingest-auth";
import { recordMacHeartbeat } from "@/lib/mac-health";

const MAC_HOST_SOURCE_APP = "mac-host";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Heartbeats persist as sourceApp "mac-host"; a token scoped to any other
  // producer must not be able to write them.
  if (credential.allowedSourceApps && !credential.allowedSourceApps.has(MAC_HOST_SOURCE_APP)) {
    return NextResponse.json(
      { error: "Credential is not authorized for this producer" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const telemetry = await recordMacHeartbeat(body);
    return NextResponse.json({ ok: true, telemetry });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
