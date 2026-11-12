import { main } from "./hub.mjs";

// The server rollout has one data policy regardless of injected overrides.
process.env.TELEMETRY_HUB_SENTRY_ONLY = "1";
process.env.TELEMETRY_HUB_METADATA_ONLY = "1";
delete process.env.INFISICAL_TOKEN;
let destinationValid = false;
try {
  const destination = new URL(process.env.SENTRY_OTLP_ENDPOINT);
  destinationValid = destination.protocol === "https:" && (destination.hostname === "sentry.io" || destination.hostname.endsWith(".sentry.io")) && /^\/api\/\d+\/integration\/otlp\/?$/.test(destination.pathname) && !destination.username && !destination.password && !destination.search && !destination.hash && /^[a-f0-9]+$/i.test(process.env.SENTRY_PUBLIC_KEY || "");
} catch { /* Fail closed without printing configuration values. */ }
if (!destinationValid) {
  console.error("Hub destination configuration is unavailable");
  process.exit(2);
}
try { await main(["--state-dir", "/data"]); }
catch { console.error("Hub startup failed"); process.exit(1); }
