#!/usr/bin/env node
/**
 * local-keys-bundle.mjs — Mac-side generator for the Usage Monitor Local
 * key-propagation bundle (.umkeys).
 *
 * Cross-language contract (pinned; the iOS importer is the other lane):
 *   envelope  = { format: "usage-monitor-local-keys", formatVersion: 1,
 *                 kdf: "pbkdf2-hmac-sha256", iterations, salt (b64, 16 bytes),
 *                 nonce (b64, 12 bytes), ciphertext (b64, AES-256-GCM with the
 *                 16-byte tag APPENDED) }
 *   key       = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)
 *   payload   = { format: "usage-monitor-local-keys-payload", formatVersion: 1,
 *                 createdAt, secrets: [{ provider, apiKey, teamId?,
 *                 accountSid?, apiKeySid? }], config? }
 *
 * Security rules (binding):
 *   - No secret VALUE is ever printed, logged, or embedded in an error.
 *     Names and counts only.
 *   - The passphrase comes from --passphrase-file (chmod 600), never argv.
 *
 * Subcommands:
 *   list                       Print the provider -> source-env table and presence.
 *   build  --passphrase-file <path> --out <path.umkeys>
 *          [--providers a,b,c] [--config <local-export.json>]
 *          [--secrets-file <path>] [--iterations <n>]
 *   Keys come from `fleet-secrets` (OPS-818).  --secrets-file names a KEY=VALUE
 *   fixture file for tests;  never point it at the retired flat secrets file.
 *   verify --passphrase-file <path> <path.umkeys>
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fleetSecretsGet, fleetSecretsNames } from "./lib/fleet-secrets.mjs";

// ---------------------------------------------------------------------------
// THE MAP — catalog provider slug -> source env name(s) in the secrets file.
//
// Derived 2026-08-12 from:
//   ios/UsageMonitor/UsageMonitorKit/Sources/LocalAdapters/LocalProviderCatalog.swift
//     (phonePollAdapterKinds ∩ mode == .poll — only entries the phone can
//      actually poll with a key; LocalAppModel additionally validates that
//      xai carries a teamId and twilio an accountSid)
//   the fleet secret store's key NAMES (never values) + .env.example.
//
// | provider   | apiKey source env                                   | extra fields          | notes |
// |------------|-----------------------------------------------------|-----------------------|-------|
// | openrouter | OPENROUTER_ADMIN_KEY                                 |                       | Management key for MTD spend (CT_/ST_ inference keys are wrong-scope). |
// | openai     | OPENAI_ADMIN_KEY                                     |                       | Org Admin key for the Costs API. |
// | anthropic  | ANTHROPIC_ADMIN_KEY                                  |                       | No admin key name exists in the secrets file today — listed Absent. |
// | deepseek   | DEEPSEEK_API_KEY                                     |                       | Balance poll; absent from the file today. |
// | xai        | XAI_MANAGEMENT_KEY                                   | teamId: XAI_TEAM_ID   | Phone import rejects xai without teamId. |
// | hetzner    | HCLOUD_TOKEN                                         |                       | Project API token (HETZNER_ROOT is web login material, not an API token). |
// | backblaze  | BACKBLAZE_MASTER_KEY_ID + BACKBLAZE_MASTER_APPLICATION_KEY | (joined "id:key") | Phone expects "keyId:applicationKey" in the key field.  Prefer a read-only key when one lands in the file. |
// | twelvedata | TWELVEDATA_API_KEY                                   |                       | |
// | stripe     | STRIPE_SECRET_KEY                                    |                       | Prefer a restricted read key (rk_live_...) per repo guidance. |
// | resend     | RESEND_API_KEY                                       |                       | |
// | pushover   | PUSHOVER_USAGE_API_TOKEN                             |                       | Usage Monitor app token; phone polls apps/limits.json. |
// | apify      | APIFY_TOKEN                                          |                       | Absent from the file today. |
// | firecrawl  | FIRECRAWL_API_KEY                                    |                       | Absent from the file today. |
// | twilio     | EXCLUDED                                             |                       | TWILIO_MCP_CREDS is a combined blob; needs a clean TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN pair (phone requires accountSid). |
// ---------------------------------------------------------------------------
export const PROVIDER_SOURCES = [
  { provider: "openrouter", apiKeyEnv: "OPENROUTER_ADMIN_KEY" },
  { provider: "openai", apiKeyEnv: "OPENAI_ADMIN_KEY" },
  { provider: "anthropic", apiKeyEnv: "ANTHROPIC_ADMIN_KEY" },
  { provider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { provider: "xai", apiKeyEnv: "XAI_MANAGEMENT_KEY", teamIdEnv: "XAI_TEAM_ID" },
  { provider: "hetzner", apiKeyEnv: "HCLOUD_TOKEN" },
  {
    provider: "backblaze",
    compositeEnvs: ["BACKBLAZE_MASTER_KEY_ID", "BACKBLAZE_MASTER_APPLICATION_KEY"],
    compositeJoin: ":",
  },
  { provider: "twelvedata", apiKeyEnv: "TWELVEDATA_API_KEY" },
  { provider: "stripe", apiKeyEnv: "STRIPE_SECRET_KEY" },
  { provider: "resend", apiKeyEnv: "RESEND_API_KEY" },
  { provider: "pushover", apiKeyEnv: "PUSHOVER_USAGE_API_TOKEN" },
  { provider: "apify", apiKeyEnv: "APIFY_TOKEN" },
  { provider: "firecrawl", apiKeyEnv: "FIRECRAWL_API_KEY" },
];

export const EXCLUDED_PROVIDERS = [
  {
    provider: "twilio",
    reason:
      "TWILIO_MCP_CREDS is a combined blob.  Add a clean TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN pair to include Twilio.",
  },
];

export const ENVELOPE_FORMAT = "usage-monitor-local-keys";
export const PAYLOAD_FORMAT = "usage-monitor-local-keys-payload";
export const FORMAT_VERSION = 1;
export const KDF = "pbkdf2-hmac-sha256";
export const DEFAULT_ITERATIONS = 600000;
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 5000000;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

class CliError extends Error {}

// ---------------------------------------------------------------------------
// Secrets-file handling (names in, values kept opaque)
// ---------------------------------------------------------------------------

/** Parse KEY="value" lines; strips one layer of matching quotes. */
export function parseSecretsFile(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(match[1], value);
  }
  return map;
}

/** Every env name PROVIDER_SOURCES can read, deduplicated. */
function sourceEnvNames() {
  const names = new Set();
  for (const source of PROVIDER_SOURCES) {
    if (source.apiKeyEnv) names.add(source.apiKeyEnv);
    if (source.teamIdEnv) names.add(source.teamIdEnv);
    for (const name of source.compositeEnvs ?? []) names.add(name);
  }
  return names;
}

/** Name -> value map for `build`: from a fixture file, else fleet-secrets. */
function readSecretsMap(secretsPath) {
  if (secretsPath === undefined) {
    const map = new Map();
    for (const name of sourceEnvNames()) {
      const value = fleetSecretsGet(name);
      if (value) map.set(name, value);
    }
    return map;
  }
  let text;
  try {
    text = fs.readFileSync(secretsPath, "utf8");
  } catch {
    throw new CliError(`Cannot read secrets file at ${secretsPath}.`);
  }
  return parseSecretsFile(text);
}

/** Names only for `list`: values never leave the store. */
function readSecretNames(secretsPath) {
  if (secretsPath === undefined) {
    const names = fleetSecretsNames();
    if (names.size === 0) {
      throw new CliError("fleet-secrets returned no key names.  Run: fleet-secrets doctor");
    }
    return names;
  }
  return new Set(readSecretsMap(secretsPath).keys());
}

/** Refuse group/world-readable passphrase files; read and trim one trailing newline. */
export function readPassphraseFile(passphrasePath) {
  // Stat and read through ONE file descriptor so the permission check and the
  // read cannot be split by a path swap (TOCTOU).  A stat-then-read on the
  // path would validate one file and read another.
  let fd;
  try {
    fd = fs.openSync(passphrasePath, "r");
  } catch {
    throw new CliError(`Cannot read passphrase file at ${passphrasePath}.`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if ((stat.mode & 0o077) !== 0) {
      throw new CliError(
        `Refusing to use ${passphrasePath}: it is group- or world-readable.  Run chmod 600 on it first.`
      );
    }
    const passphrase = fs.readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (passphrase === "") {
      throw new CliError("Passphrase file is empty.");
    }
    return passphrase;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Crypto (contract-pinned; keep byte-compatible with the Swift importer)
// ---------------------------------------------------------------------------

export function deriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
}

export function encryptPayload(payload, passphrase, options = {}) {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  validateIterations(iterations);
  const salt = options.salt ?? crypto.randomBytes(SALT_BYTES);
  const nonce = options.nonce ?? crypto.randomBytes(NONCE_BYTES);
  const key = deriveKey(passphrase, salt, iterations);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  return {
    format: ENVELOPE_FORMAT,
    formatVersion: FORMAT_VERSION,
    kdf: KDF,
    iterations,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function validateIterations(iterations) {
  if (!Number.isInteger(iterations)) {
    throw new CliError("Envelope iterations must be an integer.");
  }
  if (iterations < MIN_ITERATIONS) {
    throw new CliError(
      `Envelope iterations ${iterations} is below the minimum ${MIN_ITERATIONS}.  Rejecting a weak key derivation.`
    );
  }
  if (iterations > MAX_ITERATIONS) {
    throw new CliError(
      `Envelope iterations ${iterations} is above the maximum ${MAX_ITERATIONS}.  Rejecting a denial-of-service key derivation.`
    );
  }
}

export function decryptEnvelope(envelope, passphrase) {
  if (typeof envelope !== "object" || envelope === null) {
    throw new CliError("Envelope is not a JSON object.");
  }
  if (envelope.format !== ENVELOPE_FORMAT) {
    throw new CliError(`Envelope format is not "${ENVELOPE_FORMAT}".`);
  }
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw new CliError(`Envelope formatVersion is not ${FORMAT_VERSION}.`);
  }
  if (envelope.kdf !== KDF) {
    throw new CliError(`Envelope kdf is not "${KDF}".`);
  }
  validateIterations(envelope.iterations);
  const salt = Buffer.from(String(envelope.salt), "base64");
  const nonce = Buffer.from(String(envelope.nonce), "base64");
  const ciphertext = Buffer.from(String(envelope.ciphertext), "base64");
  if (salt.length !== SALT_BYTES) {
    throw new CliError(`Envelope salt must decode to ${SALT_BYTES} bytes.`);
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new CliError(`Envelope nonce must decode to ${NONCE_BYTES} bytes.`);
  }
  if (ciphertext.length <= TAG_BYTES) {
    throw new CliError("Envelope ciphertext is too short to carry an auth tag.");
  }
  const key = deriveKey(passphrase, salt, envelope.iterations);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new CliError("Decryption failed.  Check the passphrase and the bundle file.");
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CliError("Decrypted payload is not valid JSON.");
  }
  if (payload.format !== PAYLOAD_FORMAT || payload.formatVersion !== FORMAT_VERSION) {
    throw new CliError("Decrypted payload has an unexpected format or version.");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Secret collection (names and counts only in every printed line)
// ---------------------------------------------------------------------------

function sourceLabel(source) {
  if (source.compositeEnvs) return source.compositeEnvs.join(" + ");
  return source.teamIdEnv ? `${source.apiKeyEnv} + ${source.teamIdEnv}` : source.apiKeyEnv;
}

function hasValue(map, name) {
  const value = map.get(name);
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve one provider against the secrets map.
 * Returns { status: "present", secret } | { status: "absent" | "partial", note }.
 * The returned note never contains a value.
 */
/**
 * Presence verdict for one provider from key NAMES alone.  `list` uses this
 * instead of resolveProvider so no code path that touches secret values feeds
 * the printed table — the same rules, evaluated over a Set of names.
 */
export function providerPresence(source, presentNames) {
  if (source.compositeEnvs) {
    const missing = source.compositeEnvs.filter((name) => !presentNames.has(name));
    if (missing.length === source.compositeEnvs.length) return { status: "absent" };
    if (missing.length > 0) return { status: "partial", note: `missing ${missing.join(", ")}` };
    return { status: "present" };
  }
  if (!presentNames.has(source.apiKeyEnv)) return { status: "absent" };
  if (source.teamIdEnv && !presentNames.has(source.teamIdEnv)) {
    return { status: "partial", note: `${source.apiKeyEnv} is set but ${source.teamIdEnv} is missing` };
  }
  return { status: "present" };
}

export function resolveProvider(source, secretsMap) {
  if (source.compositeEnvs) {
    const missing = source.compositeEnvs.filter((name) => !hasValue(secretsMap, name));
    if (missing.length === source.compositeEnvs.length) {
      return { status: "absent", note: `${sourceLabel(source)} not set` };
    }
    if (missing.length > 0) {
      return { status: "partial", note: `missing ${missing.join(", ")}` };
    }
    const apiKey = source.compositeEnvs
      .map((name) => secretsMap.get(name).trim())
      .join(source.compositeJoin);
    return { status: "present", secret: { provider: source.provider, apiKey } };
  }
  if (!hasValue(secretsMap, source.apiKeyEnv)) {
    return { status: "absent", note: `${source.apiKeyEnv} not set` };
  }
  const secret = { provider: source.provider, apiKey: secretsMap.get(source.apiKeyEnv).trim() };
  if (source.teamIdEnv) {
    if (!hasValue(secretsMap, source.teamIdEnv)) {
      return { status: "partial", note: `${source.apiKeyEnv} is set but ${source.teamIdEnv} is missing` };
    }
    secret.teamId = secretsMap.get(source.teamIdEnv).trim();
  }
  return { status: "present", secret };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdList(args) {
  const secretsPath = args.get("--secrets-file");
  // Names only: `fleet-secrets names` never returns a value, and a fixture
  // file's values are discarded at the parse boundary, so nothing
  // value-bearing can reach the console below.
  const presentNames = readSecretNames(secretsPath);
  const rows = PROVIDER_SOURCES.map((source) => {
    const presence = providerPresence(source, presentNames);
    const status =
      presence.status === "present"
        ? "Present"
        : presence.status === "partial"
          ? `Partial (${presence.note})`
          : "Absent";
    return { provider: source.provider, source: sourceLabel(source), status };
  });
  const providerWidth = Math.max(8, ...rows.map((row) => row.provider.length));
  const sourceWidth = Math.max(10, ...rows.map((row) => row.source.length));
  console.log("Local Keys Bundle — Provider Sources");
  console.log(`Secrets source: ${secretsPath ?? "fleet-secrets"} (names checked, values never printed)`);
  console.log("");
  console.log(`  ${"Provider".padEnd(providerWidth)}  ${"Source Env".padEnd(sourceWidth)}  Status`);
  for (const row of rows) {
    console.log(`  ${row.provider.padEnd(providerWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.status}`);
  }
  console.log("");
  for (const excluded of EXCLUDED_PROVIDERS) {
    console.log(`Excluded: ${excluded.provider} — ${excluded.reason}`);
  }
}

function cmdBuild(args) {
  const passphrasePath = requireArg(args, "--passphrase-file");
  const outPath = requireArg(args, "--out");
  const secretsPath = args.get("--secrets-file");
  const iterations = args.has("--iterations")
    ? Number.parseInt(args.get("--iterations"), 10)
    : DEFAULT_ITERATIONS;

  let requested = null;
  if (args.has("--providers")) {
    requested = args
      .get("--providers")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    const known = new Set(PROVIDER_SOURCES.map((source) => source.provider));
    const excludedNames = new Set(EXCLUDED_PROVIDERS.map((entry) => entry.provider));
    for (const name of requested) {
      if (excludedNames.has(name)) {
        const excluded = EXCLUDED_PROVIDERS.find((entry) => entry.provider === name);
        throw new CliError(`Provider "${name}" is excluded.  ${excluded.reason}`);
      }
      if (!known.has(name)) {
        throw new CliError(
          `Unknown provider "${name}".  Known providers: ${[...known].join(", ")}.`
        );
      }
    }
  }

  let config;
  if (args.has("--config")) {
    const configPath = args.get("--config");
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new CliError(`Config file at ${configPath} is missing or not valid JSON.`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.format !== "usage-monitor-local-export" ||
      parsed.formatVersion !== 1
    ) {
      throw new CliError(
        'Config file must be a complete "usage-monitor-local-export" v1 object.'
      );
    }
    config = parsed;
  }

  const passphrase = readPassphraseFile(passphrasePath);
  const secretsMap = readSecretsMap(secretsPath);

  const secrets = [];
  // Names-only mirror of `secrets`, kept separate so the console summary below
  // never reads from the objects that carry values.
  const includedProviders = [];
  const skipped = [];
  const sources = requested
    ? PROVIDER_SOURCES.filter((source) => requested.includes(source.provider))
    : PROVIDER_SOURCES;
  for (const source of sources) {
    const resolved = resolveProvider(source, secretsMap);
    if (resolved.status === "present") {
      secrets.push(resolved.secret);
      includedProviders.push(source.provider);
    } else {
      skipped.push(`${source.provider} (${resolved.note})`);
    }
  }
  if (secrets.length === 0) {
    throw new CliError("No provider keys found to bundle.  Nothing was written.");
  }

  const payload = {
    format: PAYLOAD_FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    secrets,
  };
  if (config) payload.config = config;

  const envelope = encryptPayload(payload, passphrase, { iterations });

  // Atomic write: temp file in the destination directory, then rename, so a
  // failure can never leave a partial bundle behind.
  const directory = path.dirname(path.resolve(outPath));
  const tempPath = path.join(directory, `.${path.basename(outPath)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  console.log("Local Keys Bundle Built");
  console.log(`Included providers (${includedProviders.length}): ${includedProviders.join(", ")}`);
  for (const note of skipped) {
    console.log(`Skipped: ${note}`);
  }
  for (const excluded of EXCLUDED_PROVIDERS) {
    if (!requested) console.log(`Excluded: ${excluded.provider} — ${excluded.reason}`);
  }
  console.log(`Config section embedded: ${config ? "yes" : "no"}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Wrote ${outPath} (chmod 600).  Keep the passphrase off this Mac's clipboard.`);
}

function cmdVerify(args, positionals) {
  const passphrasePath = requireArg(args, "--passphrase-file");
  if (positionals.length !== 1) {
    throw new CliError("Usage: verify --passphrase-file <path> <path.umkeys>");
  }
  const bundlePath = positionals[0];
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  } catch {
    throw new CliError(`Bundle file at ${bundlePath} is missing or not valid JSON.`);
  }
  const passphrase = readPassphraseFile(passphrasePath);
  const payload = decryptEnvelope(envelope, passphrase);
  const providers = Array.isArray(payload.secrets)
    ? payload.secrets.map((secret) => secret && secret.provider).filter(Boolean)
    : [];
  console.log("Local Keys Bundle Verified");
  console.log(`Payload format: ${payload.format} v${payload.formatVersion}`);
  console.log(`Created at: ${payload.createdAt}`);
  console.log(`Providers (${providers.length}): ${providers.join(", ")}`);
  console.log(`Config section embedded: ${payload.config ? "yes" : "no"}`);
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const FLAG_NAMES = new Set([
  "--passphrase-file",
  "--out",
  "--providers",
  "--config",
  "--secrets-file",
  "--iterations",
]);

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAG_NAMES.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError(`Flag ${token} needs a value.`);
      }
      flags.set(token, value);
      index += 1;
    } else if (token.startsWith("--")) {
      throw new CliError(`Unknown flag ${token}.`);
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function requireArg(flags, name) {
  const value = flags.get(name);
  if (value === undefined) {
    throw new CliError(`Missing required flag ${name}.`);
  }
  return value;
}

export function runCli(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  switch (subcommand) {
    case "list":
      cmdList(flags);
      return 0;
    case "build":
      cmdBuild(flags);
      return 0;
    case "verify":
      cmdVerify(flags, positionals);
      return 0;
    default:
      throw new CliError(
        "Usage: local-keys-bundle.mjs <list|build|verify> [flags].  See the header comment for details."
      );
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
    } else {
      // Never echo unexpected error payloads; they can carry command context.
      console.error(`Error: unexpected failure (${error?.constructor?.name ?? "unknown"}).`);
    }
    process.exitCode = 1;
  }
}
