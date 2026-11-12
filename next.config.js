const path = require("path");
const { PHASE_PRODUCTION_BUILD } = require("next/constants");
const { sentryBuildRelease } = require("./scripts/sentry-build-release.cjs");

// Content-Security-Policy is now handled in src/middleware.ts

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
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

// Preserve SDK configuration in every phase, with uploads only in production builds.
// A build-only upload token is sufficient even when the DSN is injected at runtime.
// Without the token, local/CI builds keep sourcemap upload disabled.
// @sentry/nextjs 11 moved withSentryConfig to the /config entry. The package
// root is the runtime SDK and does not export it (requiring the root yields
// undefined, and the call throws "withSentryConfig is not a function").
module.exports = (phase) => {
  const authToken = phase === PHASE_PRODUCTION_BUILD ? process.env.SENTRY_AUTH_TOKEN : undefined;
  const releaseName = sentryBuildRelease();
  if (authToken && !releaseName) {
    throw new Error("Sentry upload requires a full source commit SHA");
  }
  if (!(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || authToken)) {
    return nextConfig;
  }
  const { withSentryConfig } = require("@sentry/nextjs/config");
  return withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG || "simple-with-us",
    project: process.env.SENTRY_SELF_PROJECT || "usage-monitor",
    authToken,
    release: { name: releaseName },
    errorHandler: authToken ? () => {
      throw new Error("Sentry release upload failed");
    } : undefined,
    silent: true,
    sourcemaps: {
      disable: !authToken,
    },
  });
};
