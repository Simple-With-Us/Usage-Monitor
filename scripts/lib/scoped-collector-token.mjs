import { z } from "zod";

import { readKeychainServiceToken } from "./keychain-service-token.mjs";

/**
 * The scoped Infisical service token a collector reads its ingest token with.
 *
 * Each consumer owns its own grant:  the token is named after the consumer,
 * is pinned to one Infisical project, to one set of folders and to one
 * grant id, and it is read from the owner's login keychain under that same
 * name.  A collector therefore cannot widen its own read:  the folders and
 * the grant are its binding, and the metadata check below refuses a token
 * that is not the one that was granted.
 *
 * This module is the ONE implementation of that read.  The per-provider
 * files hold only their binding, so a change to the read cannot drift
 * between consumers.
 */

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** An Infisical service token:  st.<id>.<secret>.<signature>. */
const TOKEN_PATTERN = /^st\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_+/=-]+$/;

/** The folders every collector grant reads. */
export const DEFAULT_COLLECTOR_FOLDERS = ["/", "/global-api-keys"];

/**
 * The trust boundary.  Both Infisical responses are external, so neither is
 * read field by field before it is validated:  a malformed or hostile body
 * is refused whole, and only the validated shape reaches the binding check
 * or the secret map.  Unknown keys are dropped rather than carried along.
 */
const ScopeSchema = z.object({
  environment: z.string(),
  secretPath: z.string(),
});

const ServiceTokenMetadataSchema = z.object({
  workspace: z.string(),
  name: z.string(),
  _id: z.string().optional(),
  id: z.string().optional(),
  scopes: z.array(ScopeSchema),
  permissions: z.array(z.string()),
  expiresAt: z.string(),
});

const SecretRowSchema = z.object({
  secretKey: z.string(),
  secretValue: z.string(),
  secretValueHidden: z.boolean().optional(),
});

const SecretsResponseSchema = z.object({
  secrets: z.array(SecretRowSchema),
  imports: z.array(z.object({ secrets: z.array(SecretRowSchema) })).optional(),
});

/**
 * Read this consumer's scoped service token out of the owner's login
 * keychain and check it against its binding.
 *
 * The token is refused unless it is well formed AND carries the grant id
 * this consumer was given, so a keychain item that belongs to another
 * consumer fails here rather than at the Infisical metadata check.
 *
 * The value is returned as the three-part form Infisical accepts
 * (st.<id>.<secret>);  the signature segment is dropped, exactly as the
 * retired plaintext file read dropped it.  The value is never logged.
 */
export function readScopedServiceToken(binding, { readKeychain = readKeychainServiceToken } = {}) {
  const { account, label, grantId } = binding;
  const { token, status } = readKeychain(account);
  if (status !== "ok") {
    throw new Error(`${label} scoped token is not available in the owner's login keychain (${status})`);
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${label} scoped token in the login keychain is malformed`);
  }
  const parts = token.split(".");
  if (parts[1] !== grantId) {
    throw new Error(`${label} scoped token in the login keychain is not the bound grant`);
  }
  return parts.slice(0, 3).join(".");
}

/**
 * Build the ingest-token resolver for one consumer's binding.
 *
 * Names are tried strictly in order, each in the environment and then
 * through the consumer's own scoped Infisical read, so a producer-scoped
 * name kept in Infisical still beats an unscoped USAGE_INGEST_TOKEN
 * exported in the environment.  Pass `fleetSecretsGet: () => null` for an
 * environment-only lookup;  the option key keeps its historical name for
 * caller and test compatibility.
 *
 * The scoped read is the DEFAULT and not the `fleet-secrets` CLI:  the CLI
 * reads with the Automation identity, which is broader than this consumer's
 * grant.  Each collector may read only what it was granted.
 *
 * COLLECTOR_STRICT_INJECTED_SECRETS=1 means the environment is the only
 * source, exactly as it is for the shared resolver:  a host that asked for
 * env-only resolution gets env-only resolution, and the scoped read is not
 * attempted at all.
 */
export function createScopedCollectorTokenResolver(binding, deps = {}) {
  const { account, label, grantId, project, folders = DEFAULT_COLLECTOR_FOLDERS } = binding;
  const { readKeychain = readKeychainServiceToken, fetchImpl } = deps;
  // Sorted, because the granted scopes are sorted before they are compared:
  //  a binding that lists its folders in another order is the same grant.
  const boundScopes = folders.map((folder) => `prod:${folder}`).sort();

  function buildScopedLookup() {
    let auth, metadata, failure;
    const folderCache = new Map();
    const deadline = Date.now() + 60_000;
    const call = fetchImpl ?? ((...args) => globalThis.fetch(...args));

    async function request(path, query = {}) {
      const remaining = Math.min(15000, deadline - Date.now());
      if (remaining <= 0) throw new Error("Infisical read deadline exceeded");
      const url = new URL(path, "https://app.infisical.com");
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      let response;
      try {
        response = await call(url, {
          headers: { Authorization: `Bearer ${auth}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(remaining),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Infisical read refused (status ${response.status})`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Infisical response is invalid");
        const chunks = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("Infisical response is too large");
          }
          chunks.push(value);
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Error("Infisical response is invalid");
        }
      } catch (error) {
        // Never surface server bodies, URLs, headers, cause or native exceptions.
        if (
          error?.message === "Infisical response is too large" ||
          error?.message === "Infisical response is invalid" ||
          /^Infisical read refused \(status [1-5][0-9]{2}\)$/.test(error?.message ?? "")
        ) {
          throw error;
        }
        throw new Error("Infisical request failed or timed out");
      }
    }

    async function initialize() {
      if (failure) throw failure;
      if (metadata) return;
      try {
        auth = readScopedServiceToken(binding, { readKeychain });
        const parsed = ServiceTokenMetadataSchema.safeParse(await request("/api/v2/service-token"));
        if (!parsed.success) throw new Error("Infisical response is invalid");
        const m = parsed.data;
        const scopes = m.scopes.map((scope) => `${scope.environment}:${scope.secretPath}`).sort();
        if (
          m.workspace !== project ||
          m.name !== account ||
          (m._id ?? m.id) !== grantId ||
          (m.id != null && m._id != null && m.id !== m._id) ||
          JSON.stringify(scopes) !== JSON.stringify(boundScopes) ||
          JSON.stringify(m.permissions) !== '["read"]' ||
          !Number.isFinite(Date.parse(m.expiresAt)) ||
          Date.parse(m.expiresAt) <= Date.now()
        ) {
          throw new Error(`${label} scoped token metadata does not match its binding`);
        }
        metadata = true;
      } catch (error) {
        failure = error;
        throw error;
      }
    }

    return async (name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
      await initialize();
      let followedRootReference = false;
      for (const folder of folders) {
        if (!folderCache.has(folder)) {
          const promise = (async () => {
            const parsed = SecretsResponseSchema.safeParse(
              await request("/api/v4/secrets", {
                projectId: project,
                environment: "prod",
                secretPath: folder,
                includeImports: "true",
                recursive: "false",
                expandSecretReferences: folder === "/" ? "false" : "true",
                includePersonalOverrides: "true",
              }),
            );
            if (!parsed.success) throw new Error("Infisical secret response is invalid");
            const result = parsed.data;
            const values = new Map();
            const add = (rows, override) => {
              for (const row of rows) {
                if (row.secretValueHidden === true) throw new Error("Infisical secret response is invalid");
                if (override || !values.has(row.secretKey)) values.set(row.secretKey, row.secretValue);
              }
            };
            // Vendor CLI: own last key wins; imports reverse order, first unseen wins.
            add(result.secrets, true);
            for (const block of [...(result.imports || [])].reverse()) add(block.secrets, false);
            return values;
          })();
          folderCache.set(folder, promise);
        }
        const value = (await folderCache.get(folder)).get(name)?.trim();
        if (value?.includes("${")) {
          // Root contains unrelated out-of-scope references. Never expand all
          // root records or widen the token. The actual root record is one
          // complete same-name reference into the already granted folder.
          // Fail closed on any new reference shape instead of guessing at it.
          if (folder === "/" && value === `\${prod.global-api-keys.${name}}`) {
            followedRootReference = true;
            continue;
          }
          throw new Error("Infisical returned an unsupported or unresolved reference");
        }
        if (value) return value;
      }
      if (followedRootReference) throw new Error("Infisical reference target is missing or empty");
      return null;
    };
  }

  // One lookup per resolver, so the keychain read, the metadata request and
  // the per-folder fetches are shared by every name this resolver is asked
  // for, instead of repeated once per name.
  let scoped = null;
  function scopedLookup() {
    if (!scoped) scoped = buildScopedLookup();
    return scoped;
  }

  return async function resolveCollectorToken(
    tokenEnvVarNames = ["USAGE_INGEST_TOKEN"],
    { env = process.env, fleetSecretsGet: lookup } = {},
  ) {
    const strict = env.COLLECTOR_STRICT_INJECTED_SECRETS === "1";
    const read = strict ? null : (lookup ?? scopedLookup());
    let failure;
    for (const name of tokenEnvVarNames) {
      const value = env[name]?.trim();
      if (value) return value;
      if (!read) continue;
      try {
        const remote = (await read(name))?.trim();
        if (remote) return remote;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return null;
  };
}
