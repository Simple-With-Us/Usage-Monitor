import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { appSettings } from "@/lib/app-settings";
import { configureInfisicalRuntimeSettings } from "@/lib/infisical-runtime-settings";
import { authorizeInfisical, infisicalJson, infisicalSecretApi, infisicalSecretParams } from "@/lib/infisical-auth";
import { connectionMetadata, deleteInfisicalConnection, InfisicalConnectionSchema, InfisicalSourceSchema, isInfisicalConnectionDisabled, loadInfisicalConnection, resolveInfisicalConnection, mergeConnectionCredentials, saveInfisicalConnection } from "@/lib/infisical-connections";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const admin = (request: NextRequest) => verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const failure = () => NextResponse.json({ error: "Infisical connection could not be verified or saved" }, { status: 400 });

export async function GET(request: NextRequest) {
  if (!admin(request)) return forbidden();
  try {
    const connections = await Promise.all(InfisicalSourceSchema.options.map(resolveInfisicalConnection));
    return NextResponse.json({ connections: connections.filter((value) => value !== null).map(connectionMetadata), disabledSources: InfisicalSourceSchema.options.filter(isInfisicalConnectionDisabled) });
  } catch { return failure(); }
}

export async function PUT(request: NextRequest) {
  if (!admin(request)) return forbidden();
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 24 * 1024) return failure();
    const input = InfisicalConnectionSchema.parse(JSON.parse(raw));
    const previous = await loadInfisicalConnection(input.source);
    const effective = previous ?? await resolveInfisicalConnection(input.source);
    const connection = mergeConnectionCredentials(input, effective);
    // Verify every declared route against token metadata, without a write probe.
    for (const permission of ["read", "write"] as const) {
      for (const path of permission === "read" ? connection.readPaths : connection.writePaths) {
        const token = await authorizeInfisical(connection, path, permission);
        if (permission === "read") {
          const list = await infisicalJson(`${infisicalSecretApi(connection)}?${infisicalSecretParams(connection, path)}`, { headers: { authorization: `Bearer ${token}` } });
          if (!Array.isArray(list.secrets)) return failure();
        }
      }
    }
    const persist = () => withInternalUsageWriteAdmission(() => saveInfisicalConnection(connection, previous));
    if (connection.source === "um") await configureInfisicalRuntimeSettings(appSettings, connection, persist);
    else await persist();
    return NextResponse.json({ connection: connectionMetadata(connection) });
  } catch { return failure(); }
}

export async function DELETE(request: NextRequest) {
  if (!admin(request)) return forbidden();
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join() !== "source") return failure();
    const source = InfisicalSourceSchema.parse((body as { source: unknown }).source);
    // A durable tombstone suppresses ambient credentials after a disable.
    await withInternalUsageWriteAdmission(() => deleteInfisicalConnection(source));
    if (source === "um") appSettings.disableInfisicalConnection();
    return NextResponse.json({ ok: true, disabled: true });
  } catch { return failure(); }
}
