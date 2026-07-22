import { Prisma } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  decrypt,
  encrypt,
  encryptJson,
  managedApiKeyFingerprint,
} from "@/lib/crypto";
import { geminiApiKeyFingerprint } from "@/lib/gemini-key-status";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";
import { prisma } from "@/lib/prisma";
import {
  BUILT_IN_PROVIDERS,
  isBuiltInProviderActive,
} from "@/lib/provider-definitions";
import {
  readStPrimaryCredentialBinding,
  ST_PRIMARY_MANAGED_LABEL,
} from "@/lib/managed-provider-credential";
import {
  canonicalProjectKey,
  canonicalProviderKey,
} from "@/lib/provider-identity";
import {
  decryptProviderSecretConfig,
  hasProviderSecrets,
  mergeProviderConfig,
  providerConfigForServer,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

export type InfisicalCredentialScope = "st" | "ct" | "shared" | "st-primary";

export interface InfisicalCredentialSyncSourceResult {
  source: InfisicalCredentialScope;
  configured: boolean;
  status: "disabled" | "unconfigured" | "incomplete" | "synced" | "partial" | "error";
  available: number;
  missing: number;
  failed: number;
  errorCode?: string;
}

export interface InfisicalCredentialSyncResult {
  enabled: boolean;
  configured: boolean;
  sources: InfisicalCredentialSyncSourceResult[];
  created: number;
  updated: number;
  unchanged: number;
  missing: number;
  failed: number;
  /** Mappings intentionally left untouched by a caller-supplied safety gate. */
  suppressed?: number;
}

export interface InfisicalCredentialSyncOptions {
  /**
   * Preserve the exact Socratic Trade Gemini provider after a one-time
   * bootstrap conflict/error instead of adopting a different Infisical value.
   */
  suppressStGemini?: boolean;
}

export type StGeminiInfisicalBootstrapStatus =
  | "disabled"
  | "unconfigured"
  | "ineligible"
  | "already_present_same"
  | "conflict"
  | "created"
  | "error";

export interface StGeminiInfisicalBootstrapResult {
  enabled: boolean;
  attempted: boolean;
  providerId: string;
  status: StGeminiInfisicalBootstrapStatus;
  errorCode?: string;
}

interface SourceDefinition {
  source: InfisicalCredentialScope;
  clientIdEnv: string;
  clientSecretEnv: string;
  projectIdEnv: string;
  pathEnv: string;
  defaultProjectId: string;
}

interface SourceConfig extends SourceDefinition {
  clientId?: string;
  clientSecret?: string;
  projectId: string;
  environment: string;
  secretPath: string;
}

interface SourceRead {
  source: InfisicalCredentialScope;
  authenticated: boolean;
  values: Map<string, string>;
  missing: Set<string>;
  errors: Map<string, string>;
  /** All secret names visible in this scope (from the preflight list). */
  allSecretNames: Set<string>;
  result: InfisicalCredentialSyncSourceResult;
}

interface CredentialMaterial {
  apiKey?: string;
  publicConfig?: Record<string, string>;
  secretConfig?: Record<string, string>;
}

interface CredentialAttempt {
  source: InfisicalCredentialScope;
  required: readonly string[];
  optional?: readonly string[];
}

interface CredentialMapping {
  scope: InfisicalCredentialScope;
  providerName: string;
  attempts: readonly CredentialAttempt[];
  /**
   * The source value is a comma-delimited list of independent API keys. Each
   * key becomes its own Provider row rather than treating the whole list as
   * one credential. Only enable this for providers whose upstream contract
   * explicitly accepts the same list shape (currently LlamaParse).
   */
  splitApiKeyList?: boolean;
  build(values: ReadonlyMap<string, string>): CredentialMaterial;
}

interface CredentialCandidate {
  scope: InfisicalCredentialScope;
  source: InfisicalCredentialScope;
  providerName: string;
  material: CredentialMaterial;
  /** Server-only stable identity for one member of a split API-key list. */
  keyFingerprint?: string;
  /** Used only to safely adopt a pre-list binding during the first split sync. */
  keyListOrdinal?: number;
}

interface StoredBinding {
  scope: InfisicalCredentialScope;
  source: InfisicalCredentialScope;
  providerName: string;
  sequence?: number;
  status?: "active" | "revoked";
  fingerprint?: string | null;
  /** Server-only SHA-256 identity for a split API-key-list member. */
  keyFingerprint?: string;
  aliasOfProviderId?: string;
}

interface StPrimaryManifestEntry {
  id: "gemini.apiKey" | "deepseek.apiKey";
  providerName: "google-ai" | "deepseek";
  capability: "apiKey";
  secretName: "GEMINI_API_KEY" | "DEEPSEEK_API_KEY";
  status: "active" | "revoked";
  fingerprint: string | null;
}

interface StPrimaryManifest {
  schemaVersion: 1;
  source: "socratic-trade-primary";
  complete: true;
  sequence: number;
  entries: StPrimaryManifestEntry[];
}

interface StPrimaryBridgeRead {
  manifest: StPrimaryManifest;
  values: Map<StPrimaryManifestEntry["id"], string>;
}

type ProviderRecord = Prisma.ProviderGetPayload<{
  include: { allocations: { select: { projectId: true; percentage: true } } };
}>;

class InfisicalSyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InfisicalSyncError";
  }
}

const DEFAULT_BASE_URL = "https://app.infisical.com";
const DEFAULT_ENVIRONMENT = "prod";
const DEFAULT_SECRET_PATH = "/";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
// A comma-separated provider secret is deliberately a small account list,
// not an unbounded account-creation interface. Individual API keys are much
// shorter in practice; 4 KiB is a generous ceiling while keeping a malformed
// source value from becoming a large encrypted Provider field.
const MAX_SPLIT_API_KEYS = 25;
const MAX_SPLIT_API_KEY_BYTES = 4 * 1024;
const ST_GEMINI_BOOTSTRAP_FLAG = "INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED";
const ST_GEMINI_PROVIDER_ID = "4a888d41-3988-4774-86d8-67d7aa14d7e2";
const ST_GEMINI_SECRET_NAME = "GEMINI_API_KEY";
const ST_PROJECT_NAME = "SocraticTrade.com";
const ST_GEMINI_VALIDATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ST_PRIMARY_SYNC_FLAG = "INFISICAL_ST_PRIMARY_SYNC_ENABLED";
const ST_PRIMARY_SECRET_PATH = "/usage-monitor/st-primary/v1";
const ST_PRIMARY_MANIFEST_SECRET = "BRIDGE_MANIFEST_V1";
const ST_PRIMARY_CLIENT_ID_ENV = "INFISICAL_ST_PRIMARY_CLIENT_ID";
const ST_PRIMARY_CLIENT_SECRET_ENV = "INFISICAL_ST_PRIMARY_CLIENT_SECRET";
const MAX_BRIDGE_MANIFEST_BYTES = 8 * 1024;
const ST_PRIMARY_ENTRY_CONTRACT = {
  "gemini.apiKey": {
    providerName: "google-ai",
    secretName: "GEMINI_API_KEY",
  },
  "deepseek.apiKey": {
    providerName: "deepseek",
    secretName: "DEEPSEEK_API_KEY",
  },
} as const;

// Project IDs identify Infisical projects; they are not credentials. Verified
// defaults keep the Render bootstrap to the three Universal Auth ID/secret
// pairs while still allowing an operator to override an ID or path.
const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    source: "st",
    clientIdEnv: "INFISICAL_ST_CLIENT_ID",
    clientSecretEnv: "INFISICAL_ST_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_ST_PROJECT_ID",
    pathEnv: "INFISICAL_ST_SECRET_PATH",
    defaultProjectId: "39d93bb7-76f9-498c-8b50-a7def52e072f",
  },
  {
    source: "ct",
    clientIdEnv: "INFISICAL_CT_CLIENT_ID",
    clientSecretEnv: "INFISICAL_CT_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_CT_PROJECT_ID",
    pathEnv: "INFISICAL_CT_SECRET_PATH",
    defaultProjectId: "f61a79de-8d77-4f0b-9361-4b7208598290",
  },
  {
    source: "shared",
    clientIdEnv: "INFISICAL_SHARED_CLIENT_ID",
    clientSecretEnv: "INFISICAL_SHARED_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_SHARED_PROJECT_ID",
    pathEnv: "INFISICAL_SHARED_SECRET_PATH",
    defaultProjectId: "18f563a3-9c88-454c-96eb-28fc9678f3ba",
  },
] as const;

function appAttempts(
  source: "st" | "ct",
  required: readonly string[],
  sharedFallback = false,
  optional?: readonly string[]
): readonly CredentialAttempt[] {
  return [
    { source, required, optional },
    ...(sharedFallback ? [{ source: "shared" as const, required, optional }] : []),
  ];
}

// Exact allowlist derived from the three project roots and limited to keys a
// current monitor adapter can validate or use for usage/quota/billing. Blind
// market-data adapters and all brokerage credentials are intentionally absent.
const CREDENTIAL_MAPPINGS: readonly CredentialMapping[] = [
  {
    scope: "st",
    providerName: "google-ai",
    attempts: appAttempts("st", ["GEMINI_API_KEY"]),
    build: (values) => ({ apiKey: values.get("GEMINI_API_KEY") }),
  },
  {
    scope: "st",
    providerName: "deepseek",
    attempts: appAttempts("st", ["DEEPSEEK_API_KEY"]),
    build: (values) => ({ apiKey: values.get("DEEPSEEK_API_KEY") }),
  },
  {
    scope: "st",
    providerName: "hetzner",
    attempts: appAttempts("st", ["HETZNER_API_TOKEN"]),
    build: (values) => ({ apiKey: values.get("HETZNER_API_TOKEN") }),
  },
  {
    scope: "st",
    providerName: "pinecone",
    attempts: appAttempts("st", ["PINECONE_API_KEY"]),
    build: (values) => ({ apiKey: values.get("PINECONE_API_KEY") }),
  },
  {
    scope: "st",
    providerName: "resend",
    attempts: appAttempts("st", ["RESEND_API_KEY"], true),
    build: (values) => ({ apiKey: values.get("RESEND_API_KEY") }),
  },
  {
    scope: "st",
    providerName: "sentry",
    attempts: appAttempts("st", ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]),
    build: (values) => ({
      apiKey: values.get("SENTRY_AUTH_TOKEN"),
      publicConfig: { orgSlug: values.get("SENTRY_ORG") ?? "" },
    }),
  },
  {
    scope: "st",
    providerName: "openrouter",
    attempts: appAttempts("st", ["OPENROUTER_API_KEY"]),
    build: (values) => ({ apiKey: values.get("OPENROUTER_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "openai",
    // Wave H / E2: optional OPENAI_ADMIN_KEY → secretConfig.adminApiKey for
    // organization Costs authority (see adapters/openai.ts). Prefer pairing
    // with OPENAI_API_KEY; a pure admin-only mapping is not registered so we
    // never create a second openai Provider row when both keys exist.
    attempts: appAttempts("ct", ["OPENAI_API_KEY"], true, ["OPENAI_ADMIN_KEY"]),
    build: (values) => ({
      apiKey: values.get("OPENAI_API_KEY"),
      ...(values.get("OPENAI_ADMIN_KEY")
        ? { secretConfig: { adminApiKey: values.get("OPENAI_ADMIN_KEY")! } }
        : {}),
    }),
  },
  {
    scope: "ct",
    providerName: "anthropic",
    attempts: appAttempts("ct", ["ANTHROPIC_ADMIN_KEY"], true),
    build: (values) => ({
      secretConfig: { adminApiKey: values.get("ANTHROPIC_ADMIN_KEY")! },
    }),
  },
  {
    scope: "st",
    providerName: "anthropic",
    attempts: appAttempts("st", ["ANTHROPIC_ADMIN_KEY"], true),
    build: (values) => ({
      secretConfig: { adminApiKey: values.get("ANTHROPIC_ADMIN_KEY")! },
    }),
  },
  {
    scope: "st",
    providerName: "xai",
    attempts: appAttempts("st", ["XAI_API_KEY"], true, [
      "XAI_TEAM_ID",
      "XAI_MANAGEMENT_KEY",
    ]),
    build: (values) => {
      const teamId = values.get("XAI_TEAM_ID");
      const managementKey = values.get("XAI_MANAGEMENT_KEY");
      return {
        apiKey: values.get("XAI_API_KEY"),
        ...(teamId ? { publicConfig: { teamId } } : {}),
        ...(managementKey ? { secretConfig: { managementKey } } : {}),
      };
    },
  },
  {
    scope: "ct",
    providerName: "xai",
    attempts: appAttempts("ct", ["XAI_API_KEY"], true, [
      "XAI_TEAM_ID",
      "XAI_MANAGEMENT_KEY",
    ]),
    build: (values) => {
      const teamId = values.get("XAI_TEAM_ID");
      const managementKey = values.get("XAI_MANAGEMENT_KEY");
      return {
        apiKey: values.get("XAI_API_KEY"),
        ...(teamId ? { publicConfig: { teamId } } : {}),
        ...(managementKey ? { secretConfig: { managementKey } } : {}),
      };
    },
  },
  {
    scope: "ct",
    providerName: "deepseek",
    attempts: appAttempts("ct", ["DEEPSEEK_API_KEY"]),
    build: (values) => ({ apiKey: values.get("DEEPSEEK_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "google-ai",
    attempts: appAttempts("ct", ["GEMINI_API_KEY"]),
    build: (values) => ({ apiKey: values.get("GEMINI_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "unusual-whales",
    attempts: appAttempts("ct", ["UNUSUAL_WHALES_API_KEY"]),
    build: (values) => ({ apiKey: values.get("UNUSUAL_WHALES_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "llamaindex",
    attempts: appAttempts("ct", ["LLAMAPARSE_API_KEY"]),
    splitApiKeyList: true,
    build: (values) => ({ apiKey: values.get("LLAMAPARSE_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "mistral",
    attempts: appAttempts("ct", ["MISTRAL_API_KEY"], true, ["MISTRAL_ADMIN_KEY"]),
    build: (values) => ({
      apiKey: values.get("MISTRAL_API_KEY"),
      ...(values.get("MISTRAL_ADMIN_KEY")
        ? { secretConfig: { adminApiKey: values.get("MISTRAL_ADMIN_KEY")! } }
        : {}),
    }),
  },
  {
    scope: "ct",
    providerName: "openrouter",
    attempts: appAttempts("ct", ["OPENROUTER_API_KEY"]),
    build: (values) => ({ apiKey: values.get("OPENROUTER_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "resend",
    attempts: appAttempts("ct", ["RESEND_API_KEY"], true),
    build: (values) => ({ apiKey: values.get("RESEND_API_KEY") }),
  },
  {
    scope: "ct",
    providerName: "stripe",
    attempts: appAttempts("ct", ["STRIPE_SECRET_KEY"]),
    build: (values) => ({ apiKey: values.get("STRIPE_SECRET_KEY") }),
  },
  {
    scope: "ct",
    providerName: "twelvedata",
    attempts: appAttempts("ct", ["TWELVEDATA_API_KEY"], true),
    build: (values) => ({ apiKey: values.get("TWELVEDATA_API_KEY") }),
  },
  {
    scope: "shared",
    providerName: "langfuse",
    attempts: [
      {
        source: "shared",
        required: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
        optional: ["LANGFUSE_BASE_URL"],
      },
    ],
    build: (values) => ({
      publicConfig: {
        publicKey: values.get("LANGFUSE_PUBLIC_KEY") ?? "",
        ...(values.get("LANGFUSE_BASE_URL")
          ? { host: values.get("LANGFUSE_BASE_URL")! }
          : {}),
      },
      secretConfig: { secretKey: values.get("LANGFUSE_SECRET_KEY") ?? "" },
    }),
  },
  {
    scope: "shared",
    providerName: "twilio",
    attempts: [
      {
        source: "shared",
        required: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
      },
    ],
    build: (values) => ({
      apiKey: values.get("TWILIO_AUTH_TOKEN"),
      publicConfig: { accountId: values.get("TWILIO_ACCOUNT_SID") ?? "" },
    }),
  },
  {
    scope: "shared",
    providerName: "oracle",
    attempts: [{
      source: "shared",
      required: [
        "OCI_TENANCY_OCID",
        "OCI_USER_OCID",
        "OCI_API_KEY_FINGERPRINT",
        "OCI_API_SIGNING_PRIVATE_KEY",
        "OCI_REGION",
      ],
      optional: ["OCI_COMPARTMENT_OCID", "OCI_LIMIT_SERVICES", "OCI_BUDGET_CURRENCY"],
    }],
    build: (values) => ({
      publicConfig: {
        tenancyOcid: values.get("OCI_TENANCY_OCID") ?? "",
        userOcid: values.get("OCI_USER_OCID") ?? "",
        fingerprint: values.get("OCI_API_KEY_FINGERPRINT") ?? "",
        region: values.get("OCI_REGION") ?? "",
        ...(values.get("OCI_COMPARTMENT_OCID")
          ? { compartmentOcid: values.get("OCI_COMPARTMENT_OCID")! }
          : {}),
        ...(values.get("OCI_LIMIT_SERVICES")
          ? { limitServices: values.get("OCI_LIMIT_SERVICES")! }
          : {}),
        ...(values.get("OCI_BUDGET_CURRENCY")
          ? { budgetCurrency: values.get("OCI_BUDGET_CURRENCY")! }
          : {}),
      },
      // privateKey is routed to encrypted Provider.secretConfig by the shared
      // provider-config secret splitter and is never returned by provider APIs.
      secretConfig: { privateKey: values.get("OCI_API_SIGNING_PRIVATE_KEY") ?? "" },
    }),
  },
  {
    scope: "shared",
    providerName: "coolify",
    attempts: [{
      source: "shared",
      required: ["COOLIFY_API_TOKEN"],
      optional: ["COOLIFY_HOST"],
    }],
    build: (values) => ({
      apiKey: values.get("COOLIFY_API_TOKEN"),
      ...(values.get("COOLIFY_HOST")
        ? { publicConfig: { host: values.get("COOLIFY_HOST")! } }
        : {}),
    }),
  },
] as const;

// ---------------------------------------------------------------------------
// Auto-discovery: maps secret-key naming patterns to built-in provider names.
// This mapping is intentionally broader than CREDENTIAL_MAPPINGS — it covers
// every BuiltInProviderName so the discovery audit can flag new secrets even
// for providers that haven't been wired into the static sync yet. Entries
// whose secret name already appears in CREDENTIAL_MAPPINGS are harmless
// duplicates; discoverUnmappedSecrets filters them out.
// ---------------------------------------------------------------------------
const SECRET_NAME_TO_PROVIDER: ReadonlyMap<string, string> = new Map<string, string>([
  // LLM / AI
  ["OPENAI_API_KEY", "openai"],
  ["OPENAI_ADMIN_KEY", "openai"],
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["ANTHROPIC_ADMIN_KEY", "anthropic"],
  ["GEMINI_API_KEY", "google-ai"],
  ["GOOGLE_AI_API_KEY", "google-ai"],
  ["GOOGLE_SERVICE_ACCOUNT_JSON", "google-ai"],
  ["DEEPSEEK_API_KEY", "deepseek"],
  ["XAI_API_KEY", "xai"],
  ["XAI_MANAGEMENT_KEY", "xai"],
  ["XAI_TEAM_ID", "xai"],
  ["GROK_API_KEY", "xai"],
  ["MISTRAL_API_KEY", "mistral"],
  ["MISTRAL_ADMIN_KEY", "mistral"],
  ["OPENROUTER_API_KEY", "openrouter"],
  // Developer Platform
  ["GITHUB_TOKEN", "github"],
  ["GITHUB_API_TOKEN", "github"],
  ["GITHUB_PAT", "github"],
  // Infrastructure
  ["RENDER_API_KEY", "render"],
  ["RENDER_API_TOKEN", "render"],
  ["HETZNER_API_TOKEN", "hetzner"],
  ["HETZNER_API_KEY", "hetzner"],
  ["CLOUDFLARE_API_TOKEN", "cloudflare"],
  ["CLOUDFLARE_API_KEY", "cloudflare"],
  ["CLOUDFLARE_GLOBAL_API_KEY", "cloudflare"],
  // Oracle Cloud (multi-key)
  ["OCI_TENANCY_OCID", "oracle"],
  ["OCI_USER_OCID", "oracle"],
  ["OCI_API_KEY_FINGERPRINT", "oracle"],
  ["OCI_API_SIGNING_PRIVATE_KEY", "oracle"],
  ["OCI_REGION", "oracle"],
  ["OCI_COMPARTMENT_OCID", "oracle"],
  ["COOLIFY_API_TOKEN", "coolify"],
  ["COOLIFY_HOST", "coolify"],
  // Vector DB
  ["PINECONE_API_KEY", "pinecone"],
  ["VOYAGE_API_KEY", "voyage"],
  // Market Data
  ["FMP_API_KEY", "fmp"],
  ["FINNHUB_API_KEY", "finnhub"],
  ["ALPHAVANTAGE_API_KEY", "alphavantage"],
  ["ALPHA_VANTAGE_API_KEY", "alphavantage"],
  ["MARKETSTACK_API_KEY", "marketstack"],
  ["TIINGO_API_KEY", "tiingo"],
  ["TWELVEDATA_API_KEY", "twelvedata"],
  ["TWELVE_DATA_API_KEY", "twelvedata"],
  ["FINTECH_STUDIOS_API_KEY", "fintech-studios"],
  ["MASSIVE_API_KEY", "massive"],
  ["FRED_API_KEY", "fred"],
  ["QUIVER_QUANT_API_KEY", "quiver-quant"],
  ["UNUSUAL_WHALES_API_KEY", "unusual-whales"],
  // Observability
  ["SENTRY_AUTH_TOKEN", "sentry"],
  ["SENTRY_API_KEY", "sentry"],
  ["LANGFUSE_PUBLIC_KEY", "langfuse"],
  ["LANGFUSE_SECRET_KEY", "langfuse"],
  // Notifications
  ["TWILIO_AUTH_TOKEN", "twilio"],
  ["TWILIO_ACCOUNT_SID", "twilio"],
  ["TWILIO_API_KEY", "twilio"],
  ["RESEND_API_KEY", "resend"],
  ["PUSHOVER_API_TOKEN", "pushover"],
  ["PUSHOVER_APP_TOKEN", "pushover"],
  // Data
  ["APIFY_API_TOKEN", "apify"],
  ["APIFY_TOKEN", "apify"],
  ["LLAMAPARSE_API_KEY", "llamaindex"],
  ["LLAMA_CLOUD_API_KEY", "llamaindex"],
  ["LLAMAINDEX_API_KEY", "llamaindex"],
  // Payments
  ["STRIPE_SECRET_KEY", "stripe"],
  ["STRIPE_API_KEY", "stripe"],
  // Brokerage
]);

const PROJECT_NAMES: Readonly<Record<"st" | "ct", string>> = {
  st: "SocraticTrade.com",
  ct: "Congress.Trade",
};

const SCOPE_LABELS: Readonly<Record<InfisicalCredentialScope, string>> = {
  st: "SocraticTrade.com",
  ct: "Congress.Trade",
  shared: "Shared",
  "st-primary": ST_PRIMARY_MANAGED_LABEL,
};

let syncInFlight: Promise<InfisicalCredentialSyncResult> | null = null;

function cleanEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function configuredSources(): SourceConfig[] {
  const environment = cleanEnv("INFISICAL_ENV") ?? DEFAULT_ENVIRONMENT;
  return SOURCE_DEFINITIONS.map((definition) => ({
    ...definition,
    clientId: cleanEnv(definition.clientIdEnv),
    clientSecret: cleanEnv(definition.clientSecretEnv),
    projectId: cleanEnv(definition.projectIdEnv) ?? definition.defaultProjectId,
    environment,
    secretPath: cleanEnv(definition.pathEnv) ?? DEFAULT_SECRET_PATH,
  }));
}

function emptyResult(
  enabled: boolean,
  stPrimaryEnabled = false
): InfisicalCredentialSyncResult {
  const rootSources: InfisicalCredentialSyncSourceResult[] =
    SOURCE_DEFINITIONS.map(({ source }) => ({
      source,
      configured: false,
      status: enabled ? "unconfigured" : "disabled",
      available: 0,
      missing: 0,
      failed: 0,
    }));
  return {
    enabled,
    configured: false,
    sources: [...rootSources, {
      source: "st-primary" as const,
      configured: false,
      status: stPrimaryEnabled ? "unconfigured" as const : "disabled" as const,
      available: 0,
      missing: 0,
      failed: 0,
    }],
    created: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    failed: 0,
    suppressed: 0,
  };
}

function isSuppressedMapping(
  mapping: CredentialMapping,
  options: InfisicalCredentialSyncOptions
): boolean {
  return (
    options.suppressStGemini === true &&
    mapping.scope === "st" &&
    canonicalProviderKey(mapping.providerName) ===
      canonicalProviderKey("google-ai")
  );
}

function infisicalBaseUrl(): string {
  let url: URL;
  try {
    url = new URL(cleanEnv("INFISICAL_BASE_URL") ?? DEFAULT_BASE_URL);
  } catch {
    throw new InfisicalSyncError("invalid_base_url");
  }
  const allowedHosts = new Set([
    "app.infisical.com",
    "us.infisical.com",
    "eu.infisical.com",
  ]);
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new InfisicalSyncError("invalid_base_url");
  }
  return url.origin;
}

async function fetchBounded(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new InfisicalSyncError("network_error");
  }
}

async function cancelBodyQuietly(
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The caller is already rejecting this response. Cancellation is best-effort.
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelBodyQuietly(response.body);
    throw new InfisicalSyncError("response_too_large");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new InfisicalSyncError("invalid_json");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read still fails closed if the transport cannot cancel.
        }
        throw new InfisicalSyncError("response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InfisicalSyncError) throw error;
    throw new InfisicalSyncError("response_read_failed");
  }

  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes
  ).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InfisicalSyncError("invalid_json");
  }
}

async function login(baseUrl: string, source: SourceConfig): Promise<string> {
  const response = await fetchBounded(
    `${baseUrl}/api/v1/auth/universal-auth/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: source.clientId,
        clientSecret: source.clientSecret,
      }),
    }
  );
  if (!response.ok) {
    await cancelBodyQuietly(response.body);
    throw new InfisicalSyncError(`auth_http_${response.status}`);
  }
  const body = await readJsonObject(response);
  const token = body.accessToken;
  if (typeof token !== "string" || !token) {
    throw new InfisicalSyncError("auth_invalid_response");
  }
  return token;
}

async function preflightSourceScope(
  baseUrl: string,
  source: SourceConfig,
  token: string
): Promise<Set<string>> {
  const params = new URLSearchParams({
    projectId: source.projectId,
    environment: source.environment,
    secretPath: source.secretPath,
    viewSecretValue: "false",
    expandSecretReferences: "false",
    recursive: "false",
    includePersonalOverrides: "false",
    includeImports: "false",
  });
  const response = await fetchBounded(`${baseUrl}/api/v4/secrets?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    await cancelBodyQuietly(response.body);
    throw new InfisicalSyncError(`scope_http_${response.status}`);
  }
  const body = await readJsonObject(response);
  if (!Array.isArray(body.secrets)) {
    throw new InfisicalSyncError("scope_invalid_response");
  }
  const names = new Set<string>();
  for (const secret of body.secrets) {
    if (!isRecord(secret) || typeof secret.secretKey !== "string") {
      throw new InfisicalSyncError("scope_invalid_response");
    }
    names.add(secret.secretKey);
  }
  return names;
}

interface SecretRecordRead {
  found: boolean;
  value?: string;
  secret?: Record<string, unknown>;
}

function requireFixedBootstrapCreateIdentity(
  secret: Record<string, unknown>,
  source: SourceConfig,
  secretName: string,
  errorCode: string
): void {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["secretKey", secretName],
    ["type", "shared"],
    // Infisical v4 responses identify the project with `workspace`; request
    // bodies and query strings use `projectId`. Do not accept the request-side
    // alias as proof that a response came from the fixed bootstrap project.
    ["workspace", source.projectId],
    ["environment", source.environment],
  ];
  for (const [field, value] of expected) {
    if (secret[field] !== value) {
      throw new InfisicalSyncError(errorCode);
    }
  }
}

function requireFixedBootstrapReadIdentity(
  secret: Record<string, unknown>,
  source: SourceConfig,
  secretName: string,
  errorCode: string
): void {
  requireFixedBootstrapCreateIdentity(
    secret,
    source,
    secretName,
    errorCode
  );
  if (secret.secretPath !== source.secretPath) {
    throw new InfisicalSyncError(errorCode);
  }
}

async function fetchSecretRecord(
  baseUrl: string,
  source: SourceConfig,
  token: string,
  secretName: string,
  options: { expandSecretReferences?: boolean } = {}
): Promise<SecretRecordRead> {
  const params = new URLSearchParams({
    projectId: source.projectId,
    environment: source.environment,
    secretPath: source.secretPath,
    type: "shared",
    viewSecretValue: "true",
    expandSecretReferences: String(options.expandSecretReferences ?? true),
    includeImports: "false",
  });
  const response = await fetchBounded(
    `${baseUrl}/api/v4/secrets/${encodeURIComponent(secretName)}?${params}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (response.status === 404) {
    await cancelBodyQuietly(response.body);
    return { found: false };
  }
  if (!response.ok) {
    await cancelBodyQuietly(response.body);
    throw new InfisicalSyncError(`secret_http_${response.status}`);
  }
  const body = await readJsonObject(response);
  const secret = body.secret;
  if (!isRecord(secret)) {
    throw new InfisicalSyncError("secret_invalid_response");
  }
  const value = secret.secretValue;
  if (typeof value !== "string") {
    throw new InfisicalSyncError("secret_invalid_response");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
    throw new InfisicalSyncError("secret_too_large");
  }
  return { found: true, value, secret };
}

async function fetchBootstrapSecretRecord(
  baseUrl: string,
  source: SourceConfig,
  token: string,
  secretName: string,
  scopeErrorCode: string,
  options: { expandSecretReferences?: boolean } = {}
): Promise<SecretRecordRead> {
  const record = await fetchSecretRecord(baseUrl, source, token, secretName, options);
  if (record.found) {
    if (!record.secret) {
      throw new InfisicalSyncError(scopeErrorCode);
    }
    requireFixedBootstrapReadIdentity(
      record.secret,
      source,
      secretName,
      scopeErrorCode
    );
  }
  return record;
}

async function fetchSecret(
  baseUrl: string,
  source: SourceConfig,
  token: string,
  secretName: string
): Promise<string | undefined> {
  const record = await fetchSecretRecord(baseUrl, source, token, secretName);
  return record.found && record.value?.trim() ? record.value : undefined;
}

async function createSecret(
  baseUrl: string,
  source: SourceConfig,
  token: string,
  secretName: string,
  secretValue: string
): Promise<void> {
  const response = await fetchBounded(
    `${baseUrl}/api/v4/secrets/${encodeURIComponent(secretName)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: source.projectId,
        environment: source.environment,
        secretPath: source.secretPath,
        type: "shared",
        secretValue,
      }),
    }
  );
  if (!response.ok) {
    await cancelBodyQuietly(response.body);
    throw new InfisicalSyncError(`create_http_${response.status}`);
  }
  const body = await readJsonObject(response);
  const secret = body.secret;
  if (!isRecord(secret)) {
    throw new InfisicalSyncError("create_invalid_response");
  }
  // Infisical v4's POST response does not include `secretPath`. The exact
  // post-create GET below is the authoritative path proof.
  requireFixedBootstrapCreateIdentity(
    secret,
    source,
    secretName,
    "create_scope_mismatch"
  );
  if (
    "secretValue" in secret &&
    (typeof secret.secretValue !== "string" ||
      !sameFingerprint(
        geminiApiKeyFingerprint(secret.secretValue),
        geminiApiKeyFingerprint(secretValue)
      ))
  ) {
    throw new InfisicalSyncError("create_value_mismatch");
  }
}

async function verifyCreatedSecret(
  baseUrl: string,
  source: SourceConfig,
  token: string,
  secretName: string,
  expectedFingerprint: string
): Promise<void> {
  const created = await fetchBootstrapSecretRecord(
    baseUrl,
    source,
    token,
    secretName,
    "post_create_scope_mismatch"
  );
  if (!created.found) {
    throw new InfisicalSyncError("post_create_secret_missing");
  }
  if (
    !sameFingerprint(
      geminiApiKeyFingerprint(created.value ?? ""),
      expectedFingerprint
    )
  ) {
    throw new InfisicalSyncError("post_create_value_mismatch");
  }
}

function requiredNamesBySource(): Map<InfisicalCredentialScope, string[]> {
  const names = new Map<InfisicalCredentialScope, Set<string>>(
    SOURCE_DEFINITIONS.map(({ source }) => [source, new Set<string>()])
  );
  for (const mapping of CREDENTIAL_MAPPINGS) {
    for (const attempt of mapping.attempts) {
      const target = names.get(attempt.source)!;
      for (const name of attempt.required) target.add(name);
      for (const name of attempt.optional ?? []) target.add(name);
    }
  }
  return new Map(
    [...names].map(([source, values]) => [source, [...values].sort()])
  );
}

async function readSource(
  baseUrl: string,
  source: SourceConfig,
  names: readonly string[]
): Promise<SourceRead> {
  const hasId = Boolean(source.clientId);
  const hasSecret = Boolean(source.clientSecret);
  if (!hasId && !hasSecret) {
    return {
      source: source.source,
      authenticated: false,
      values: new Map(),
      missing: new Set(),
      errors: new Map(),
      allSecretNames: new Set(),
      result: {
        source: source.source,
        configured: false,
        status: "unconfigured",
        available: 0,
        missing: 0,
        failed: 0,
      },
    };
  }
  if (!hasId || !hasSecret) {
    return {
      source: source.source,
      authenticated: false,
      values: new Map(),
      missing: new Set(),
      errors: new Map(names.map((name) => [name, "incomplete_credentials"])),
      allSecretNames: new Set(),
      result: {
        source: source.source,
        configured: false,
        status: "incomplete",
        available: 0,
        missing: 0,
        failed: names.length,
        errorCode: "incomplete_credentials",
      },
    };
  }

  let token: string;
  let scopeNames: Set<string>;
  try {
    token = await login(baseUrl, source);
    scopeNames = await preflightSourceScope(baseUrl, source, token);
  } catch (error) {
    const code = error instanceof InfisicalSyncError ? error.code : "auth_failed";
    return {
      source: source.source,
      authenticated: false,
      values: new Map(),
      missing: new Set(),
      errors: new Map(names.map((name) => [name, code])),
      allSecretNames: new Set(),
      result: {
        source: source.source,
        configured: true,
        status: "error",
        available: 0,
        missing: 0,
        failed: names.length,
        errorCode: code,
      },
    };
  }

  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const value = await fetchSecret(baseUrl, source, token, name);
        return { name, value };
      } catch (error) {
        return {
          name,
          errorCode:
            error instanceof InfisicalSyncError ? error.code : "secret_read_failed",
        };
      }
    })
  );
  const values = new Map<string, string>();
  const missing = new Set<string>();
  const errors = new Map<string, string>();
  for (const entry of entries) {
    if (entry.errorCode) errors.set(entry.name, entry.errorCode);
    else if (entry.value === undefined) missing.add(entry.name);
    else values.set(entry.name, entry.value);
  }
  return {
    source: source.source,
    authenticated: true,
    values,
    missing,
    errors,
    allSecretNames: scopeNames,
    result: {
      source: source.source,
      configured: true,
      status: errors.size > 0 ? "partial" : "synced",
      available: values.size,
      missing: missing.size,
      failed: errors.size,
      ...(errors.size > 0
        ? { errorCode: "one_or_more_secret_reads_failed" }
        : {}),
    },
  };
}

function splitApiKeyList(value: string): Array<{ apiKey: string; fingerprint: string }> {
  const unique = new Map<string, { apiKey: string; fingerprint: string }>();
  for (const part of value.split(",")) {
    const apiKey = part.trim();
    // Empty comma segments are harmless formatting noise. They are not
    // candidates and therefore can never create blank provider rows.
    if (!apiKey) continue;
    if (Buffer.byteLength(apiKey, "utf8") > MAX_SPLIT_API_KEY_BYTES) {
      throw new InfisicalSyncError("split_api_key_too_large");
    }
    const fingerprint = managedApiKeyFingerprint(apiKey);
    if (!unique.has(fingerprint)) unique.set(fingerprint, { apiKey, fingerprint });
    if (unique.size > MAX_SPLIT_API_KEYS) {
      throw new InfisicalSyncError("split_api_key_list_too_large");
    }
  }
  if (unique.size === 0) throw new InfisicalSyncError("split_api_key_list_empty");
  return [...unique.values()];
}

function candidatesForMaterial(
  mapping: CredentialMapping,
  source: InfisicalCredentialScope,
  material: CredentialMaterial
): CredentialCandidate[] {
  const base = {
    scope: mapping.scope,
    source,
    providerName: mapping.providerName,
  };
  if (!mapping.splitApiKeyList) return [{ ...base, material }];
  if (!material.apiKey) throw new InfisicalSyncError("split_api_key_missing");
  return splitApiKeyList(material.apiKey).map(({ apiKey, fingerprint }, keyListOrdinal) => ({
    ...base,
    material: { ...material, apiKey },
    keyFingerprint: fingerprint,
    keyListOrdinal,
  }));
}

function resolveMapping(
  mapping: CredentialMapping,
  reads: ReadonlyMap<InfisicalCredentialScope, SourceRead>
): { candidates?: CredentialCandidate[]; missing?: true; failed?: true } {
  for (let index = 0; index < mapping.attempts.length; index++) {
    const attempt = mapping.attempts[index];
    const source = reads.get(attempt.source)!;
    if (!source.authenticated) return { failed: true };
    if (attempt.required.some((name) => source.errors.has(name))) {
      return { failed: true };
    }
    const requiredMissing = attempt.required.some(
      (name) => !source.values.has(name)
    );
    if (requiredMissing) {
      if (index + 1 < mapping.attempts.length) continue;
      return { missing: true };
    }
    const values = new Map(source.values);
    for (const optional of attempt.optional ?? []) {
      if (source.errors.has(optional)) values.delete(optional);
    }
    const material = mapping.build(values);
    return { candidates: candidatesForMaterial(mapping, attempt.source, material) };
  }
  return { missing: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface StoredBindingRead {
  readable: boolean;
  binding?: StoredBinding;
}

function readStoredBinding(provider: ProviderRecord): StoredBindingRead {
  try {
    const config = providerConfigForServer(provider.config, provider.secretConfig);
    const value = config.infisicalCredential;
    if (value == null) return { readable: true };
    if (!isRecord(value) || typeof value.providerName !== "string") {
      return { readable: false };
    }
    if (value.scope === "st-primary" || value.source === "st-primary") {
      const primary = readStPrimaryCredentialBinding(
        provider.config,
        provider.secretConfig
      );
      if (!primary.readable || !primary.binding) return { readable: false };
      return { readable: true, binding: primary.binding };
    } else if (
      (value.scope !== "st" && value.scope !== "ct" && value.scope !== "shared") ||
      (value.source !== "st" && value.source !== "ct" && value.source !== "shared")
    ) {
      return { readable: false };
    }
    return { readable: true, binding: value as unknown as StoredBinding };
  } catch {
    return { readable: false };
  }
}

function bindingFor(provider: ProviderRecord): StoredBinding | undefined {
  return readStoredBinding(provider).binding;
}

async function loadStGeminiBootstrapProvider() {
  return prisma.provider.findUnique({
    where: { id: ST_GEMINI_PROVIDER_ID },
    include: {
      allocations: {
        include: { project: { select: { name: true } } },
      },
      snapshots: {
        where: { rawData: { not: Prisma.DbNull } },
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: { fetchedAt: true, rawData: true },
      },
    },
  });
}

type StGeminiBootstrapProvider = NonNullable<
  Awaited<ReturnType<typeof loadStGeminiBootstrapProvider>>
>;

interface StGeminiBootstrapMaterial {
  apiKey: string;
  credentialFingerprint: string;
  alertConfigGeneration: number;
}

function sameFingerprint(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateStGeminiBootstrapProvider(
  provider: StGeminiBootstrapProvider | null,
  now = Date.now()
): { material?: StGeminiBootstrapMaterial; errorCode?: string } {
  if (!provider) return { errorCode: "provider_not_found" };
  if (!provider.isActive) return { errorCode: "provider_inactive" };
  if (provider.type.trim().toLowerCase() !== "builtin") {
    return { errorCode: "provider_not_builtin" };
  }
  if (canonicalProviderKey(provider.name) !== canonicalProviderKey("google-ai")) {
    return { errorCode: "provider_name_mismatch" };
  }
  if (hasHistoricalLabel(provider)) {
    return { errorCode: "historical_provider" };
  }
  if (
    provider.allocations.length !== 1 ||
    provider.allocations[0].percentage !== 100 ||
    canonicalProjectKey(provider.allocations[0].project.name) !==
      canonicalProjectKey(ST_PROJECT_NAME)
  ) {
    return { errorCode: "project_allocation_mismatch" };
  }

  const storedBinding = readStoredBinding(provider);
  if (!storedBinding.readable) return { errorCode: "binding_unreadable" };
  if (
    storedBinding.binding &&
    (storedBinding.binding.scope !== "st" ||
      storedBinding.binding.source !== "st" ||
      canonicalProviderKey(storedBinding.binding.providerName) !==
        canonicalProviderKey("google-ai"))
  ) {
    return { errorCode: "binding_conflict" };
  }

  if (!provider.apiKey) return { errorCode: "credential_missing" };
  let apiKey: string;
  try {
    apiKey = decrypt(provider.apiKey);
  } catch {
    return { errorCode: "credential_unreadable" };
  }
  if (
    !apiKey.trim() ||
    Buffer.byteLength(apiKey, "utf8") > MAX_SECRET_VALUE_BYTES
  ) {
    return { errorCode: "credential_invalid" };
  }

  const snapshot = provider.snapshots[0];
  if (!snapshot) return { errorCode: "validation_missing" };
  const snapshotTime = snapshot.fetchedAt.getTime();
  if (
    !Number.isFinite(snapshotTime) ||
    snapshotTime > now + 5 * 60 * 1000 ||
    now - snapshotTime > ST_GEMINI_VALIDATION_MAX_AGE_MS
  ) {
    return { errorCode: "validation_stale" };
  }
  const snapshotData = isRecord(snapshot.rawData) ? snapshot.rawData : undefined;
  const validation = isRecord(snapshotData?.keyValidation)
    ? snapshotData.keyValidation
    : undefined;
  if (
    validation?.ok !== true ||
    validation.outcome !== "valid" ||
    typeof validation.status !== "number" ||
    validation.status < 200 ||
    validation.status >= 300
  ) {
    return { errorCode: "validation_unsuccessful" };
  }
  const credentialFingerprint = geminiApiKeyFingerprint(apiKey);
  if (
    typeof validation.credentialFingerprint !== "string" ||
    !sameFingerprint(validation.credentialFingerprint, credentialFingerprint)
  ) {
    return { errorCode: "validation_fingerprint_mismatch" };
  }

  return {
    material: {
      apiKey,
      credentialFingerprint,
      alertConfigGeneration: provider.alertConfigGeneration,
    },
  };
}

function fixedStBootstrapSource(): SourceConfig {
  const definition = SOURCE_DEFINITIONS.find(({ source }) => source === "st")!;
  return {
    ...definition,
    clientId: cleanEnv(definition.clientIdEnv),
    clientSecret: cleanEnv(definition.clientSecretEnv),
    projectId: definition.defaultProjectId,
    environment: DEFAULT_ENVIRONMENT,
    secretPath: DEFAULT_SECRET_PATH,
  };
}

function auditStGeminiBootstrap(
  result: StGeminiInfisicalBootstrapResult
): StGeminiInfisicalBootstrapResult {
  console.info(
    `[infisical-st-gemini-bootstrap] ${JSON.stringify({
      providerId: result.providerId,
      status: result.status,
      attempted: result.attempted,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    })}`
  );
  return result;
}

/**
 * One-time, create-only bootstrap for the exact current SocraticTrade.com
 * Gemini credential. This is deliberately not a general reverse sync: the
 * destination coordinates and source Provider UUID are fixed, existing
 * values are never changed, and the feature is default-off.
 */
export async function bootstrapStGeminiCredentialToInfisical(): Promise<StGeminiInfisicalBootstrapResult> {
  const disabled: StGeminiInfisicalBootstrapResult = {
    enabled: false,
    attempted: false,
    providerId: ST_GEMINI_PROVIDER_ID,
    status: "disabled",
  };
  if (cleanEnv(ST_GEMINI_BOOTSTRAP_FLAG) !== "true") return disabled;

  const source = fixedStBootstrapSource();
  if (!source.clientId || !source.clientSecret) {
    return auditStGeminiBootstrap({
      ...disabled,
      enabled: true,
      status: "unconfigured",
      errorCode: "st_identity_unconfigured",
    });
  }

  let createAttempted = false;
  try {
    const initialProvider = await loadStGeminiBootstrapProvider();
    const initial = validateStGeminiBootstrapProvider(initialProvider);
    if (!initial.material) {
      return auditStGeminiBootstrap({
        ...disabled,
        enabled: true,
        status: "ineligible",
        errorCode: initial.errorCode ?? "provider_ineligible",
      });
    }

    const baseUrl = infisicalBaseUrl();
    const token = await login(baseUrl, source);
    const names = await preflightSourceScope(baseUrl, source, token);
    const existing = await fetchBootstrapSecretRecord(
      baseUrl,
      source,
      token,
      ST_GEMINI_SECRET_NAME,
      "bootstrap_scope_mismatch"
    );
    if (names.has(ST_GEMINI_SECRET_NAME) && !existing.found) {
      throw new InfisicalSyncError("scope_inconsistent_missing_secret");
    }
    if (existing.found) {
      const existingFingerprint = geminiApiKeyFingerprint(existing.value ?? "");
      if (
        sameFingerprint(
          existingFingerprint,
          initial.material.credentialFingerprint
        )
      ) {
        return auditStGeminiBootstrap({
          ...disabled,
          enabled: true,
          status: "already_present_same",
        });
      }
      return auditStGeminiBootstrap({
        ...disabled,
        enabled: true,
        status: "conflict",
        errorCode: "existing_value_conflict",
      });
    }

    const currentProvider = await loadStGeminiBootstrapProvider();
    const current = validateStGeminiBootstrapProvider(currentProvider);
    if (
      !current.material ||
      current.material.alertConfigGeneration !==
        initial.material.alertConfigGeneration ||
      !sameFingerprint(
        current.material.credentialFingerprint,
        initial.material.credentialFingerprint
      )
    ) {
      return auditStGeminiBootstrap({
        ...disabled,
        enabled: true,
        status: "conflict",
        errorCode: "concurrent_provider_edit",
      });
    }

    createAttempted = true;
    await createSecret(
      baseUrl,
      source,
      token,
      ST_GEMINI_SECRET_NAME,
      current.material.apiKey
    );
    // A 2xx create response is not sufficient proof that the fixed remote
    // scope now contains the intended credential. Re-read the exact secret
    // before allowing the ordinary pull to adopt/bind it in this same pass.
    await verifyCreatedSecret(
      baseUrl,
      source,
      token,
      ST_GEMINI_SECRET_NAME,
      current.material.credentialFingerprint
    );
    return auditStGeminiBootstrap({
      ...disabled,
      enabled: true,
      attempted: true,
      status: "created",
    });
  } catch (error) {
    return auditStGeminiBootstrap({
      ...disabled,
      enabled: true,
      attempted: createAttempted,
      status: "error",
      errorCode:
        error instanceof InfisicalSyncError ? error.code : "bootstrap_failed",
    });
  }
}

function providerMatchesMaterial(
  provider: ProviderRecord,
  material: CredentialMaterial
): boolean {
  try {
    if (
      material.apiKey &&
      (!provider.apiKey || decrypt(provider.apiKey) !== material.apiKey)
    ) {
      return false;
    }
    const config = providerConfigForServer(provider.config, provider.secretConfig);
    for (const [key, value] of Object.entries(material.publicConfig ?? {})) {
      if (config[key] !== value) return false;
    }
    for (const [key, value] of Object.entries(material.secretConfig ?? {})) {
      if (config[key] !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasScopeHint(
  provider: ProviderRecord,
  scope: InfisicalCredentialScope,
  projectId: string | undefined
): boolean {
  if (projectId && provider.allocations.some((row) => row.projectId === projectId)) {
    return true;
  }
  const label = provider.label?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
  if (scope === "st") return label.includes("socratictrade");
  if (scope === "ct") return label.includes("congresstrade");
  return label.includes("shared");
}

function hasAnyScopeHint(provider: ProviderRecord): boolean {
  if (provider.allocations.length > 0) return true;
  const label = provider.label?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
  return (
    label.includes("socratictrade") ||
    label.includes("congresstrade") ||
    label.includes("shared")
  );
}

function hasHistoricalLabel(provider: ProviderRecord): boolean {
  return /(?:^|[^a-z])(old|legacy|retired)(?:$|[^a-z])/i.test(
    provider.label ?? ""
  );
}

function bindingMatchesCandidate(
  binding: StoredBinding | undefined,
  candidate: CredentialCandidate,
  canonicalProviderName: string
): boolean {
  if (
    binding?.scope !== candidate.scope ||
    canonicalProviderKey(binding.providerName) !== canonicalProviderName
  ) {
    return false;
  }
  // A split-list member must match its own stable identity. A legacy binding
  // without one is handled only by the first candidate below, so it cannot be
  // accidentally claimed by every key from the same source value.
  return binding.keyFingerprint === candidate.keyFingerprint;
}

function selectTarget(
  candidate: CredentialCandidate,
  providers: readonly ProviderRecord[],
  claimed: ReadonlySet<string>,
  projectId: string | undefined,
  mappingCount: number
): ProviderRecord | undefined {
  const canonical = canonicalProviderKey(candidate.providerName);
  const available = providers.filter(
    (provider) => {
      const stored = readStoredBinding(provider);
      return (
        stored.readable &&
        stored.binding?.scope !== "st-primary" &&
        provider.type.trim().toLowerCase() === "builtin" &&
        canonicalProviderKey(provider.name) === canonical &&
        !claimed.has(provider.id)
      );
    }
  );
  const bound = available.filter((provider) => {
    const binding = bindingFor(provider);
    return bindingMatchesCandidate(binding, candidate, canonical);
  });
  if (bound.length > 1) throw new InfisicalSyncError("ambiguous_bound_provider");
  if (bound.length === 1) return bound[0];

  if (candidate.keyFingerprint && candidate.keyListOrdinal === 0) {
    // Upgrade a prior single-value binding in place when a source is first
    // changed to a comma-separated list. Only the first deterministic key may
    // adopt it; every other key creates/selects its own row.
    const legacyBound = available.filter((provider) => {
      const binding = bindingFor(provider);
      return (
        binding?.scope === candidate.scope &&
        canonicalProviderKey(binding.providerName) === canonical &&
        binding.keyFingerprint === undefined
      );
    });
    if (legacyBound.length > 1) {
      throw new InfisicalSyncError("ambiguous_legacy_split_provider");
    }
    if (legacyBound.length === 1) return legacyBound[0];
  }

  const hinted = available.filter((provider) =>
    hasScopeHint(provider, candidate.scope, projectId)
  );
  const hintedExact = hinted.filter((provider) =>
    providerMatchesMaterial(provider, candidate.material)
  );
  if (hintedExact.length === 1) return hintedExact[0];
  if (hinted.length === 1 && !hasHistoricalLabel(hinted[0])) return hinted[0];
  if (hinted.length === 1) {
    throw new InfisicalSyncError("historical_provider_requires_exact_match");
  }
  if (hinted.length > 1) throw new InfisicalSyncError("ambiguous_scoped_provider");

  // Exact current credential material is a safe way to adopt a legacy row
  // whose label is a service/domain (for example `updates.jays.services`)
  // rather than an app name. Exclude rows explicitly scoped elsewhere.
  const unscopedExact = available.filter(
    (provider) =>
      !hasAnyScopeHint(provider) &&
      providerMatchesMaterial(provider, candidate.material)
  );
  if (unscopedExact.length === 1) return unscopedExact[0];
  if (unscopedExact.length > 1) {
    throw new InfisicalSyncError("ambiguous_exact_provider");
  }

  if (mappingCount === 1) {
    // A row already labeled/allocated to another app scope is never a safe
    // singleton adoption target, even if it is the only provider of this kind.
    // This preserves a manually valid ST Gemini row when only CT exposes a
    // GEMINI_API_KEY in Infisical (and vice versa).
    const unscoped = available.filter((provider) => !hasAnyScopeHint(provider));
    const exact = unscoped.filter((provider) =>
      providerMatchesMaterial(provider, candidate.material)
    );
    if (exact.length === 1) return exact[0];
    if (unscoped.length === 1) return unscoped[0];
  }
  return undefined;
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.keys(value).length > 0
    ? (value as Prisma.InputJsonObject)
    : (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
}

async function ensureScopeProjects(
  scopes: ReadonlySet<InfisicalCredentialScope>
): Promise<Map<InfisicalCredentialScope, string>> {
  const result = new Map<InfisicalCredentialScope, string>();
  const projects = await prisma.project.findMany({
    select: { id: true, name: true },
  });
  for (const scope of ["st", "ct"] as const) {
    if (!scopes.has(scope)) continue;
    const key = canonicalProjectKey(PROJECT_NAMES[scope]);
    let project = projects.find(
      (candidate) => canonicalProjectKey(candidate.name) === key
    );
    if (!project) {
      try {
        project = await prisma.project.create({
          data: {
            name: PROJECT_NAMES[scope],
            nameKey: key,
          },
          select: { id: true, name: true },
        });
        projects.push(project);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        const refreshed = await prisma.project.findMany({
          select: { id: true, name: true },
        });
        project = refreshed.find(
          (candidate) => canonicalProjectKey(candidate.name) === key
        );
        if (!project) throw error;
      }
    }
    result.set(scope, project.id);
  }
  return result;
}

function mergedStoredConfig(provider: ProviderRecord): {
  publicConfig: Record<string, unknown>;
  secretConfig: Record<string, unknown>;
  hadLegacySecrets: boolean;
} {
  const split = splitProviderConfig(provider.config);
  const encrypted = decryptProviderSecretConfig(provider.secretConfig);
  return {
    publicConfig: split.publicConfig,
    secretConfig: mergeProviderConfig(split.secretConfig, encrypted),
    hadLegacySecrets: hasProviderSecrets(split.secretConfig),
  };
}

function isStGeminiCandidate(candidate: CredentialCandidate): boolean {
  return (
    candidate.scope === "st" &&
    canonicalProviderKey(candidate.providerName) ===
      canonicalProviderKey("google-ai")
  );
}

async function guardInitialStGeminiBinding(
  candidate: CredentialCandidate,
  target: ProviderRecord
): Promise<void> {
  if (!isStGeminiCandidate(candidate) || target.id !== ST_GEMINI_PROVIDER_ID) {
    return;
  }

  const targetBinding = readStoredBinding(target);
  if (!targetBinding.readable) {
    throw new InfisicalSyncError("binding_unreadable");
  }
  if (targetBinding.binding) {
    if (
      targetBinding.binding.scope === "st" &&
      targetBinding.binding.source === candidate.source &&
      canonicalProviderKey(targetBinding.binding.providerName) ===
        canonicalProviderKey("google-ai")
    ) {
      // Once the exact binding exists, Infisical is the steady-state source of
      // truth and ordinary remote rotations remain supported.
      return;
    }
    throw new InfisicalSyncError("binding_conflict");
  }

  const currentProvider = await loadStGeminiBootstrapProvider();
  const current = validateStGeminiBootstrapProvider(currentProvider);
  if (!current.material) {
    throw new InfisicalSyncError(
      current.errorCode ?? "initial_binding_validation_failed"
    );
  }
  const candidateKey = candidate.material.apiKey;
  if (
    !candidateKey ||
    !sameFingerprint(
      geminiApiKeyFingerprint(candidateKey),
      current.material.credentialFingerprint
    )
  ) {
    throw new InfisicalSyncError("initial_binding_value_conflict");
  }
}

async function applyCandidates(candidates: readonly CredentialCandidate[]): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}> {
  const projects = await ensureScopeProjects(
    new Set(candidates.map((candidate) => candidate.scope))
  );
  const providers = await prisma.provider.findMany({
    where: { type: "builtin" },
    include: {
      allocations: { select: { projectId: true, percentage: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const mappedScopesByProvider = new Map<
    string,
    Set<InfisicalCredentialScope>
  >();
  for (const mapping of CREDENTIAL_MAPPINGS) {
    const key = canonicalProviderKey(mapping.providerName);
    const scopes = mappedScopesByProvider.get(key) ?? new Set();
    scopes.add(mapping.scope);
    mappedScopesByProvider.set(key, scopes);
  }
  const claimed = new Set<string>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const projectId = projects.get(candidate.scope);
      const target = selectTarget(
        candidate,
        providers,
        claimed,
        projectId,
        mappedScopesByProvider.get(canonicalProviderKey(candidate.providerName))
          ?.size ?? 1
      );
      const definition = BUILT_IN_PROVIDERS.find(
        (item) => item.name === candidate.providerName
      );
      if (!definition) throw new InfisicalSyncError("unknown_provider_mapping");
      if (!isBuiltInProviderActive(definition.name)) {
        throw new InfisicalSyncError("decommissioned_provider_mapping");
      }
      const binding: StoredBinding = {
        scope: candidate.scope,
        source: candidate.source,
        providerName: candidate.providerName,
        ...(candidate.keyFingerprint
          ? { keyFingerprint: candidate.keyFingerprint }
          : {}),
      };

      if (!target) {
        const secretConfig = {
          ...(candidate.material.secretConfig ?? {}),
          infisicalCredential: binding,
        };
        const provider = await prisma.provider.create({
          data: {
            name: definition.name,
            displayName: definition.displayName,
            type: "builtin",
            category: definition.category,
            label: SCOPE_LABELS[candidate.scope],
            apiKey: candidate.material.apiKey
              ? encrypt(candidate.material.apiKey)
              : null,
            config: jsonInput(candidate.material.publicConfig ?? {}),
            secretConfig: encryptJson(secretConfig),
            refreshIntervalMin: definition.defaultRefreshIntervalMin ?? 60,
            ...(projectId
              ? {
                  allocations: {
                    create: { projectId, percentage: 100 },
                  },
                }
              : {}),
          },
          include: {
            allocations: { select: { projectId: true, percentage: true } },
          },
        });
        providers.push(provider);
        claimed.add(provider.id);
        created++;
        continue;
      }

      // This guard is deliberately independent of the one-time bootstrap
      // flag. Until the fixed ST Gemini provider is bound, a normal pull may
      // attach only a remote value proven equal to its freshly validated key.
      await guardInitialStGeminiBinding(candidate, target);
      claimed.add(target.id);
      const stored = mergedStoredConfig(target);
      const existingBinding = bindingFor(target);
      const materialMatches = providerMatchesMaterial(target, candidate.material);
      const allocationPresent =
        !projectId || target.allocations.some((row) => row.projectId === projectId);
      const labelPresent = Boolean(target.label?.trim());
      const bindingMatches =
        existingBinding?.scope === binding.scope &&
        existingBinding.source === binding.source &&
        canonicalProviderKey(existingBinding.providerName) ===
          canonicalProviderKey(binding.providerName) &&
        existingBinding.keyFingerprint === binding.keyFingerprint;
      if (
        materialMatches &&
        bindingMatches &&
        allocationPresent &&
        labelPresent &&
        !stored.hadLegacySecrets
      ) {
        unchanged++;
        continue;
      }

      const publicConfig = {
        ...stored.publicConfig,
        ...(candidate.material.publicConfig ?? {}),
      };
      const secretConfig = {
        ...stored.secretConfig,
        ...(candidate.material.secretConfig ?? {}),
        infisicalCredential: binding,
      };
      const existingKeyMatches = candidate.material.apiKey
        ? target.apiKey && decrypt(target.apiKey) === candidate.material.apiKey
        : true;
      await prisma.$transaction(async (tx) => {
        const write = await tx.provider.updateMany({
          // Provider credential/config edits increment this generation in the
          // normal API route. A mismatch means a human edit won the race; roll
          // back rather than clobbering it with the pre-read merge.
          where: {
            id: target.id,
            alertConfigGeneration: target.alertConfigGeneration,
          },
          data: {
            ...(candidate.material.apiKey && !existingKeyMatches
              ? { apiKey: encrypt(candidate.material.apiKey) }
              : {}),
            config: jsonInput(publicConfig),
            secretConfig: encryptJson(secretConfig),
            ...(labelPresent ? {} : { label: SCOPE_LABELS[candidate.scope] }),
            alertConfigGeneration: { increment: 1 },
          },
        });
        if (write.count !== 1) {
          throw new InfisicalSyncError("concurrent_provider_edit");
        }
        if (projectId && !allocationPresent) {
          await tx.providerProjectAllocation.upsert({
            where: {
              providerId_projectId: { providerId: target.id, projectId },
            },
            create: { providerId: target.id, projectId, percentage: 100 },
            update: {},
          });
        }
      });
      updated++;
    } catch {
      failed++;
    }
  }
  return { created, updated, unchanged, failed };
}

function fixedStPrimarySource(): SourceConfig {
  const st = SOURCE_DEFINITIONS.find(({ source }) => source === "st")!;
  return {
    ...st,
    source: "st-primary",
    clientIdEnv: ST_PRIMARY_CLIENT_ID_ENV,
    clientSecretEnv: ST_PRIMARY_CLIENT_SECRET_ENV,
    pathEnv: "",
    clientId: cleanEnv(ST_PRIMARY_CLIENT_ID_ENV),
    clientSecret: cleanEnv(ST_PRIMARY_CLIENT_SECRET_ENV),
    projectId: st.defaultProjectId,
    environment: DEFAULT_ENVIRONMENT,
    secretPath: ST_PRIMARY_SECRET_PATH,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function rejectDuplicateJsonObjectMembers(input: string): void {
  let index = 0;
  const invalid = () => {
    throw new InfisicalSyncError("bridge_manifest_invalid_json");
  };
  const skipWhitespace = () => {
    while (/\s/.test(input[index] ?? "")) index++;
  };
  const parseString = (): string => {
    if (input[index] !== '"') invalid();
    const start = index++;
    let escaped = false;
    while (index < input.length) {
      const char = input[index++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        try {
          return JSON.parse(input.slice(start, index)) as string;
        } catch {
          invalid();
        }
      }
    }
    invalid();
    throw new InfisicalSyncError("bridge_manifest_invalid_json");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (input[index] === "{") {
      index++;
      skipWhitespace();
      const keys = new Set<string>();
      if (input[index] === "}") {
        index++;
        return;
      }
      while (index < input.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new InfisicalSyncError("bridge_manifest_duplicate_member");
        }
        keys.add(key);
        skipWhitespace();
        if (input[index++] !== ":") invalid();
        parseValue();
        skipWhitespace();
        const delimiter = input[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") invalid();
      }
      invalid();
    }
    if (input[index] === "[") {
      index++;
      skipWhitespace();
      if (input[index] === "]") {
        index++;
        return;
      }
      while (index < input.length) {
        parseValue();
        skipWhitespace();
        const delimiter = input[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") invalid();
      }
      invalid();
    }
    if (input[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index++;
    if (index === start) invalid();
  };

  parseValue();
  skipWhitespace();
  if (index !== input.length) invalid();
}

function parseStPrimaryManifest(value: string): StPrimaryManifest {
  if (Buffer.byteLength(value, "utf8") > MAX_BRIDGE_MANIFEST_BYTES) {
    throw new InfisicalSyncError("bridge_manifest_too_large");
  }
  rejectDuplicateJsonObjectMembers(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InfisicalSyncError("bridge_manifest_invalid_json");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["schemaVersion", "source", "complete", "sequence", "entries"]) ||
    parsed.schemaVersion !== 1 ||
    parsed.source !== "socratic-trade-primary" ||
    parsed.complete !== true ||
    !Number.isSafeInteger(parsed.sequence) ||
    (parsed.sequence as number) < 1 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length !== 2
  ) {
    throw new InfisicalSyncError("bridge_manifest_invalid");
  }

  const entries: StPrimaryManifestEntry[] = [];
  const seen = new Set<string>();
  for (const valueEntry of parsed.entries) {
    if (
      !isRecord(valueEntry) ||
      !hasExactKeys(valueEntry, [
        "id",
        "providerName",
        "capability",
        "secretName",
        "status",
        "fingerprint",
      ]) ||
      (valueEntry.id !== "gemini.apiKey" && valueEntry.id !== "deepseek.apiKey") ||
      seen.has(valueEntry.id)
    ) {
      throw new InfisicalSyncError("bridge_manifest_entries_invalid");
    }
    seen.add(valueEntry.id);
    const contract = ST_PRIMARY_ENTRY_CONTRACT[valueEntry.id];
    if (
      valueEntry.providerName !== contract.providerName ||
      valueEntry.capability !== "apiKey" ||
      valueEntry.secretName !== contract.secretName ||
      (valueEntry.status !== "active" && valueEntry.status !== "revoked") ||
      (valueEntry.status === "active"
        ? typeof valueEntry.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(valueEntry.fingerprint)
        : valueEntry.fingerprint !== null)
    ) {
      throw new InfisicalSyncError("bridge_manifest_entries_invalid");
    }
    entries.push(valueEntry as unknown as StPrimaryManifestEntry);
  }
  return {
    schemaVersion: 1,
    source: "socratic-trade-primary",
    complete: true,
    sequence: parsed.sequence as number,
    entries,
  };
}

function bridgeFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readStPrimaryBridge(
  baseUrl: string,
  source: SourceConfig
): Promise<StPrimaryBridgeRead> {
  const token = await login(baseUrl, source);
  const names = await preflightSourceScope(baseUrl, source, token);
  if (!names.has(ST_PRIMARY_MANIFEST_SECRET)) {
    throw new InfisicalSyncError("bridge_manifest_missing");
  }
  const manifestRecord = await fetchBootstrapSecretRecord(
    baseUrl,
    source,
    token,
    ST_PRIMARY_MANIFEST_SECRET,
    "bridge_manifest_scope_mismatch",
    { expandSecretReferences: false }
  );
  if (!manifestRecord.found) {
    throw new InfisicalSyncError("bridge_manifest_missing");
  }
  const manifest = parseStPrimaryManifest(manifestRecord.value ?? "");
  const values = new Map<StPrimaryManifestEntry["id"], string>();
  for (const entry of manifest.entries) {
    if (entry.status === "revoked") continue;
    if (!names.has(entry.secretName)) {
      throw new InfisicalSyncError("bridge_complete_set_missing_value");
    }
    const record = await fetchBootstrapSecretRecord(
      baseUrl,
      source,
      token,
      entry.secretName,
      "bridge_value_scope_mismatch",
      { expandSecretReferences: false }
    );
    if (!record.found || !record.value) {
      throw new InfisicalSyncError("bridge_complete_set_missing_value");
    }
    const actual = bridgeFingerprint(record.value);
    if (!sameFingerprint(actual, entry.fingerprint ?? "")) {
      throw new InfisicalSyncError("bridge_fingerprint_mismatch");
    }
    values.set(entry.id, record.value);
  }
  return { manifest, values };
}

function stPrimaryBindingFor(
  provider: ProviderRecord
): StoredBinding | undefined {
  const read = readStoredBinding(provider);
  return read.readable && read.binding?.scope === "st-primary"
    ? read.binding
    : undefined;
}

function exactCredentialDuplicate(
  providers: readonly ProviderRecord[],
  targetId: string | undefined,
  providerName: string,
  fingerprint: string
): ProviderRecord | undefined {
  const canonical = canonicalProviderKey(providerName);
  return providers.find((provider) => {
    if (
      provider.id === targetId ||
      !provider.isActive ||
      canonicalProviderKey(provider.name) !== canonical ||
      !provider.apiKey
    ) {
      return false;
    }
    try {
      return sameFingerprint(bridgeFingerprint(decrypt(provider.apiKey)), fingerprint);
    } catch {
      return false;
    }
  });
}

async function applyStPrimaryBridge(read: StPrimaryBridgeRead): Promise<{
  created: number;
  updated: number;
  unchanged: number;
}> {
  const projectId = (
    await ensureScopeProjects(new Set<InfisicalCredentialScope>(["st"]))
  ).get("st");
  return prisma.$transaction(async (tx) => {
    // Re-read only after the complete remote set has been validated and the
    // database transaction has begun. Both provider members then advance (or
    // roll back) together.
    const providers = await tx.provider.findMany({
      where: { type: "builtin" },
      include: { allocations: { select: { projectId: true, percentage: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const targets = new Map<StPrimaryManifestEntry["id"], ProviderRecord>();

    // Validate replay/ordering for the complete set before writing any member.
    for (const entry of read.manifest.entries) {
      const matches = providers.filter((provider) => {
        const binding = stPrimaryBindingFor(provider);
        return binding && canonicalProviderKey(binding.providerName) ===
          canonicalProviderKey(entry.providerName);
      });
      if (matches.length > 1) {
        throw new InfisicalSyncError("bridge_ambiguous_bound_provider");
      }
      const target = matches[0];
      if (!target) continue;
      targets.set(entry.id, target);
      const binding = stPrimaryBindingFor(target)!;
      if ((binding.sequence ?? 0) > read.manifest.sequence) {
        throw new InfisicalSyncError("bridge_sequence_replay");
      }
      if (
        binding.sequence === read.manifest.sequence &&
        (binding.status !== entry.status ||
          binding.fingerprint !== entry.fingerprint)
      ) {
        throw new InfisicalSyncError("bridge_sequence_mismatch");
      }
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const entry of read.manifest.entries) {
      const target = targets.get(entry.id);
      const definition = BUILT_IN_PROVIDERS.find(
        (item) => item.name === entry.providerName
      );
      if (!definition) throw new InfisicalSyncError("unknown_provider_mapping");
      const value = read.values.get(entry.id);
      if (entry.status === "active" && !value) {
        throw new InfisicalSyncError("bridge_complete_set_missing_value");
      }
      const duplicate = entry.status === "active"
        ? exactCredentialDuplicate(
            providers,
            target?.id,
            entry.providerName,
            entry.fingerprint!
          )
        : undefined;
      const binding: StoredBinding = {
        scope: "st-primary",
        source: "st-primary",
        providerName: entry.providerName,
        sequence: read.manifest.sequence,
        status: entry.status,
        fingerprint: entry.fingerprint,
        ...(duplicate ? { aliasOfProviderId: duplicate.id } : {}),
      };
      const desiredActive = entry.status === "active" && !duplicate;

      if (!target) {
        // Revocations are persisted even when first observed. The keyless,
        // inactive tombstone retains sequence so an older active manifest can
        // never resurrect a credential.
        const provider = await tx.provider.create({
          data: {
            name: definition.name,
            displayName: definition.displayName,
            type: "builtin",
            category: definition.category,
            label: ST_PRIMARY_MANAGED_LABEL,
            isActive: desiredActive,
            apiKey: value ? encrypt(value) : null,
            config: Prisma.JsonNull,
            secretConfig: encryptJson({ infisicalCredential: binding }),
            refreshIntervalMin: definition.defaultRefreshIntervalMin ?? 60,
            ...(projectId
              ? { allocations: { create: { projectId, percentage: 100 } } }
              : {}),
          },
          include: { allocations: { select: { projectId: true, percentage: true } } },
        });
        providers.push(provider);
        created++;
        continue;
      }

      const oldBinding = stPrimaryBindingFor(target)!;
      const stored = mergedStoredConfig(target);
      const allocationPresent =
        !projectId || target.allocations.some((row) => row.projectId === projectId);
      let keyMatches = target.apiKey == null && entry.status === "revoked";
      if (value && target.apiKey) {
        try {
          keyMatches = sameFingerprint(
            bridgeFingerprint(decrypt(target.apiKey)),
            entry.fingerprint!
          );
        } catch {
          keyMatches = false;
        }
      }
      const bindingMatches =
        oldBinding.sequence === binding.sequence &&
        oldBinding.status === binding.status &&
        oldBinding.fingerprint === binding.fingerprint &&
        oldBinding.aliasOfProviderId === binding.aliasOfProviderId;
      if (
        bindingMatches &&
        keyMatches &&
        target.isActive === desiredActive &&
        target.label === ST_PRIMARY_MANAGED_LABEL &&
        allocationPresent &&
        !stored.hadLegacySecrets
      ) {
        unchanged++;
        continue;
      }

      const secretConfig = {
        ...stored.secretConfig,
        infisicalCredential: binding,
      };
      const write = await tx.provider.updateMany({
        where: {
          id: target.id,
          alertConfigGeneration: target.alertConfigGeneration,
        },
        data: {
          apiKey: value ? encrypt(value) : null,
          isActive: desiredActive,
          label: ST_PRIMARY_MANAGED_LABEL,
          config: jsonInput(stored.publicConfig),
          secretConfig: encryptJson(secretConfig),
          alertConfigGeneration: { increment: 1 },
        },
      });
      if (write.count !== 1) {
        throw new InfisicalSyncError("concurrent_provider_edit");
      }
      if (projectId && !allocationPresent) {
        await tx.providerProjectAllocation.upsert({
          where: { providerId_projectId: { providerId: target.id, projectId } },
          create: { providerId: target.id, projectId, percentage: 100 },
          update: {},
        });
      }
      updated++;
    }
    return { created, updated, unchanged };
  });
}

// ---------------------------------------------------------------------------
// Informational discovery: log Infisical secrets that match a known provider
// pattern but are not wired into the static CREDENTIAL_MAPPINGS. This never
// creates providers or mutates credentials — it only logs for operator
// visibility so new services can be manually added to the allowlist.
// ---------------------------------------------------------------------------

/** Secret names already covered by at least one CREDENTIAL_MAPPINGS entry. */
function mappedSecretNames(): Set<string> {
  const names = new Set<string>();
  for (const mapping of CREDENTIAL_MAPPINGS) {
    for (const attempt of mapping.attempts) {
      for (const name of attempt.required) names.add(name);
      for (const name of attempt.optional ?? []) names.add(name);
    }
  }
  return names;
}

/**
 * Cross-reference every secret name visible in authenticated Infisical scopes
 * against SECRET_NAME_TO_PROVIDER. Any match that is NOT already covered by
 * CREDENTIAL_MAPPINGS is logged as an unmapped discovery. The function is
 * deliberately fire-and-forget: errors are swallowed so discovery can never
 * break the sync cycle.
 */
function discoverUnmappedSecrets(
  reads: ReadonlyMap<InfisicalCredentialScope, SourceRead>
): void {
  try {
    const alreadyMapped = mappedSecretNames();
    const discovered: Array<{
      source: InfisicalCredentialScope;
      secretName: string;
      providerName: string;
    }> = [];

    for (const [source, read] of reads) {
      if (!read.authenticated || read.allSecretNames.size === 0) continue;
      for (const secretName of read.allSecretNames) {
        if (alreadyMapped.has(secretName)) continue;
        const providerName = SECRET_NAME_TO_PROVIDER.get(secretName);
        if (providerName) {
          discovered.push({ source, secretName, providerName });
        }
      }
    }

    if (discovered.length === 0) return;

    console.info(
      `[infisical-discovery] ${JSON.stringify({
        unmappedSecrets: discovered.length,
        details: discovered.map(({ source, secretName, providerName }) => ({
          source,
          secretName,
          providerName,
        })),
      })}`
    );
  } catch {
    // Discovery is best-effort. A failure here must never affect the sync.
  }
}

async function syncRootOnce(
  options: InfisicalCredentialSyncOptions
): Promise<InfisicalCredentialSyncResult> {
  const enabled = cleanEnv("INFISICAL_PROVIDER_SYNC_ENABLED") !== "false";
  const result = emptyResult(enabled);
  if (!enabled) return result;

  const sources = configuredSources();
  result.configured = sources.some(
    (source) => Boolean(source.clientId && source.clientSecret)
  );
  if (!sources.some((source) => source.clientId || source.clientSecret)) {
    return result;
  }

  let baseUrl: string;
  try {
    baseUrl = infisicalBaseUrl();
  } catch (error) {
    const errorCode =
      error instanceof InfisicalSyncError ? error.code : "invalid_base_url";
    result.sources = sources.map((source) => ({
      source: source.source,
      configured: Boolean(source.clientId && source.clientSecret),
      status: source.clientId || source.clientSecret ? "error" : "unconfigured",
      available: 0,
      missing: 0,
      failed: 0,
      ...(source.clientId || source.clientSecret ? { errorCode } : {}),
    }));
    result.failed = CREDENTIAL_MAPPINGS.length;
    return result;
  }

  const namesBySource = requiredNamesBySource();
  const sourceReads = await Promise.all(
    sources.map((source) =>
      readSource(baseUrl, source, namesBySource.get(source.source) ?? [])
    )
  );
  const reads = new Map(sourceReads.map((source) => [source.source, source]));
  result.sources = sourceReads.map((source) => source.result);

  const candidates: CredentialCandidate[] = [];
  for (const mapping of CREDENTIAL_MAPPINGS) {
    if (isSuppressedMapping(mapping, options)) {
      result.suppressed = (result.suppressed ?? 0) + 1;
      continue;
    }
    try {
      const resolved = resolveMapping(mapping, reads);
      if (resolved.candidates) candidates.push(...resolved.candidates);
      else if (resolved.missing) result.missing++;
      else result.failed++;
    } catch {
      result.failed++;
    }
  }

  if (candidates.length > 0) {
    const applied = await withInternalUsageWriteAdmission(() =>
      applyCandidates(candidates)
    );
    result.created = applied.created;
    result.updated = applied.updated;
    result.unchanged = applied.unchanged;
    result.failed += applied.failed;
  }

  discoverUnmappedSecrets(reads);
  return result;
}

async function syncOnce(
  options: InfisicalCredentialSyncOptions
): Promise<InfisicalCredentialSyncResult> {
  const stPrimaryEnabled = cleanEnv(ST_PRIMARY_SYNC_FLAG) === "true";
  const root = await syncRootOnce(options);
  if (!stPrimaryEnabled) return root;

  const source = fixedStPrimarySource();
  const configured = Boolean(source.clientId && source.clientSecret);
  const sourceIndex = root.sources.findIndex((item) => item.source === "st-primary");
  const setSource = (value: InfisicalCredentialSyncSourceResult) => {
    if (sourceIndex >= 0) root.sources[sourceIndex] = value;
    else root.sources.push(value);
  };
  root.enabled = true;
  root.configured ||= configured;
  if (!source.clientId && !source.clientSecret) {
    setSource({
      source: "st-primary",
      configured: false,
      status: "unconfigured",
      available: 0,
      missing: 0,
      failed: 0,
    });
    return root;
  }
  if (!configured) {
    setSource({
      source: "st-primary",
      configured: false,
      status: "incomplete",
      available: 0,
      missing: 0,
      failed: 2,
      errorCode: "incomplete_credentials",
    });
    root.failed += 2;
    return root;
  }
  try {
    const baseUrl = infisicalBaseUrl();
    const bridge = await readStPrimaryBridge(baseUrl, source);
    const applied = await withInternalUsageWriteAdmission(() =>
      applyStPrimaryBridge(bridge)
    );
    root.created += applied.created;
    root.updated += applied.updated;
    root.unchanged += applied.unchanged;
    setSource({
      source: "st-primary",
      configured: true,
      status: "synced",
      available: bridge.values.size,
      missing: 0,
      failed: 0,
    });
  } catch (error) {
    const errorCode =
      error instanceof InfisicalSyncError ? error.code : "bridge_sync_failed";
    setSource({
      source: "st-primary",
      configured: true,
      status: "error",
      available: 0,
      missing: 0,
      failed: 2,
      errorCode,
    });
    root.failed += 2;
  }
  return root;
}

/**
 * Pull an exact, monitor-functional allowlist from three Infisical scopes and
 * rotate encrypted last-known-good Provider credentials. Concurrent callers
 * share one run; source/read/apply failures never blank an existing value.
 */
export async function syncProviderCredentialsFromInfisical(
  options: InfisicalCredentialSyncOptions = {}
): Promise<InfisicalCredentialSyncResult> {
  if (syncInFlight) return syncInFlight;
  const run = syncOnce(options);
  syncInFlight = run;
  try {
    return await run;
  } finally {
    if (syncInFlight === run) syncInFlight = null;
  }
}
