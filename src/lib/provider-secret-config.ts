import { decryptJson } from "@/lib/crypto";

export interface SplitProviderConfig {
  publicConfig: Record<string, unknown>;
  secretConfig: Record<string, unknown>;
}

export interface ProviderSecretConfigMeta {
  configured: boolean;
  fields: string[];
  paths: string[][];
  readable: boolean;
}

export type ProviderCredentialAction = "preserve" | "replace" | "clear";

export interface ProviderSecretConfigOperation {
  path: string[];
  action: ProviderCredentialAction;
  value?: string;
}

const MAX_CONFIG_DEPTH = 6;
const MAX_CONFIG_ENTRIES = 200;
const MAX_CONFIG_KEY_LENGTH = 128;
const MAX_CONFIG_STRING_LENGTH = 4_096;
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// `publicKey` is deliberately excluded. The exact names cover current
// adapters; the pattern catches credential-shaped fields added to custom or
// future adapters so they do not silently become browser-visible plaintext.
const ALWAYS_SECRET_KEYS = new Set([
  "adminapikey",
  "apikeysid",
  "apitoken",
  "apisecret",
  "accesstoken",
  "authtoken",
  "authusername",
  "bearertoken",
  "clientsecret",
  "extraheaders",
  "managementkey",
  "password",
  "refreshtoken",
  "secretkey",
  "webhooksecret",
]);

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(authorization|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function assertSafeProviderConfigKey(key: string, field: string): void {
  const normalized = key.toLowerCase();
  if (
    !key ||
    key.length > MAX_CONFIG_KEY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    FORBIDDEN_CONFIG_KEYS.has(normalized)
  ) {
    throw new Error(`${field} contains an unsafe or invalid key`);
  }
}

/** Validate and copy operator-supplied provider config before it can reach
 * split/merge/Prisma. Arrays and non-JSON values are deliberately unsupported:
 * current adapters consume scalar fields plus nested objects (extraHeaders).
 */
export function normalizeProviderConfigInput(
  value: unknown,
  field = "config"
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const state = { entries: 0 };

  const visit = (
    record: Record<string, unknown>,
    path: string,
    depth: number
  ): Record<string, unknown> => {
    if (depth > MAX_CONFIG_DEPTH) {
      throw new Error(`${field} exceeds the maximum depth of ${MAX_CONFIG_DEPTH}`);
    }
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      assertSafeProviderConfigKey(key, `${path}.${key}`);
      state.entries += 1;
      if (state.entries > MAX_CONFIG_ENTRIES) {
        throw new Error(`${field} must contain ${MAX_CONFIG_ENTRIES} entries or fewer`);
      }
      const entryPath = `${path}.${key}`;
      if (isRecord(entry)) {
        defineOwn(clean, key, visit(entry, entryPath, depth + 1));
      } else if (Array.isArray(entry)) {
        throw new Error(`${entryPath} arrays are not supported`);
      } else if (typeof entry === "string") {
        if (entry.length > MAX_CONFIG_STRING_LENGTH) {
          throw new Error(
            `${entryPath} must be ${MAX_CONFIG_STRING_LENGTH} characters or fewer`
          );
        }
        defineOwn(clean, key, entry);
      } else if (
        entry === null ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))
      ) {
        defineOwn(clean, key, entry);
      } else {
        throw new Error(`${entryPath} must be a JSON scalar or object`);
      }
    }
    return clean;
  };

  return visit(value, field, 1);
}

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

export function isSecretConfigKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized === "publickey") return false;
  return (
    ALWAYS_SECRET_KEYS.has(normalized) ||
    SECRET_KEY_PATTERN.test(key) ||
    /(?:authorization|credential|password|privatekey|secret|token)$/.test(normalized)
  );
}

function splitRecord(input: Record<string, unknown>): SplitProviderConfig {
  const publicConfig: Record<string, unknown> = {};
  const secretConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isSecretConfigKey(key)) {
      defineOwn(secretConfig, key, value);
      continue;
    }

    if (isRecord(value)) {
      const nested = splitRecord(value);
      if (Object.keys(nested.publicConfig).length > 0) {
        defineOwn(publicConfig, key, nested.publicConfig);
      }
      if (Object.keys(nested.secretConfig).length > 0) {
        defineOwn(secretConfig, key, nested.secretConfig);
      }
      continue;
    }

    defineOwn(publicConfig, key, value);
  }

  return { publicConfig, secretConfig };
}

export function splitProviderConfig(value: unknown): SplitProviderConfig {
  return isRecord(value)
    ? splitRecord(value)
    : { publicConfig: {}, secretConfig: {} };
}

export function mergeProviderConfig(
  publicConfig: Record<string, unknown>,
  secretConfig: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(publicConfig)) {
    defineOwn(
      merged,
      key,
      isRecord(value) ? mergeProviderConfig(value, {}) : value
    );
  }
  for (const [key, value] of Object.entries(secretConfig)) {
    const current = merged[key];
    defineOwn(
      merged,
      key,
      isRecord(current) && isRecord(value)
        ? mergeProviderConfig(current, value)
        : isRecord(value)
          ? mergeProviderConfig(value, {})
          : value
    );
  }
  return merged;
}

function readPath(
  value: Record<string, unknown>,
  path: string[]
): { found: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) {
      const replacement: Record<string, unknown> = {};
      defineOwn(current, segment, replacement);
      current = replacement;
    } else {
      current = nested;
    }
  }
  defineOwn(current, path[path.length - 1], value);
}

function deletePath(target: Record<string, unknown>, path: string[]): void {
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) return;
    parents.push({ parent: current, key: segment });
    current = nested;
  }
  delete current[path[path.length - 1]];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { parent, key } = parents[index];
    const nested = parent[key];
    if (isRecord(nested) && Object.keys(nested).length === 0) delete parent[key];
    else break;
  }
}

/** Existing encrypted values are the base, incoming config secrets are legacy
 * replace operations, and explicit per-field operations are applied last.
 * `preserve` restores the pre-request value, `clear` removes it, and `replace`
 * sets a bounded string without exposing any existing value to the client.
 */
export function applyProviderSecretConfigOperations(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  operations: ProviderSecretConfigOperation[] = []
): Record<string, unknown> {
  const result = mergeProviderConfig(existing, incoming);
  for (const operation of operations) {
    if (operation.action === "preserve") {
      const prior = readPath(existing, operation.path);
      if (prior.found) setPath(result, operation.path, prior.value);
      else deletePath(result, operation.path);
    } else if (operation.action === "replace") {
      setPath(result, operation.path, operation.value);
    } else {
      deletePath(result, operation.path);
    }
  }
  return result;
}

export function decryptProviderSecretConfig(
  encrypted: string | null | undefined
): Record<string, unknown> {
  return encrypted ? decryptJson(encrypted) : {};
}

function collectFieldPaths(
  value: Record<string, unknown>,
  prefix: string[] = []
): string[][] {
  const fields: string[][] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isRecord(nested)) fields.push(...collectFieldPaths(nested, path));
    else fields.push(path);
  }
  return fields;
}

/** Produce the only provider-config representation allowed in API responses.
 * Legacy plaintext secrets are redacted even before the one-time migration is
 * applied, so deployment order cannot re-expose them.
 */
export function providerConfigForClient(
  config: unknown,
  encryptedSecretConfig: string | null | undefined
): {
  config: Record<string, unknown>;
  secretConfigMeta: ProviderSecretConfigMeta;
} {
  const split = splitProviderConfig(config);
  let encryptedSecrets: Record<string, unknown> = {};
  let readable = true;

  if (encryptedSecretConfig) {
    try {
      encryptedSecrets = decryptProviderSecretConfig(encryptedSecretConfig);
    } catch {
      readable = false;
    }
  }

  const combined = mergeProviderConfig(split.secretConfig, encryptedSecrets);
  const paths = collectFieldPaths(combined).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  return {
    config: split.publicConfig,
    secretConfigMeta: {
      configured: Boolean(encryptedSecretConfig) || paths.length > 0,
      fields: paths.map((path) => path.join(".")),
      paths,
      readable,
    },
  };
}

export function hasProviderSecrets(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}
