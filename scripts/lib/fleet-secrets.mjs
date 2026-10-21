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
 * all mean "absent" and return null.
 *
 * The `null` contract is kept for every existing caller.  A caller that has
 * to tell "the secret is not set" from "the helper could not be reached"
 * passes an `onError` callback and gets one report per failed path, with a
 * `kind` from `FLEET_SECRET_FAILURE_KINDS` and the exit code of the helper.
 * The callback never carries a value.
 */
export const FLEET_SECRETS_PATHS = ["/", "/global-api-keys"];

/**
 * The kinds a failed lookup can end in.
 *
 * "absent"         the helper ran and the key is not set.
 * "unavailable"    the helper could not reach the store, or the store
 *                  refused the request.
 * "unresolved"     the value came back as an unresolved Infisical
 *                  reference, so the secret is configured wrongly.
 * "refused"        the helper refused the configuration.
 * "timeout"        the helper did not answer in time.
 * "missing-binary" the helper is not installed.
 * "invalid-name"   the name is not a valid secret name.
 * "unknown"        anything else.
 */
export const FLEET_SECRET_FAILURE_KINDS = Object.freeze([
  "absent",
  "unavailable",
  "unresolved",
  "refused",
  "timeout",
  "missing-binary",
  "invalid-name",
  "unknown",
]);

//  The exit codes of the `fleet-secrets` CLI:  0 ok, 2 usage or refused
//  configuration, 3 key absent, 4 fetch or auth failure, 5 a value came
//  back as an unresolved Infisical reference, 126/127 the command could not
//  be executed.
const EXIT_REFUSED = 2;
const EXIT_ABSENT = 3;
const EXIT_FETCH = 4;
const EXIT_UNRESOLVED = 5;

/**
 * Turn a failed lookup into a kind and an exit code.
 *
 * The VALUE is never part of the result:  only the kind, the exit code and
 * the name of the secret.  "absent" and "unavailable" are different
 * conditions, and a caller that cannot tell them apart cannot tell a hub
 * without a token from a hub whose helper is not installed.
 */
export function classifyFleetSecretFailure(error) {
  const status = Number.isInteger(error?.status)
    ? error.status
    : Number.isInteger(error?.code)
      ? error.code
      : undefined;
  if (status !== undefined) {
    if (status === EXIT_ABSENT) return { kind: "absent", exitCode: status };
    if (status === EXIT_FETCH) return { kind: "unavailable", exitCode: status };
    if (status === EXIT_UNRESOLVED) return { kind: "unresolved", exitCode: status };
    if (status === EXIT_REFUSED) return { kind: "refused", exitCode: status };
    return { kind: "unknown", exitCode: status };
  }
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "ENOENT") return { kind: "missing-binary" };
  if (code === "ETIMEDOUT") return { kind: "timeout" };
  if (error?.killed === true || error?.signal === "SIGTERM") return { kind: "timeout" };
  return { kind: "unknown" };
}

/**
 * Report one failed lookup to a caller that asked for the signal.
 *
 * The callback is OPT-IN.  A caller that passes none sees exactly the old
 * behaviour, a `null` for a secret that could not be read.  A callback that
 * throws must not change the result of the lookup, so its error is
 * swallowed.
 */
function reportFailure(onError, info) {
  if (typeof onError !== "function") return;
  try {
    onError({
      name: info.name,
      path: info.path,
      kind: info.kind,
      exitCode: info.exitCode,
    });
  } catch {
    //  A broken callback must not break the lookup.
  }
}

const cache = new Map();

export function fleetSecretsBinary({ home = homedir(), exists = existsSync } = {}) {
  // A LaunchAgent's PATH is minimal, so prefer the absolute install location.
  const installed = join(home, ".local", "bin", "fleet-secrets");
  return exists(installed) ? installed : "fleet-secrets";
}

export function fleetSecretsGet(
  name,
  {
    exec = execFileSync,
    binary = fleetSecretsBinary(),
    paths = FLEET_SECRETS_PATHS,
    useCache = true,
    onError,
  } = {},
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    reportFailure(onError, { name, path: "", kind: "invalid-name" });
    return null;
  }
  if (useCache && cache.has(name)) return cache.get(name);
  let value = null;
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
      // Exit 3 (absent), 4 (fetch/auth failure), 5 (unresolved reference), a
      // timeout or a missing binary: try the next path, then report absent.
      reportFailure(onError, { name, path: secretPath, ...classifyFleetSecretFailure(error) });
    }
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
 * "absent" and return null.  The value is never logged.  There is no cache
 * here: a caller that needs one memoizes the result itself, which is what
 * keeps a rotated secret visible to a running process.
 *
 * The `onError` callback is the OPT-IN signal described in the module
 * docblock:  it reports the kind of every failed path, so a caller can tell
 * a secret that is not set from a helper that could not be reached.
 */
export async function fleetSecretsGetAsync(
  name,
  { exec = execFileAsync, binary = fleetSecretsBinary(), paths = FLEET_SECRETS_PATHS, onError } = {},
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    reportFailure(onError, { name, path: "", kind: "invalid-name" });
    return null;
  }
  let value = null;
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
      // Exit 3 (absent), 4 (fetch/auth failure), 5 (unresolved reference), a
      // timeout or a missing binary: try the next path, then report absent.
      reportFailure(onError, { name, path: secretPath, ...classifyFleetSecretFailure(error) });
    }
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
