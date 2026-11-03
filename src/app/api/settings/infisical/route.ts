import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { appSettings } from "@/lib/app-settings";
import { configureInfisicalRuntimeSettings } from "@/lib/infisical-runtime-settings";
import { authorizeInfisical, infisicalJson, infisicalSecretApi, infisicalSecretParams } from "@/lib/infisical-auth";
import { connectionMetadata, deleteInfisicalConnection, InfisicalConnectionSchema, InfisicalSourceSchema, isInfisicalConnectionDisabled, loadInfisicalConnectionSnapshot, resolveInfisicalConnection, mergeConnectionCredentials, saveInfisicalConnection } from "@/lib/infisical-connections";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const admin = (request: NextRequest) => verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const failure = () => NextResponse.json({ error: "Infisical connection could not be verified or saved" }, { status: 400 });

export async function GET(request: NextRequest) {
  if (!admin(request)) return forbidden();
  try {
    const sources = await Promise.all(InfisicalSourceSchema.options.map(async (source) => {
      try {
        const connection = await resolveInfisicalConnection(source);
        return { source, connection: connection ? connectionMetadata(connection) : null, error: null };
      } catch {
        return { source, connection: null, error: "infisical_connection_unreadable" };
      }
    }));
    return NextResponse.json({ connections: sources.flatMap(({ connection }) => connection ? [connection] : []), disabledSources: InfisicalSourceSchema.options.filter(isInfisicalConnectionDisabled), sourceErrors: sources.flatMap(({ source, error }) => error ? [{ source, error }] : []) });
  } catch { return failure(); }
}

export async function PUT(request: NextRequest) {
  if (!admin(request)) return forbidden();
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 24 * 1024) return failure();
    const input = InfisicalConnectionSchema.parse(JSON.parse(raw));
    const snapshot = await loadInfisicalConnectionSnapshot(input.source);
    let connection;
    try {
      // A complete replacement never needs credentials from an unreadable source.
      connection = mergeConnectionCredentials(input, null);
    } catch {
      if (snapshot.unreadable) return failure();
      const effective = snapshot.connection ?? await resolveInfisicalConnection(input.source);
      connection = mergeConnectionCredentials(input, effective);
    }
    // Verify every declared route against token metadata, without a write probe.
    let identityToken: string | undefined;
    for (const permission of ["read", "write"] as const) {
      for (const path of permission === "read" ? connection.readPaths : connection.writePaths) {
        const token = identityToken ?? await authorizeInfisical(connection, path, permission);
        if (connection.mode === "machine-identity") identityToken = token;
        if (permission === "read") {
          const list = await infisicalJson(`${infisicalSecretApi(connection)}?${infisicalSecretParams(connection, path)}`, { headers: { authorization: `Bearer ${token}` } });
          if (!Array.isArray(list.secrets)) return failure();
        }
      }
    }
    const persist = () => withInternalUsageWriteAdmission(() => saveInfisicalConnection(connection, snapshot.revision));
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
