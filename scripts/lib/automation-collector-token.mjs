import { execFileSync } from "node:child_process";

/**
 * The Codex usage collector reads its ingest token with the System Keychain
 * automation identity, as permitted by the owner.  No fleet-secrets
 * executable and no personal CLI session is used.
 *
 * This is a DIFFERENT mechanism from the eight scoped service tokens, which
 * read the owner's login keychain under the consumer's own grant name.  The
 * automation identity lives in the System keychain, is shared, and is not a
 * per-consumer grant, so it stays exactly as it was.
 */

const COLLECTOR_TOKEN_FOLDERS = ["/", "/global-api-keys"];
const AUTOMATION_PROJECT = "8dae6d03-8f12-48b2-adf3-e5c1b881c8c5";

function cleanAuthEnvironment(env) {
  const child = { ...env, INFISICAL_DOMAIN: "https://app.infisical.com" };
  for (const key of [
    "INFISICAL_API_URL",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN",
    "INFISICAL_TOKEN",
    "TOKEN",
    "INFISICAL_AUTOMATION_CLIENT_ID",
    "INFISICAL_AUTOMATION_CLIENT_SECRET",
  ]) {
    delete child[key];
  }
  return child;
}

function automationEnvironment(env, exec) {
  const child = cleanAuthEnvironment(env);
  let clientId = "";
  let clientSecret = "";
  let access = "";
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
    killSignal: "SIGKILL",
    cwd: "/",
    env: child,
    maxBuffer: 65536,
  };
  try {
    const read = (account) =>
      exec(env.CODEX_SECURITY_BIN || "/usr/bin/security", [
        "find-generic-password",
        "-s",
        "fleet-secrets",
        "-a",
        account,
        "-w",
        "/Library/Keychains/System.keychain",
      ], options).trim();
    clientId = read("infisical-client-id");
    clientSecret = read("infisical-client-secret");
    if (!clientId || !clientSecret) throw Error("missing");
    const loginEnv = {
      ...child,
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
    };
    try {
      access = exec(env.INFISICAL_BIN || "/opt/homebrew/bin/infisical", [
        "login",
        "--method=universal-auth",
        "--plain",
        "--silent",
      ], { ...options, timeout: 15000, env: loginEnv }).trim();
    } finally {
      delete loginEnv.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
      delete loginEnv.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
    }
    if (!access || /\s/.test(access)) throw Error("invalid");
    child.INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN = access;
    return child;
  } catch {
    throw new Error("Codex usage Infisical automation authentication failed");
  } finally {
    clientId = clientSecret = access = "";
  }
}

function scopedInfisicalRead(name, env, childEnv, exec) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const project = AUTOMATION_PROJECT;
  for (const folder of COLLECTOR_TOKEN_FOLDERS) {
    let out;
    try {
      out = exec(env.INFISICAL_BIN || "/opt/homebrew/bin/infisical", [
        "secrets",
        "get",
        name,
        "--plain",
        "--silent",
        "--telemetry=false",
        "--expand=true",
        "--env=prod",
        `--path=${folder}`,
        `--projectId=${project}`,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15000,
        killSignal: "SIGKILL",
        env: childEnv,
      });
    } catch (err) {
      // Whitelisted diagnostics only - spawn code, timeout-kill, signal or
      // exit status; never err.stderr/cause/message (a CLI error can echo
      // its input).
      const sig = ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP"].includes(err.signal) ? err.signal : "unknown";
      const diag =
        err.code === "ETIMEDOUT"
          ? `deadline-killed(${sig})`
          : err.signal
            ? `signal(${sig})`
            : ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(err.code)
              ? `spawn(${err.code})`
              : Number.isInteger(err.status) && err.status >= 0 && err.status <= 255
                ? `status(${err.status})`
                : "status(unknown)";
      const hint = /^status\([0-9]+\)$/.test(diag) ? "; check the automation read permission" : "";
      const readError = new Error(`Infisical read failed for ${name} at ${folder} (${diag})${hint}`);
      // Trusted machine-readable tag: the ONLY channel callers may classify
      // on.  diag is built exclusively from finite enums above, never from
      // CLI output, so this property can never carry secret material.
      readError.infisicalDiag = diag;
      throw readError;
    }
    const value = out.trim();
    if (/\$\{[^}]+\}/.test(value)) throw new Error(`Infisical returned an unresolved reference for ${name}`);
    if (value) return value;
  }
  return null; // confirmed absent in every folder
}

/**
 * Build the Codex ingest-token resolver.
 *
 * Names are tried strictly in order, each in the environment and then
 * through the scoped lookup, so a producer-scoped name kept in Infisical
 * still beats an unscoped USAGE_INGEST_TOKEN exported in the environment.
 * Pass `fleetSecretsGet: () => null` for an environment-only lookup;  the
 * option key keeps its historical name for caller and test compatibility,
 * but the default no longer touches the retired fleet-secrets CLI.
 */
export function createAutomationCollectorTokenResolver(deps = {}) {
  const { exec = execFileSync } = deps;
  return function resolveCollectorToken(
    tokenEnvVarNames = ["USAGE_INGEST_TOKEN"],
    { env = process.env, fleetSecretsGet: lookup } = {},
  ) {
    let auth;
    let authError;
    let authAttempted = false;
    const effectiveLookup = lookup ?? ((name) => {
      if (!authAttempted) {
        authAttempted = true;
        try {
          auth = automationEnvironment(env, exec);
        } catch (error) {
          authError = error;
        }
      }
      if (authError) throw authError;
      return scopedInfisicalRead(name, env, auth, exec);
    });
    let deferredFailure = null;
    for (const name of tokenEnvVarNames) {
      const val = env[name]?.trim();
      if (val) return val;
      let fromLookup = null;
      try {
        fromLookup = effectiveLookup(name)?.trim();
      } catch (err) {
        // A remote read/auth failure is not a value and must never mask a
        // usable input under a later name (the retired helper returned null
        // on failure, so a later env token still won).  The first failure is
        // rethrown only when no name yields a value at all: a failure with no
        // usable token anywhere is not a silent miss (deliberate contract
        // change from the retired helper's null-on-failure).
        deferredFailure ??= err;
      }
      if (fromLookup) return fromLookup;
    }
    if (deferredFailure) throw deferredFailure;
    return null;
  };
}
