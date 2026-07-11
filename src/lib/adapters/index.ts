import { decrypt } from "@/lib/crypto";
import {
  decryptProviderSecretConfig,
  mergeProviderConfig,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import { unsupportedError } from "./helpers";
import type { Provider } from "@prisma/client";
import type { UsageResult } from "./openai";

type AdapterFn = (
  apiKey: string,
  config?: Record<string, unknown>
) => Promise<UsageResult>;

const adapters: Record<string, AdapterFn> = {};

async function loadAdapters() {
  if (Object.keys(adapters).length > 0) return;

  const modules = await Promise.all([
    import("./openai"),
    import("./anthropic"),
    import("./google-ai"),
    import("./pinecone"),
    import("./cloudflare"),
    import("./custom"),
    import("./deepseek"),
    import("./xai"),
    import("./mistral"),
    import("./llamaindex"),
    import("./fmp"),
    import("./finnhub"),
    import("./alphavantage"),
    import("./tradier"),
    import("./marketstack"),
    import("./intrinio"),
    import("./tiingo"),
    import("./twelvedata"),
    import("./fintech_studios"),
    import("./massive"),
    import("./fred"),
    import("./voyage"),
    import("./sentry"),
    import("./langfuse"),
    import("./twilio"),
    import("./resend"),
    import("./pushover"),
    import("./apify"),
    import("./stripe"),
    import("./robinhood"),
    import("./alpaca"),
    import("./agent-sync-relay"),
    import("./hetzner"),
    import("./github"),
    import("./vercel"),
    import("./render"),
  ]);

  const [
    openai, anthropic, googleAi, pinecone, cloudflare, custom,
    deepseek, xai, mistral, llamaindex,
    fmp, finnhub, alphavantage, tradier, marketstack, intrinio, tiingo, twelvedata, fintech_studios, massive, fred,
    voyage,
    sentry, langfuse,
    twilio, resend, pushover,
    apify,
    stripe,
    robinhood, alpaca,
    agentSyncRelay,
    hetzner,
    github,
    vercel,
    render,
  ] = modules;

  // LLM/AI
  adapters["openai"] = openai.fetchUsage;
  adapters["anthropic"] = anthropic.fetchUsage;
  adapters["google-ai"] = googleAi.fetchUsage;
  adapters["google_ai"] = googleAi.fetchUsage;
  adapters["googleai"] = googleAi.fetchUsage;
  adapters["google"] = googleAi.fetchUsage;
  adapters["deepseek"] = deepseek.fetchUsage;
  adapters["xai"] = xai.fetchUsage;
  adapters["mistral"] = mistral.fetchUsage;
  adapters["llamaindex"] = llamaindex.fetchUsage;

  // Vector DB
  adapters["pinecone"] = pinecone.fetchUsage;
  adapters["voyage"] = voyage.fetchUsage;

  // Market Data
  adapters["fmp"] = fmp.fetchUsage;
  adapters["finnhub"] = finnhub.fetchUsage;
  adapters["alphavantage"] = alphavantage.fetchUsage;
  adapters["tradier"] = tradier.fetchUsage;
  adapters["marketstack"] = marketstack.fetchUsage;
  adapters["intrinio"] = intrinio.fetchUsage;
  adapters["tiingo"] = tiingo.fetchUsage;
  adapters["twelvedata"] = twelvedata.fetchUsage;
  adapters["fintech-studios"] = fintech_studios.fetchUsage;
  adapters["massive"] = massive.fetchUsage;
  adapters["fred"] = fred.fetchUsage;

  // Observability
  adapters["sentry"] = sentry.fetchUsage;
  adapters["langfuse"] = langfuse.fetchUsage;

  // Notifications
  adapters["twilio"] = twilio.fetchUsage;
  adapters["resend"] = resend.fetchUsage;
  adapters["pushover"] = pushover.fetchUsage;

  // Infrastructure
  adapters["cloudflare"] = cloudflare.fetchUsage;
  adapters["hetzner"] = hetzner.fetchUsage;
  adapters["github"] = github.fetchUsage;
  adapters["vercel"] = vercel.fetchUsage;
  adapters["render"] = render.fetchUsage;

  // Data
  adapters["apify"] = apify.fetchUsage;

  // Payments
  adapters["stripe"] = stripe.fetchUsage;

  // Brokerage
  adapters["robinhood"] = robinhood.fetchUsage;
  adapters["alpaca"] = alpaca.fetchUsage;

  // Custom
  adapters["custom"] = custom.fetchUsage;

  // Agent Sync Relay (monitoring)
  adapters["agent-sync-relay"] = agentSyncRelay.fetchUsage;
  adapters["agent_sync_relay"] = agentSyncRelay.fetchUsage;
}

export async function fetchProviderUsage(
  provider: Provider
): Promise<UsageResult> {
  await loadAdapters();

  // Provider type is the credential-routing boundary. A custom provider may
  // deliberately use the same display slug as a built-in, but its credential
  // must still go only to its configured custom endpoint. Conversely, generic
  // manual rows and unknown built-ins must fail closed instead of falling back
  // to an adapter selected only by name.
  const providerType = provider.type.trim().toLowerCase();
  const providerName = provider.name.trim().toLowerCase();
  let adapter: AdapterFn;

  if (providerType === "custom") {
    adapter = adapters["custom"];
  } else if (providerType === "generic") {
    unsupportedError(
      `${provider.name}: generic providers are manual-only and have no poll adapter`
    );
  } else if (providerType === "builtin") {
    const builtinAdapter =
      providerName === "custom" ? undefined : adapters[providerName];
    if (!builtinAdapter) {
      unsupportedError(`No built-in adapter found for provider: ${provider.name}`);
    }
    adapter = builtinAdapter;
  } else {
    unsupportedError(`Unsupported provider type: ${provider.type}`);
  }

  const apiKey = provider.apiKey ? decrypt(provider.apiKey) : "";
  const storedConfig =
    (provider.config as Record<string, unknown> | null) ?? {};
  const legacySplit = splitProviderConfig(storedConfig);
  const encryptedSecrets = decryptProviderSecretConfig(provider.secretConfig);
  const config = mergeProviderConfig(
    legacySplit.publicConfig,
    mergeProviderConfig(legacySplit.secretConfig, encryptedSecrets)
  );

  return adapter(apiKey, config);
}

export { loadAdapters };
