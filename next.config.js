const path = require("path");

const isProduction = process.env.NODE_ENV === "production";
// Content-Security-Policy is now handled in src/middleware.ts

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: [
    "@prisma/client",
    "dd-trace",
    "@datadog/native-metrics",
    "@datadog/pprof",
    "@datadog/native-appsec",
    "@datadog/native-iast-taint-tracking",
    "@datadog/wasm-js-rewriter",
    "@sentry/profiling-node",
  ],
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/privacy-policy",
        destination: "/privacy",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=()" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

// Self error-reporting (review finding O4). withSentryConfig is applied ONLY
// when a DSN is configured, so CI/dev builds with no Sentry env never load
// the Sentry build plugin at all. Sourcemap upload additionally requires
// SENTRY_AUTH_TOKEN; without it the upload is disabled explicitly (silent,
// never a build failure). Every existing option and header above is passed
// through untouched.
// @sentry/nextjs 11 moved withSentryConfig to the /config entry. The package
// root is the runtime SDK and does not export it (requiring the root yields
// undefined, and the call throws "withSentryConfig is not a function").
if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const { withSentryConfig } = require("@sentry/nextjs/config");
  module.exports = withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_SELF_PROJECT || "usage-monitor",
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: true,
    sourcemaps: {
      disable: !process.env.SENTRY_AUTH_TOKEN,
    },
  });
}
