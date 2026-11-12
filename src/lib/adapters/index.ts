import { decrypt } from "@/lib/crypto";
import {
  mergeProviderConfig,
  providerConfigForServer,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import { configurationError, unsupportedError, blindProviderResult } from "./helpers";
import type { AdapterInvocationContext } from "./helpers";
import type { Provider } from "@prisma/client";
import type { BuiltInProviderName } from "@/lib/provider-definitions";
import { canonicalProviderKey } from "@/lib/provider-identity";
import { isDecommissionedProviderName } from "@/lib/provider-definitions";
import type { UsageResult } from "./openai";

type AdapterFn = (
  apiKey: string,
  config?: Record<string, unknown>,
  context?: AdapterInvocationContext
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
    import("./openrouter"),
    import("./llamaindex"),
    import("./fmp"),
    import("./finnhub"),
    import("./alphavantage"),
    import("./marketstack"),
    import("./tiingo"),
    import("./twelvedata"),
    import("./fintech_studios"),
    import("./massive"),
    import("./fred"),
    import("./unusualwhales"),
    import("./sentry"),
    import("./langfuse"),
    import("./twilio"),
    import("./resend"),
    import("./pushover"),
    import("./apify"),
    import("./stripe"),
    import("./ag***-s**c-relay"),
    import("./hetzner"),
    import("./backblaze"),
    import("./github"),
    import("./render"),
    import("./oracle"),
    import("./coolify"),
    import("./deno"),
    import("./namecheap"),
  ]);

  const [
    openai, anthropic, googleAi, pinecone, cloudflare, custom,
    deepseek, xai, mistral, openrouter, llamaindex,
    fmp, finnhub, alphavantage, marketstack, tiingo, twelvedata, fintech_studios, massive, fred,
    unusualwhales,
    sentry, langfuse,
    twilio, resend, pushover,
    apify,
    stripe,
    ag***s**cRelay,
    hetzner,
    backblaze,
    github,
    render,
    oracle,
    coolify,
    deno,
    namecheap,
  ] = modules;

  // Active built-ins are loaded into the poll registry. Retired and dormant
  // adapter implementations remain in source for historical context only.
  const builtInAdapters: Partial<Record<BuiltInProviderName, AdapterFn>> = {
    openai: openai.fetchUsage,
    anthropic: anthropic.fetchUsage,
    "google-ai": googleAi.fetchUsage,
    deepseek: deepseek.fetchUsage,
    xai: xai.fetchUsage,
    mistral: mistral.fetchUsage,
    openrouter: openrouter.fetchUsage,
    github: github.fetchUsage,
    render: render.fetchUsage,
    pinecone: pinecone.fetchUsage,
    voyage: async () =>
      blindProviderResult(
        "voyage",
        "No documented non-billable usage or billing API exists; no inference probe was sent."
      ),
    roic: async () =>
      blindProviderResult(
        "roic",
        "No documented non-billable ROIC.ai usage/billing API is wired; track via Subscription or push telemetry."
      ),
    fmp: fmp.fetchUsage,
    finnhub: finnhub.fetchUsage,
    alphavantage: alphavantage.fetchUsage,
    marketstack: marketstack.fetchUsage,
    tiingo: tiingo.fetchUsage,
    twelvedata: twelvedata.fetchUsage,
    "fintech-studios": fintech_studios.fetchUsage,
    massive: massive.fetchUsage,
    fred: fred.fetchUsage,
    "quiver-quant": async () =>
      blindProviderResult(
        "quiver-quant",
        "Quiver Quantitative does not expose a billing or usage quota API endpoint. Usage tracked via dashboard."
      ),
    "unusual-whales": unusualwhales.fetchUsage,
    sentry: sentry.fetchUsage,
    langfuse: langfuse.fetchUsage,
    twilio: twilio.fetchUsage,
    resend: resend.fetchUsage,
    pushover: pushover.fetchUsage,
    cloudflare: cloudflare.fetchUsage,
    hetzner: hetzner.fetchUsage,
    backblaze: backblaze.fetchUsage,
    apify: apify.fetchUsage,
    llamaindex: llamaindex.fetchUsage,
    stripe: stripe.fetchUsage,
    namecheap: namecheap.fetchUsage,
    oracle: oracle.fetchUsage,
    coolify: coolify.fetchUsage,
    deno: deno.fetchUsage,
  };
  Object.assign(adapters, builtInAdapters);

  // Historical aliases retained for existing rows.
  adapters["google_ai"] = googleAi.fetchUsage;
  adapters["googleai"] = googleAi.fetchUsage;
  adapters["google"] = googleAi.fetchUsage;

  // Custom
  adapters["custom"] = custom.fetchUsage;

  // Ag*** S**c Relay (monitoring)
  adapters["ag***-s**c-relay"] = ag***s**cRelay.fetchUsage;
  adapters["ag***_s**c_relay"] = ag***s**cRelay.fetchUsage;
}

export async function fetchProviderUsage(
  provider: Provider
): Promise<UsageResult> {
  await loadAdapters();

  if (isDecommissionedProviderName(provider.name)) {
    unsupportedError(
      `${provider.name}: this built-in provider is dormant or retired and is not polled`
    );
  }

  // Provider type is the credential-routing boundary. A custom provider may
  // deliberately use the same display slug as a built-in, but its credential
  // must still go only to its configured custom endpoint. Conversely, generic
  // manual rows and unknown built-ins must fail closed instead of falling back
  // to an adapter selected only by name.
  const providerType = provider.type.trim().toLowerCase();
  const providerName = provider.name.trim().toLowerCase();
  let adapter: AdapterFn;
  let isGeminiAdapter = false;

  if (providerType === "custom") {
    adapter = adapters["custom"];
  } else if (providerType === "generic" || providerType === "push") {
    unsupportedError(
      `${provider.name}: ${providerType} providers are manual/push-only and have no poll adapter`
    );
  } else if (providerType === "builtin") {
    // Historical Gemini labels participate in accounting identity resolution,
    // so they must reach the same poll adapter too. Keep this canonicalization
    // narrow: custom providers still route only by type and unrelated aliases
    // cannot silently acquire a built-in credential destination.
    const adapterName =
      canonicalProviderKey(providerName) === "google-ai"
        ? "google-ai"
        : providerName === "cloudflare" || providerName.startsWith("cloudflare-")
          ? "cloudflare"
          : providerName;
    isGeminiAdapter = adapterName === "google-ai";
    const builtinAdapter =
      providerName === "custom" ? undefined : adapters[adapterName];
    if (!builtinAdapter) {
      configurationError(`No built-in adapter found for provider: ${provider.name}`);
    }
    adapter = builtinAdapter;
  } else {
    configurationError(`Unsupported provider type: ${provider.type}`);
  }

  let apiKey = "";
  let apiKeyReadable = true;
  if (provider.apiKey) {
    try {
      apiKey = decrypt(provider.apiKey);
    } catch (error) {
      if (!isGeminiAdapter) throw error;
      apiKeyReadable = false;
    }
  }

  let config: Record<string, unknown>;
  let secretConfigReadable = true;
  try {
    config = providerConfigForServer(provider.config, provider.secretConfig);
  } catch (error) {
    if (!isGeminiAdapter) throw error;
    secretConfigReadable = false;
    // Preserve readable public and legacy configuration so Gemini key
    // validation can still run. The Google adapter receives the unreadable
    // envelope state out-of-band and will not attempt billing with it.
    const split = splitProviderConfig(provider.config);
    config = mergeProviderConfig(split.publicConfig, split.secretConfig);
  }

  if (isGeminiAdapter) {
    return adapter(apiKey, config, {
      apiKeyConfigured: provider.apiKey != null,
      apiKeyReadable,
      secretConfigConfigured: provider.secretConfig != null,
      secretConfigReadable,
    });
  }

  return adapter(apiKey, config);
}

export { loadAdapters };
