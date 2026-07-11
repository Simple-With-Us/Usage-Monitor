import { decrypt } from "@/lib/crypto";
import {
  decryptProviderSecretConfig,
  mergeProviderConfig,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import type { Provider } from "@prisma/client";
import type { BuiltInProviderName } from "@/lib/provider-definitions";
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

  // Keep the Add Provider catalog and poll registry compile-time exhaustive.
  const builtInAdapters: Record<BuiltInProviderName, AdapterFn> = {
    openai: openai.fetchUsage,
    anthropic: anthropic.fetchUsage,
    "google-ai": googleAi.fetchUsage,
    deepseek: deepseek.fetchUsage,
    xai: xai.fetchUsage,
    mistral: mistral.fetchUsage,
    github: github.fetchUsage,
    vercel: vercel.fetchUsage,
    render: render.fetchUsage,
    pinecone: pinecone.fetchUsage,
    voyage: voyage.fetchUsage,
    fmp: fmp.fetchUsage,
    finnhub: finnhub.fetchUsage,
    alphavantage: alphavantage.fetchUsage,
    tradier: tradier.fetchUsage,
    marketstack: marketstack.fetchUsage,
    intrinio: intrinio.fetchUsage,
    tiingo: tiingo.fetchUsage,
    twelvedata: twelvedata.fetchUsage,
    "fintech-studios": fintech_studios.fetchUsage,
    massive: massive.fetchUsage,
    fred: fred.fetchUsage,
    sentry: sentry.fetchUsage,
    langfuse: langfuse.fetchUsage,
    twilio: twilio.fetchUsage,
    resend: resend.fetchUsage,
    pushover: pushover.fetchUsage,
    cloudflare: cloudflare.fetchUsage,
    hetzner: hetzner.fetchUsage,
    apify: apify.fetchUsage,
    llamaindex: llamaindex.fetchUsage,
    stripe: stripe.fetchUsage,
    robinhood: robinhood.fetchUsage,
    alpaca: alpaca.fetchUsage,
  };
  Object.assign(adapters, builtInAdapters);

  // Historical aliases retained for existing rows.
  adapters["google_ai"] = googleAi.fetchUsage;
  adapters["googleai"] = googleAi.fetchUsage;
  adapters["google"] = googleAi.fetchUsage;

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

  const adapter = adapters[provider.name.toLowerCase()] ?? adapters["custom"];
  if (!adapter) {
    throw new Error(`No adapter found for provider: ${provider.name}`);
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
