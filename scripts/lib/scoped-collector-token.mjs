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
 */
export function createScopedCollectorTokenResolver(binding, deps = {}) {
  const { account, label, grantId, project, folders = DEFAULT_COLLECTOR_FOLDERS } = binding;
  const { readKeychain = readKeychainServiceToken, fetchImpl } = deps;
  const boundScopes = folders.map((folder) => `prod:${folder}`);

  function scopedLookup(env) {
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
        const m = await request("/api/v2/service-token");
        const scopes = Array.isArray(m.scopes)
          ? m.scopes.map((scope) => `${scope.environment}:${scope.secretPath}`).sort()
          : [];
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
            const result = await request("/api/v4/secrets", {
              projectId: project,
              environment: "prod",
              secretPath: folder,
              includeImports: "true",
              recursive: "false",
              expandSecretReferences: folder === "/" ? "false" : "true",
              includePersonalOverrides: "true",
            });
            if (!Array.isArray(result.secrets) || (result.imports != null && !Array.isArray(result.imports))) {
              throw new Error("Infisical secret response is invalid");
            }
            const values = new Map();
            const add = (rows, override) => {
              if (!Array.isArray(rows)) throw new Error("Infisical import response is invalid");
              for (const row of rows) {
                if (typeof row.secretKey !== "string" || typeof row.secretValue !== "string" || row.secretValueHidden === true) {
                  throw new Error("Infisical secret response is invalid");
                }
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

  return async function resolveCollectorToken(
    tokenEnvVarNames = ["USAGE_INGEST_TOKEN"],
    { env = process.env, fleetSecretsGet: lookup } = {},
  ) {
    const read = lookup ?? scopedLookup(env);
    let failure;
    for (const name of tokenEnvVarNames) {
      const value = env[name]?.trim();
      if (value) return value;
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
