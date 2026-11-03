import "server-only";
import { z } from "zod";
import { decryptJson, encryptJson } from "./crypto";
import { prisma } from "./prisma";

export const InfisicalSourceSchema = z.enum(["st", "ct", "shared", "um", "st-primary"]);
export type InfisicalSource = z.infer<typeof InfisicalSourceSchema>;
const pathSchema = z.string().max(256).regex(/^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/)
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".."));
const pathsSchema = z.array(pathSchema).max(20).refine((paths) => new Set(paths).size === paths.length);
const secret = z.string().max(8192).optional();
const tokenSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  paths: pathsSchema.min(1),
  permissions: z.array(z.enum(["read", "write"])).min(1).max(2)
    .refine((values) => new Set(values).size === values.length),
  token: secret,
}).strict();
export const InfisicalConnectionSchema = z.object({
  source: InfisicalSourceSchema,
  projectId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  mode: z.enum(["machine-identity", "service-tokens"]),
  secretPath: pathSchema,
  readPaths: pathsSchema.min(1),
  writePaths: pathsSchema,
  clientId: secret,
  clientSecret: secret,
  tokens: z.array(tokenSchema).max(2),
}).strict().superRefine((value, ctx) => {
  if (!value.readPaths.includes(value.secretPath)) ctx.addIssue({ code: "custom", message: "Primary folder must be readable" });
  if (value.mode === "machine-identity" && value.tokens.length) ctx.addIssue({ code: "custom", message: "Machine identities cannot contain service tokens" });
  if (value.mode === "service-tokens") {
    if (value.clientId || value.clientSecret || !value.tokens.length) ctx.addIssue({ code: "custom", message: "Choose one authentication mode" });
    if (new Set(value.tokens.map((token) => token.id)).size !== value.tokens.length) ctx.addIssue({ code: "custom", message: "Duplicate token id" });
    for (const permission of ["read", "write"] as const) {
      const routes = value.tokens.filter((token) => token.permissions.includes(permission)).flatMap((token) => token.paths);
      const expected = permission === "read" ? value.readPaths : value.writePaths;
      if (new Set(routes).size !== routes.length || JSON.stringify([...routes].sort()) !== JSON.stringify([...expected].sort())) {
        ctx.addIssue({ code: "custom", message: "Token routes must match declared folders without overlap" });
      }
    }
  }
});
export type InfisicalConnection = z.infer<typeof InfisicalConnectionSchema>;
const key = (source: InfisicalSource) => `infisical.connection.v1.${source}`;
const knownStoredSources = new Set<InfisicalSource>();
const disabledSources = new Set<InfisicalSource>();
export const hasStoredInfisicalConnections = () => knownStoredSources.size > 0;
export const isInfisicalConnectionDisabled = (source: InfisicalSource) => disabledSources.has(source);

export async function loadInfisicalConnection(source: InfisicalSource): Promise<InfisicalConnection | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: key(source) } });
  if (!row?.value) { knownStoredSources.delete(source); disabledSources.delete(source); return null; }
  const stored = decryptJson(row.value);
  if (stored.disabled === true && stored.source === source) { disabledSources.add(source); knownStoredSources.delete(source); return null; }
  disabledSources.delete(source);
  knownStoredSources.add(source);
  try {
    const connection = InfisicalConnectionSchema.parse(stored);
    if (connection.source !== source) throw new Error();
    return connection;
  } catch {
    throw new Error("infisical_connection_unreadable");
  }
}

export function connectionMetadata(connection: InfisicalConnection) {
  return {
    source: connection.source, projectId: connection.projectId, mode: connection.mode,
    secretPath: connection.secretPath, readPaths: connection.readPaths, writePaths: connection.writePaths,
    clientIdConfigured: Boolean(connection.clientId), clientSecretConfigured: Boolean(connection.clientSecret),
    writePermissionsVerified: connection.mode === "service-tokens" || connection.writePaths.length === 0,
    tokens: connection.tokens.map(({ id, paths, permissions, token }) => ({ id, paths, permissions, configured: Boolean(token) })),
  };
}

export function mergeConnectionCredentials(input: InfisicalConnection, previous: InfisicalConnection | null): InfisicalConnection {
  const same = previous?.source === input.source && previous.projectId === input.projectId && previous.mode === input.mode;
  const merged = { ...input, tokens: input.tokens.map((token) => ({ ...token })) };
  if (input.mode === "machine-identity") {
    // Blank fields preserve credentials only when their identity and scope stay fixed.
    const coordinatesMatch = same && JSON.stringify([previous?.secretPath, previous?.readPaths, previous?.writePaths]) === JSON.stringify([input.secretPath, input.readPaths, input.writePaths]);
    const sameClient = !input.clientId || input.clientId === previous?.clientId;
    merged.clientId = input.clientId?.trim() || (coordinatesMatch ? previous?.clientId : undefined);
    merged.clientSecret = input.clientSecret?.trim() || (coordinatesMatch && sameClient ? previous?.clientSecret : undefined);
    if (!merged.clientId || !merged.clientSecret) throw new Error("infisical_credentials_required");
  } else {
    merged.tokens = input.tokens.map((entry) => {
      const old = same ? previous?.tokens.find((item) => item.id === entry.id && JSON.stringify([item.paths, item.permissions]) === JSON.stringify([entry.paths, entry.permissions])) : undefined;
      const token = entry.token?.trim() || old?.token;
      if (!token) throw new Error("infisical_credentials_required");
      return { ...entry, token };
    });
  }
  return InfisicalConnectionSchema.parse(merged);
}

export async function saveInfisicalConnection(connection: InfisicalConnection, expected?: InfisicalConnection | null) {
  const value = encryptJson(connection);
  await prisma.$transaction(async (transaction) => {
    if (expected !== undefined) {
      const row = await transaction.appSetting.findUnique({ where: { key: key(connection.source) } });
      const payload = row?.value ? decryptJson(row.value) : null;
      const current = payload?.disabled === true ? null : payload ? InfisicalConnectionSchema.parse(payload) : null;
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("concurrent_infisical_connection_edit");
    }
    const otherRows = await transaction.appSetting.findMany({ where: { key: { startsWith: "infisical.connection.v1." } } });
    const tokens = new Set(connection.tokens.map((token) => token.token).filter(Boolean));
    for (const source of InfisicalSourceSchema.options) {
      if (source === connection.source) continue;
      const row = otherRows.find((item) => item.key === key(source));
      const payload = row?.value ? decryptJson(row.value) : null;
      if (payload?.disabled === true) continue;
      const other = payload ? InfisicalConnectionSchema.parse(payload) : infisicalConnectionFromEnv(source);
      if (!other) continue;
      if (other.projectId === connection.projectId) for (const token of other.tokens) if (token.token) tokens.add(token.token);
    }
    if (tokens.size > 2) throw new Error("infisical_project_token_limit");
    await transaction.appSetting.upsert({ where: { key: key(connection.source) }, create: { key: key(connection.source), value }, update: { value } });
  });
  knownStoredSources.add(connection.source);
  disabledSources.delete(connection.source);
}
export async function deleteInfisicalConnection(source: InfisicalSource) {
  const value = encryptJson({ source, disabled: true });
  await prisma.appSetting.upsert({ where: { key: key(source) }, create: { key: key(source), value }, update: { value } });
  knownStoredSources.delete(source);
  disabledSources.add(source);
}

/** Explicit project credentials only; the fleet Automation identity is never borrowed. */
export function infisicalConnectionFromEnv(source: InfisicalSource, env: NodeJS.ProcessEnv = process.env): InfisicalConnection | null {
  const prefix = `INFISICAL_${source.toUpperCase().replaceAll("-", "_")}`;
  const projectId = env[`${prefix}_PROJECT_ID`]?.trim() || (source === "st-primary" ? env.INFISICAL_ST_PROJECT_ID?.trim() : source === "um" ? env.INFISICAL_PROJECT_ID?.trim() || env.INFISICAL_APP_PROJECT_ID?.trim() : undefined);
  const secretPath = source === "st-primary" ? "/usage-monitor/st-primary/v1" : env[`${prefix}_SECRET_PATH`]?.trim() || "/";
  const readToken = env[`${prefix}_READ_TOKEN`]?.trim();
  const writeToken = env[`${prefix}_WRITE_TOKEN`]?.trim();
  const splitPaths = (value: string | undefined) => value?.split(",").map((path) => path.trim()).filter(Boolean) ?? [secretPath];
  const readPaths = splitPaths(env[`${prefix}_READ_PATHS`]);
  const writePaths = writeToken ? splitPaths(env[`${prefix}_WRITE_PATHS`]) : [];
  const ownPair = Boolean(env[`${prefix}_CLIENT_ID`]?.trim() || env[`${prefix}_CLIENT_SECRET`]?.trim());
  const clientId = ownPair ? env[`${prefix}_CLIENT_ID`]?.trim() : source === "um" ? env.INFISICAL_CLIENT_ID?.trim() : undefined;
  const clientSecret = ownPair ? env[`${prefix}_CLIENT_SECRET`]?.trim() : source === "um" ? env.INFISICAL_CLIENT_SECRET?.trim() : undefined;
  if (!readToken && !writeToken && !clientId && !clientSecret) return null;
  if (!projectId && !readToken && !writeToken && (!clientId || !clientSecret)) return null;
  if (!projectId) throw new Error("infisical_project_required");
  return InfisicalConnectionSchema.parse({ source, projectId, secretPath, readPaths,
    writePaths: readToken || writeToken ? writePaths : readPaths,
    mode: readToken || writeToken ? "service-tokens" : "machine-identity",
    clientId: readToken || writeToken ? undefined : clientId,
    clientSecret: readToken || writeToken ? undefined : clientSecret,
    tokens: [
      ...(readToken ? [{ id: "read", paths: readPaths, permissions: ["read"], token: readToken }] : []),
      ...(writeToken ? [{ id: "write", paths: writePaths, permissions: ["write"], token: writeToken }] : []),
    ],
  });
}

export async function resolveInfisicalConnection(source: InfisicalSource) {
  const stored = await loadInfisicalConnection(source);
  return stored ?? (disabledSources.has(source) ? null : infisicalConnectionFromEnv(source));
}
