#!/usr/bin/env node
// Mac-side subscription quota collector: percent REMAINING per plan window for
// Claude, Codex, Grok, MiniMax and Grok Bot (via `gbu --json`).
//
// Why this runs on the Mac and not on the server: each of these endpoints is
// the one the vendor's OWN CLI calls, authenticated with the OAuth token that
// CLI already stored locally.  Owner ruling on issue #1411 (2026-09-03) keeps
// "Codex /status or local quota probe, Grok credits, Claude /usage remaining"
// as laptop jobs.  A server-side connector impersonating a product website
// stays forbidden, and no GPL code is vendored here.
//
// Antigravity is deliberately NOT handled here — scripts/antigravity-usage-collector.mjs
// already emits its quota windows, and duplicating them would double-count.
//
// Usage:
//   node scripts/subscription-quota-collector.mjs [--provider claude|codex|grok|minimax|grok-bot|all]
//                                                 [--dry-run] [--redacted]
//                                                 [--fixture path.json] [--debug]
//
// Owner one-shot, safe to paste (prints numbers, window labels and ISO dates only):
//   node scripts/subscription-quota-collector.mjs --dry-run --redacted
//
// Install the LaunchAgent (every 15 minutes, same pattern as the other collectors):
//   cp scripts/com.jays.subscription-quota-collector.plist.example \
//      ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
//   # replace the /ABSOLUTE/PATH placeholders, then:
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
//   launchctl kickstart -k gui/$(id -u)/com.jays.subscription-quota-collector
// Uninstall:
//   launchctl bootout gui/$(id -u)/com.jays.subscription-quota-collector
//
// Env:
//   Per-producer scoped ingest tokens, one per provider batch:
//     CLAUDE_CODE_INGEST_TOKEN (claude-code), CODEX_INGEST_TOKEN (openai-codex),
//     GROK_INGEST_TOKEN (grok-build), MINIMAX_INGEST_TOKEN (minimax-code),
//     GBU_INGEST_TOKEN (gbu).
//   Each falls back to SUBSCRIPTION_QUOTA_INGEST_TOKEN, then USAGE_INGEST_TOKEN
//     (unscoped; refused once USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true).  Every
//     name is read from the environment first, then ~/.secrets/global-api-keys
//     via resolveCollectorToken.
//   USAGE_MONITOR_INGEST_URL (default https://usage.jays.services/api/ingest/usage)
//   CLAUDE_HOME / CODEX_HOME / GROK_HOME / MINIMAX_CONFIG_PATH / GBU_BIN to override
//     credential locations or the gbu binary path
//   PATH should include $HOME/.gbu/bin and $HOME/.local/bin so `gbu` resolves
//     (LaunchAgent plist.example is updated accordingly).
//
// SECRETS: this script reads local credential files and never prints, logs or
// posts their contents.  The only credential-derived value that ever leaves it
// is the plan name (e.g. "max_20x"), which is not a secret.  Raw HTTP response
// bodies are never printed under any flag, because they can carry account ids.

import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  GROK_PRODUCER_ID,
  postUsageBatches,
} from "./lib/session-token-collectors.mjs";
import { expandHome, resolveCollectorToken } from "./lib/run-session-token-collector.mjs";
import { planTypeFromCodexAuth } from "./lib/codex-observed-plan.mjs";
import { buildQuotaEvent } from "./lib/quota-event.mjs";
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseGrokBilling,
  parseMinimaxRemains,
  parseGbuJson,
} from "./lib/subscription-quota-parsers.mjs";

/** MiniMax has no seat in session-token-collectors yet; give it its own id. */
export const MINIMAX_PRODUCER_ID = "minimax-code";

/** Grok Bot weekly via `gbu --json` (EXTRA source beside CodeCaps Cursor reader). */
export const GBU_PRODUCER_ID = "gbu";

const execFileAsync = promisify(execFile);
const GBU_TIMEOUT_MS = 20_000;
const GBU_MAX_STDOUT_BYTES = 1_048_576;

// macOS keychain read for Claude Code's modern OAuth credential storage.
// Modern Claude Code stores the credential in the keychain under service
// name "Claude Code-credentials"; the legacy `~/.claude/.credentials.json`
// file path is kept only as a safety net.  We never write to the keychain.
const KEYCHAIN_TIMEOUT_MS = 15_000;
const KEYCHAIN_MAX_STDOUT_BYTES = 1_048_576;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

const REQUEST_TIMEOUT_MS = 20_000;

function log(message) {
  console.log(`[subscription-quota-collector] ${message}`);
}

// ---------------------------------------------------------------- helpers ---

/** Read and parse a JSON file.  Returns null on any failure; never logs content. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read Claude Code's OAuth credential payload from the macOS keychain
 * entry of service name "Claude Code-credentials".  Modern Claude Code
 * stores its OAuth refresh/access pair under that service; the payload
 * mirrors the legacy `~/.claude/.credentials.json` shape so downstream
 * callers can treat it identically.  Returns the parsed object or null
 * when the keychain is unavailable, the entry is missing, or the payload
 * is not valid JSON.  Never returns or logs the token value.
 *
 * This is read-only: we never write, refresh, store or modify the
 * token.  Refreshing here would race Claude Code's own refresh and could
 * invalidate the CLI's token.  Claude Code refreshes on next use.
 */
async function readClaudeCredentialsFromKeychain({ execFileImpl = execFileAsync } = {}) {
  // `security` is a macOS-only binary; on any other host we silently
  // skip so the caller can fall back to the legacy file path.
  if (process.platform !== "darwin") return null;
  let stdout = "";
  try {
    const result = await execFileImpl(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      {
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: KEYCHAIN_MAX_STDOUT_BYTES,
        encoding: "utf8",
      },
    );
    stdout = String(result?.stdout ?? "");
  } catch (error) {
    // execFile's timeout kills the child with SIGTERM; its rejection has
    // code=null, signal=SIGTERM, killed=true (not ETIMEDOUT).
    if (
      error &&
      typeof error === "object" &&
      error.killed === true &&
      error.signal === "SIGTERM"
    ) {
      log(
        `claude: macOS keychain lookup for "${CLAUDE_KEYCHAIN_SERVICE}" timed out; falling back to legacy ~/.claude/.credentials.json.  First access from this process / LaunchAgent can block on a keychain ACL prompt; grant "Always Allow" for the collecting process so subsequent reads succeed.`,
      );
      return null;
    }
    // Any non-zero exit (entry missing, ACL denied, interactive prompt
    // refused, etc.) is the same operator-visible problem.  Never include
    // the child stderr: it can carry account-identifying detail.
    log(
      `claude: macOS keychain lookup for "${CLAUDE_KEYCHAIN_SERVICE}" failed; falling back to legacy ~/.claude/.credentials.json.  First access from this process / LaunchAgent can block on a keychain ACL prompt; grant "Always Allow" for the collecting process so subsequent reads succeed.`,
    );
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    log(
      `claude: macOS keychain entry "${CLAUDE_KEYCHAIN_SERVICE}" returned non-JSON content; falling back to legacy ~/.claude/.credentials.json.  The CLI may have stored a non-standard payload.`,
    );
    return null;
  }
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

/**
 * Find the first present key from `candidates` in `record` (supports one level
 * of `a.b` nesting).  Returns `{ key, value }` so the caller can log WHICH key
 * name matched without ever logging the value.
 */
export function resolveCredentialField(record, candidates) {
  const root = asRecord(record);
  for (const candidate of candidates) {
    const parts = candidate.split(".");
    let cursor = root;
    let ok = true;
    for (const part of parts) {
      cursor = asRecord(cursor)[part];
      if (cursor == null) {
        ok = false;
        break;
      }
    }
    if (ok && typeof cursor === "string" && cursor.trim()) {
      return { key: candidate, value: cursor.trim() };
    }
  }
  return null;
}

/**
 * Grok CLI writes `~/.grok/auth.json` as `{ "https://auth.x.ai::<id>": { key, expires_at } }`
 * rather than a flat access_token.  Match the macOS LocalQuotaReader: if the file
 * has exactly one nested object profile, unwrap it.  Never returns token values
 * in a loggable form — callers still go through resolveCredentialField.
 */
export function grokAuthRecord(auth) {
  const root = asRecord(auth);
  const profiles = Object.values(root).filter(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  if (Object.keys(root).length === 1 && profiles.length === 1) return profiles[0];
  return root;
}

async function fetchJson(url, headers) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error && typeof error === "object" ? error.cause : null;
    const code =
      cause && typeof cause === "object"
        ? cause.code || cause.errno || cause.syscall
        : null;
    const host = hostOf(url);
    if (error && error.name === "TimeoutError") {
      throw new Error(`timeout from ${host}`);
    }
    throw new Error(`fetch failed from ${host}${code ? ` (${code})` : ""}`);
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  // Deliberately does NOT include the body: it can carry account identifiers.
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  if (parsed == null) throw new Error(`Non-JSON response from ${new URL(url).host}`);
  return parsed;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}


// -------------------------------------------------------------- gbu CLI ---

/** Resolve the gbu binary.  Never shells; callers use execFile on this path. */
export async function findGbuBin(env = process.env) {
  if (env.GBU_BIN && String(env.GBU_BIN).trim()) {
    const forced = String(env.GBU_BIN).trim();
    try {
      await access(forced, fsConstants.X_OK);
      return forced;
    } catch {
      return null;
    }
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".gbu", "bin", "gbu"),
    join(home, ".local", "bin", "gbu"),
    "/opt/homebrew/bin/gbu",
    "/usr/local/bin/gbu",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Run `gbu --json` with a PATH that includes ~/.gbu/bin and ~/.local/bin so a
 * LaunchAgent that only has Homebrew on PATH still finds the binary when
 * GBU_BIN is unset and findGbuBin somehow missed (symlink races).
 */
export async function runGbuJson({ env = process.env, execFileImpl = execFileAsync } = {}) {
  const bin = await findGbuBin(env);
  if (!bin) return { skipped: "gbu not installed (expected ~/.gbu/bin/gbu or ~/.local/bin/gbu)" };
  const home = env.HOME || env.USERPROFILE || homedir();
  const pathPrefix = `${join(home, ".gbu", "bin")}:${join(home, ".local", "bin")}`;
  const childEnv = {
    ...env,
    PATH: `${pathPrefix}:${env.PATH || "/usr/bin:/bin"}`,
    NO_COLOR: "1",
  };
  let stdout;
  try {
    const result = await execFileImpl(bin, ["--json"], {
      env: childEnv,
      timeout: GBU_TIMEOUT_MS,
      maxBuffer: GBU_MAX_STDOUT_BYTES,
      encoding: "utf8",
    });
    stdout = result.stdout;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null;
    // execFile's timeout kills the child with SIGTERM; its rejection has
    // code=null, signal=SIGTERM, killed=true (not ETIMEDOUT).
    if (error && typeof error === "object" && error.killed === true && error.signal === "SIGTERM") {
      throw new Error("gbu --json timed out");
    }
    const message = error instanceof Error ? error.message : String(error);
    // Never include stdout/stderr: they can carry account emails.
    throw new Error(`gbu --json failed${code ? ` (${code})` : ""}: ${message.split("\n")[0]}`);
  }
  let payload;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch {
    throw new Error("gbu --json returned non-JSON output");
  }
  return { payload, source: "gbu" };
}

// -------------------------------------------------------------- providers ---

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MINIMAX_URLS = [
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
];

const PROVIDERS = {
  claude: {
    provider: "anthropic",
    service: "claude-code",
    producerId: CLAUDE_PRODUCER_ID,
    // Per-producer scoped ingest token (USAGE_INGEST_PRODUCER_TOKENS).
    tokenEnv: "CLAUDE_CODE_INGEST_TOKEN",
    defaultSource: hostOf(CLAUDE_USAGE_URL),
    parse: (payload, context) => parseClaudeUsage(payload, context),
    async fetch() {
      // Modern Claude Code stores its OAuth credential in the macOS
      // keychain under service "Claude Code-credentials"; the legacy
      // ~/.claude/.credentials.json path is honored only as a fallback
      // for older CLI releases that still write the file.  Read-only:
      // we never refresh or modify it here (would race Claude Code's own
      // refresh and could invalidate the CLI's token).
      const credentials =
        (await readClaudeCredentialsFromKeychain()) ??
        (await readJson(
          join(expandHome(process.env.CLAUDE_HOME || "~/.claude"), ".credentials.json"),
        ));
      const oauth = asRecord(asRecord(credentials).claudeAiOauth);
      const token = resolveCredentialField(oauth, ["accessToken", "access_token"]);
      if (!token) return { skipped: "no Claude Code OAuth credential found" };
      const expiresAt = Number(oauth.expiresAt ?? oauth.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        // Refreshing here would race Claude Code's own refresh and could
        // invalidate the CLI's token.  Claude Code refreshes on next use.
        return { skipped: "Claude Code access token is expired; skipping this tick" };
      }
      const planType =
        typeof oauth.subscriptionType === "string" ? oauth.subscriptionType.trim() : null;
      const payload = await fetchJson(CLAUDE_USAGE_URL, {
        authorization: `Bearer ${token.value}`,
        "anthropic-beta": "oauth-2025-04-20",
      });
      return { payload, context: { planType }, source: hostOf(CLAUDE_USAGE_URL) };
    },
  },

  codex: {
    provider: "openai",
    service: "codex-cli",
    producerId: CODEX_PRODUCER_ID,
    // Per-producer scoped ingest token (USAGE_INGEST_PRODUCER_TOKENS).
    tokenEnv: "CODEX_INGEST_TOKEN",
    defaultSource: hostOf(CODEX_USAGE_URL),
    parse: (payload, context) => parseCodexUsage(payload, context),
    async fetch() {
      const path = join(expandHome(process.env.CODEX_HOME || "~/.codex"), "auth.json");
      const auth = await readJson(path);
      const tokens = asRecord(asRecord(auth).tokens);
      const token = resolveCredentialField(tokens, ["access_token", "accessToken"]);
      if (!token) return { skipped: "no Codex CLI credential found" };
      const accountId = resolveCredentialField(tokens, ["account_id", "accountId"]);
      const planType = planTypeFromCodexAuth(auth);
      const headers = {
        authorization: `Bearer ${token.value}`,
        "user-agent": "codex-cli",
      };
      if (accountId) headers["chatgpt-account-id"] = accountId.value;
      const payload = await fetchJson(CODEX_USAGE_URL, headers);
      return { payload, context: { planType }, source: hostOf(CODEX_USAGE_URL) };
    },
  },

  grok: {
    provider: "xai",
    service: "grok-cli",
    producerId: GROK_PRODUCER_ID,
    // Per-producer scoped ingest token (USAGE_INGEST_PRODUCER_TOKENS).
    tokenEnv: "GROK_INGEST_TOKEN",
    defaultSource: hostOf(GROK_BILLING_URL),
    parse: (payload) => parseGrokBilling(payload),
    async fetch({ debug }) {
      const path = join(expandHome(process.env.GROK_HOME || "~/.grok"), "auth.json");
      const auth = grokAuthRecord(await readJson(path));
      const token = resolveCredentialField(auth, [
        "key",
        "access_token",
        "accessToken",
        "token",
        "api_key",
        "apiKey",
        "tokens.access_token",
        "tokens.accessToken",
        "auth.access_token",
      ]);
      if (!token) return { skipped: "no Grok CLI credential found" };
      const expiresAt = Date.parse(String(auth.expires_at ?? auth.expiresAt ?? ""));
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        return { skipped: "Grok CLI access token is expired; skipping this tick" };
      }
      // Log the key NAME only, never the value — the key layout is undocumented
      // and knowing which name matched is what makes a bad tick diagnosable.
      if (debug) log(`grok credential matched key name "${token.key}"`);
      const payload = await fetchJson(GROK_BILLING_URL, {
        authorization: `Bearer ${token.value}`,
      });
      return { payload, source: hostOf(GROK_BILLING_URL) };
    },
  },

  minimax: {
    provider: "minimax",
    service: "minimax-code",
    producerId: MINIMAX_PRODUCER_ID,
    // Per-producer scoped ingest token (USAGE_INGEST_PRODUCER_TOKENS).
    tokenEnv: "MINIMAX_INGEST_TOKEN",
    defaultSource: hostOf(MINIMAX_URLS[0]),
    parse: (payload) => parseMinimaxRemains(payload),
    async fetch({ debug }) {
      const path = expandHome(process.env.MINIMAX_CONFIG_PATH || "~/.mmx/config.json");
      const config = await readJson(path);
      const key = resolveCredentialField(config, [
        "api_key",
        "apiKey",
        "key",
        "token",
        "auth.api_key",
        "auth.apiKey",
      ]);
      if (!key) return { skipped: "no MiniMax credential found" };
      if (debug) log(`minimax credential matched key name "${key.key}"`);
      const configuredBase = resolveCredentialField(config, ["base_url", "baseUrl", "baseURL"]);
      const urls = configuredBase
        ? [
            `${configuredBase.value.replace(/\/+$/, "")}/v1/api/openplatform/coding_plan/remains`,
            ...MINIMAX_URLS,
          ]
        : MINIMAX_URLS;
      let lastError = null;
      for (const url of urls) {
        try {
          const payload = await fetchJson(url, { authorization: `Bearer ${key.value}` });
          return { payload, source: hostOf(url) };
        } catch (error) {
          // api.minimax.io and api.minimaxi.com are region mirrors; a 4xx on one
          // is routinely a "wrong region for this account", not a bad key.
          lastError = error;
        }
      }
      throw lastError ?? new Error("MiniMax request failed");
    },
  },

  "grok-bot": {
    provider: "grok-bot",
    service: "gbu",
    producerId: GBU_PRODUCER_ID,
    // Per-producer scoped ingest token (USAGE_INGEST_PRODUCER_TOKENS).
    // Falls back to SUBSCRIPTION_QUOTA_INGEST_TOKEN / USAGE_INGEST_TOKEN.
    // Document GBU_INGEST_TOKEN for Jay when scoped tokens are required.
    tokenEnv: "GBU_INGEST_TOKEN",
    defaultSource: "gbu",
    parse: (payload) => parseGbuJson(payload),
    async fetch() {
      return runGbuJson();
    },
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);

// --------------------------------------------------------------- CLI body ---

export function parseArgs(argv) {
  const args = {
    providers: PROVIDER_KEYS,
    dryRun: argv.includes("--dry-run"),
    redacted: argv.includes("--redacted"),
    debug: argv.includes("--debug"),
    fixture: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--provider" && argv[i + 1]) {
      const value = argv[i + 1].trim().toLowerCase();
      if (value !== "all") {
        if (!PROVIDER_KEYS.includes(value)) {
          throw new Error(`Unknown --provider ${value}; expected one of ${PROVIDER_KEYS.join(", ")}, all`);
        }
        args.providers = [value];
      }
    }
    if (argv[i] === "--fixture" && argv[i + 1]) {
      args.fixture = argv[i + 1];
    }
  }
  if (args.fixture && args.providers.length !== 1) {
    throw new Error("--fixture requires a single --provider");
  }
  return args;
}

/** Turn one provider's raw payload into ingest events.  Pure; used by tests. */
export function eventsForProvider(providerKey, payload, { context, source, occurredAtIso } = {}) {
  const definition = PROVIDERS[providerKey];
  if (!definition) throw new Error(`Unknown provider ${providerKey}`);
  const readings = definition.parse(payload, context ?? {});
  // A window whose remaining percent we could not read is dropped, not posted.
  // The read path's "N/A remaining means none remains" rule is an Antigravity
  // ruling (owner 2026-09-04); applying it to a field-name mismatch would tell
  // the user their Grok plan is exhausted when we simply failed to parse it.
  // A provider with nothing postable shows the honest "no quota report yet" row.
  return readings
    .filter((r) => !r.remainingUnknown && r.remainingPercent != null)
    .map((r) =>
      buildQuotaEvent({
        provider: definition.provider,
        service: definition.service,
        reading: r,
        source: source ?? definition.defaultSource,
        occurredAtIso: occurredAtIso ?? new Date().toISOString(),
      }),
    );
}

function summarise(providerKey, events, { redacted }) {
  const definition = PROVIDERS[providerKey];
  for (const event of events) {
    const meta = event.metadata;
    const remaining = event.credits == null ? "not reported" : `${event.credits}%`;
    log(
      `${definition.provider} | ${event.label} | remaining ${remaining} | resets ${
        meta.resetAt ?? "unknown"
      } | plan ${meta.planType ?? "unknown"}`,
    );
  }
  if (!redacted) {
    // Still safe: these events carry only derived numbers, labels and ISO dates.
    log(`${providerKey} events: ${JSON.stringify(events)}`);
  }
}

async function collectProvider(providerKey, args) {
  const definition = PROVIDERS[providerKey];
  try {
    let payload;
    let context = {};
    let source = definition.defaultSource;
    if (args.fixture) {
      payload = await readJson(args.fixture);
      if (payload == null) {
        return { providerKey, status: "failed", error: `unreadable fixture ${args.fixture}`, events: [] };
      }
      source = `fixture:${definition.defaultSource}`;
    } else {
      const result = await definition.fetch({ debug: args.debug });
      if (result.skipped) {
        log(`${providerKey}: ${result.skipped}`);
        return { providerKey, status: "skipped", events: [] };
      }
      payload = result.payload;
      context = result.context ?? {};
      source = result.source ?? source;
    }
    const parsedWindows = definition.parse(payload, context).length;
    const events = eventsForProvider(providerKey, payload, { context, source });
    if (events.length === 0) {
      log(
        parsedWindows > 0
          ? `${providerKey}: ${parsedWindows} window(s) parsed but none reported a remaining percentage; run with --debug and check the field names in scripts/lib/subscription-quota-parsers.mjs`
          : `${providerKey}: response parsed but reported no quota windows`,
      );
      return { providerKey, status: "skipped", events: [] };
    }
    summarise(providerKey, events, { redacted: args.redacted });
    return { providerKey, status: "ok", events };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${providerKey}: FAILED (${message})`);
    return { providerKey, status: "failed", error: message, events: [] };
  }
}

/**
 * Token lookup order for one provider's batch: that producer's scoped token
 * first, then the legacy collector-wide names.  With
 * USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true only the first can succeed, because
 * a scoped token authorizes exactly one producerId.
 */
export function ingestTokenEnvNames(definition) {
  return [
    ...(definition.tokenEnv ? [definition.tokenEnv] : []),
    "SUBSCRIPTION_QUOTA_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ];
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(`[subscription-quota-collector] ${error.message}`);
    process.exit(2);
  }

  const results = [];
  for (const providerKey of args.providers) {
    // Sequential on purpose: one failing provider must not stop the others, and
    // four parallel OAuth calls from a laptop is a good way to get rate limited.
    results.push(await collectProvider(providerKey, args));
  }

  const withEvents = results.filter((r) => r.events.length > 0);
  if (withEvents.length > 0 && !args.dryRun) {
    for (const result of withEvents) {
      const definition = PROVIDERS[result.providerKey];
      // Each provider posts as its own producerId, and a scoped ingest token
      // only authorizes its own producer, so resolve one token per producer.
      const token = resolveCollectorToken(ingestTokenEnvNames(definition));
      try {
        const ack = await postUsageBatches({
          events: result.events,
          ingestUrl: INGEST_URL,
          ingestToken: token,
          producerId: definition.producerId,
          dryRun: false,
          log,
        });
        log(
          `${result.providerKey} ingest ack: received=${ack.received} persisted=${ack.persisted} rejected=${ack.rejected}`,
        );
        if (ack.rejected > 0) result.status = "failed";
      } catch (error) {
        result.status = "failed";
        log(
          `${result.providerKey}: ingest FAILED (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  } else if (withEvents.length > 0) {
    log(`--dry-run; not posting ${withEvents.reduce((n, r) => n + r.events.length, 0)} event(s)`);
  }

  const summary = results.map((r) => `${r.providerKey}=${r.status}`).join(" ");
  log(`pass complete: ${summary}`);

  // Exit 1 only when EVERY provider failed.  A skipped provider (no credential,
  // expired token) is an expected state on a machine that does not use it.
  const anySucceeded = results.some((r) => r.status === "ok" || r.status === "skipped");
  process.exit(anySucceeded ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[subscription-quota-collector] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { PROVIDERS, fetchJson, hostOf };
