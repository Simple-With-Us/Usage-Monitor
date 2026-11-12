import "server-only";
import { z } from "zod";
import type { InfisicalConnection } from "./infisical-connections";

const InfisicalObjectSchema = z.record(z.string(), z.unknown());
const InfisicalSecretSchema = z.object({
  secretKey: z.string().min(1).max(512), secretValue: z.string().max(64 * 1024).optional(),
  workspace: z.string().optional(), environment: z.string().optional(), secretPath: z.string().optional(), type: z.string().optional(),
}).passthrough();
const InfisicalSecretListSchema = z.object({ secrets: z.array(InfisicalSecretSchema).max(2000) }).passthrough();
const InfisicalValueListSchema = z.object({ secrets: z.array(InfisicalSecretSchema.extend({ secretValue: z.string().max(64 * 1024) })).max(2000) }).passthrough();
const InfisicalLoginSchema = z.object({ accessToken: z.string().min(1).max(8192) }).passthrough();
const InfisicalTokenMetadataSchema = z.object({
  workspace: z.string().min(1), permissions: z.array(z.enum(["read", "write"])).max(2),
  scopes: z.array(z.object({ environment: z.string(), secretPath: z.string() })).max(20), expiresAt: z.string().nullable().optional(),
}).passthrough();

function responseSchema(path: string, init: RequestInit, origin: string) {
  const url = new URL(path, origin);
  if (url.pathname === "/api/v1/auth/universal-auth/login") return InfisicalLoginSchema;
  if (url.pathname === "/api/v2/service-token") return InfisicalTokenMetadataSchema;
  if ((!init.method || init.method === "GET") && ["/api/v3/secrets/raw", "/api/v4/secrets"].includes(url.pathname)) return url.searchParams.get("viewSecretValue") === "true" ? InfisicalValueListSchema : InfisicalSecretListSchema;
  return InfisicalObjectSchema;
}

export class InfisicalAuthError extends Error {
  constructor(readonly code: string) { super(code); this.name = "InfisicalAuthError"; }
}
export function requireConcreteInfisicalValue(value: string): string {
  if (/\$\{[^}]+\}/.test(value)) throw new InfisicalAuthError("unexpanded_secret_reference");
  return value;
}
/** Legacy raw responses may omit folder identity; only a token with one exact
 * metadata-verified scope makes that omission unambiguous.  Contradictions
 * always fail closed, and multi-folder tokens must echo the exact identity.
 */
export function requireInfisicalSecretIdentity(connection: InfisicalConnection, path: string, secret: Record<string, unknown>) {
  const entries = connection.tokens.filter((token) => token.permissions.includes("read") && token.paths.includes(path));
  if (entries.length !== 1) throw new InfisicalAuthError("secret_scope_mismatch");
  const single = entries[0].paths.length === 1;
  for (const [field, expected] of [["workspace", connection.projectId], ["environment", "prod"], ["secretPath", path]] as const) {
    if (secret[field] !== expected && !(single && secret[field] === undefined)) throw new InfisicalAuthError("secret_scope_mismatch");
  }
  if (secret.type !== undefined && secret.type !== "shared") throw new InfisicalAuthError("secret_scope_mismatch");
}
export function infisicalOrigin(value = process.env.INFISICAL_BASE_URL || "https://app.infisical.com") {
  let url: URL;
  try { url = new URL(value); } catch { throw new InfisicalAuthError("invalid_base_url"); }
  if (url.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new InfisicalAuthError("invalid_base_url");
  return url.origin;
}

export async function infisicalJson(path: string, init: RequestInit = {}, options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<Record<string, unknown>> {
  const origin = infisicalOrigin(options.baseUrl);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${origin}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch { throw new InfisicalAuthError("network_error"); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new InfisicalAuthError(`http_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new InfisicalAuthError("invalid_response");
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.length;
      if (total > 128 * 1024) { await reader.cancel(); throw new InfisicalAuthError("response_too_large"); }
      chunks.push(item.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = responseSchema(path, init, origin).safeParse(value);
    if (!parsed.success) throw new InfisicalAuthError("invalid_response");
    return parsed.data;
  } catch (error) { if (error instanceof InfisicalAuthError) throw error; throw new InfisicalAuthError("invalid_response"); }
  finally { reader.releaseLock(); }
}

function equalSet(left: readonly string[], right: readonly string[]) {
  return left.length === new Set(left).size && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
/** Inspect the token's own metadata; a successful secretPath query proves no scope. */
export async function authorizeInfisical(connection: InfisicalConnection, secretPath: string, permission: "read" | "write", options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
  const paths = permission === "read" ? connection.readPaths : connection.writePaths;
  if (!paths.includes(secretPath)) throw new InfisicalAuthError("folder_permission_denied");
  if (connection.mode === "machine-identity") {
    if (!connection.clientId || !connection.clientSecret) throw new InfisicalAuthError("incomplete_credentials");
    const login = await infisicalJson("/api/v1/auth/universal-auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: connection.clientId, clientSecret: connection.clientSecret }) }, options);
    if (typeof login.accessToken !== "string" || !login.accessToken) throw new InfisicalAuthError("auth_invalid_response");
    return login.accessToken;
  }
  const candidates = connection.tokens.filter((entry) => entry.permissions.includes(permission) && entry.paths.includes(secretPath));
  if (candidates.length !== 1 || !candidates[0].token) throw new InfisicalAuthError("ambiguous_or_missing_token");
  const entry = candidates[0];
  const token = entry.token!;
  const metadata = await infisicalJson("/api/v2/service-token", { headers: { authorization: `Bearer ${token}` } }, options);
  if (metadata.workspace !== connection.projectId || !Array.isArray(metadata.permissions) || !metadata.permissions.every((p) => typeof p === "string") || !equalSet(metadata.permissions as string[], entry.permissions) || !Array.isArray(metadata.scopes)) throw new InfisicalAuthError("token_scope_mismatch");
  const actualPaths: string[] = [];
  for (const item of metadata.scopes) {
    if (!item || typeof item !== "object" || (item as Record<string, unknown>).environment !== "prod" || typeof (item as Record<string, unknown>).secretPath !== "string") throw new InfisicalAuthError("token_scope_mismatch");
    actualPaths.push((item as Record<string, unknown>).secretPath as string);
  }
  if (!equalSet(actualPaths, entry.paths)) throw new InfisicalAuthError("token_scope_mismatch");
  if (metadata.expiresAt != null && (typeof metadata.expiresAt !== "string" || !Number.isFinite(Date.parse(metadata.expiresAt)) || Date.parse(metadata.expiresAt) <= Date.now())) throw new InfisicalAuthError("token_expired");
  return token;
}

export function infisicalSecretApi(connection: InfisicalConnection) { return connection.mode === "service-tokens" ? "/api/v3/secrets/raw" : "/api/v4/secrets"; }
export function infisicalSecretParams(connection: InfisicalConnection, path: string, values = false) {
  const legacy = connection.mode === "service-tokens";
  return new URLSearchParams({ [legacy ? "workspaceId" : "projectId"]: connection.projectId, environment: "prod", secretPath: path, viewSecretValue: String(values), expandSecretReferences: "false", recursive: "false", [legacy ? "include_imports" : "includeImports"]: "false", includePersonalOverrides: "false" });
}
