import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read one fleet secret through the Mac-side `fleet-secrets` CLI (OPS-818).
 *
 * Mac collectors and helper scripts call this AFTER checking their own
 * environment.  It replaces the old read of the retired flat key file, which
 * nothing may read any more.  Never use it from cloud, CI or Vercel code:
 * those get their values from the environment only.
 *
 * Root `/` is tried first, then `/global-api-keys`, because some names (for
 * example USAGE_INGEST_TOKEN) live only in that folder.  The value is captured
 * from stdout and returned;  it is never logged, and the CLI's stderr is
 * discarded.  A missing binary, an absent key, a fetch failure or a timeout
 * all mean "absent" and return null, unless `strict` is set: then a transient
 * failure (anything but an absent key on every path) throws an error naming
 * the secret with the lookup failure as its cause, so a required secret is
 * never silently read as missing.  The secret VALUE is never in the error.
 */
export const FLEET_SECRETS_PATHS = ["/", "/global-api-keys"];

/**
 * True when a `fleet-secrets` helper failure means "the key is absent".
 *
 * The CLI exits 3 for an absent key (surfaced as `status` by the sync
 * caller and as `code` by the promise caller, so both are checked).
 * Every other failure — exit 4 (fetch/auth), exit 5 (unresolved
 * reference), a timeout, a missing binary — is transient, not absence.
 */
export function isSecretAbsentError(error) {
  return error?.status === 3 || error?.code === 3;
}

const cache = new Map();

export function fleetSecretsBinary({ home = homedir(), exists = existsSync } = {}) {
  // A LaunchAgent's PATH is minimal, so prefer the absolute install location.
  const installed = join(home, ".local", "bin", "fleet-secrets");
  return exists(installed) ? installed : "fleet-secrets";
}

export function fleetSecretsGet(
  name,
  { exec = execFileSync, binary = fleetSecretsBinary(), paths = FLEET_SECRETS_PATHS, useCache = true, strict = false } = {},
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  if (useCache && cache.has(name)) return cache.get(name);
  let value = null;
  let transient = null;
  for (const secretPath of paths) {
    try {
      const out = exec(binary, ["get", name, "--path", secretPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const trimmed = typeof out === "string" ? out.trim() : "";
      if (trimmed) {
        value = trimmed;
        break;
      }
    } catch (error) {
      // Exit 3 (absent): try the next path.  Any other failure (fetch/auth
      // failure, timeout, missing binary) is recorded: with `strict` it is
      // thrown on the final path instead of reported as absent.
      if (!isSecretAbsentError(error)) transient = error;
    }
  }
  if (value === null && strict && transient) {
    const lookupError = new Error(`fleet secret "${name}" lookup failed`, { cause: transient });
    lookupError.secretName = name;
    throw lookupError;
  }
  if (useCache) cache.set(name, value);
  return value;
}

export function resetFleetSecretsCache() {
  cache.clear();
}

/**
 * The promise-based twin of `fleetSecretsGet`.
 *
 * `fleetSecretsGet` spawns the helper with `execFileSync`, which blocks the
 * event loop of the calling process for as long as the helper runs.  That is
 * fine for a short-lived collector, and wrong for a long-running process
 * that also serves requests, so a long-running caller uses this instead.
 *
 * The same paths are tried in the same order and the same value is returned:
 * a missing binary, an absent key, a fetch failure or a timeout all mean
 * "absent" and return null, unless `strict` is set (see `fleetSecretsGet`).
 * The value is never logged.  There is no cache
 * here: a caller that needs one memoizes the result itself, which is what
 * keeps a rotated secret visible to a running process.
 */
export async function fleetSecretsGetAsync(
  name,
  { exec = execFileAsync, binary = fleetSecretsBinary(), paths = FLEET_SECRETS_PATHS, strict = false } = {},
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  let value = null;
  let transient = null;
  for (const secretPath of paths) {
    try {
      const { stdout } = await exec(binary, ["get", name, "--path", secretPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const trimmed = typeof stdout === "string" ? stdout.trim() : "";
      if (trimmed) {
        value = trimmed;
        break;
      }
    } catch (error) {
      // Exit 3 (absent): try the next path.  Any other failure is recorded
      // and, with `strict`, thrown on the final path (see `fleetSecretsGet`).
      if (!isSecretAbsentError(error)) transient = error;
    }
  }
  if (value === null && strict && transient) {
    const lookupError = new Error(`fleet secret "${name}" lookup failed`, { cause: transient });
    lookupError.secretName = name;
    throw lookupError;
  }
  return value;
}

/**
 * Key NAMES visible through `fleet-secrets names`, root plus the
 * /global-api-keys folder.  Names only;  never a value.  Returns an empty Set
 * when the binary is missing or the fetch fails.
 */
export function fleetSecretsNames({
  exec = execFileSync,
  binary = fleetSecretsBinary(),
  paths = FLEET_SECRETS_PATHS,
} = {}) {
  const names = new Set();
  for (const secretPath of paths) {
    try {
      const out = exec(binary, ["names", "--path", secretPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const line of String(out).split(/\r?\n/)) {
        const name = line.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
    } catch {
      // Treat a failing path as contributing no names.
    }
  }
  return names;
}
