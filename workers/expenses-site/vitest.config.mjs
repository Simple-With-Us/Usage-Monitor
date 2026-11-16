import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: new URL("./wrangler.jsonc", import.meta.url).pathname,
      },
      miniflare: {
        bindings: {
          USAGE_READ_TOKEN: "local-only",
          UPSTREAM_URL: "https://usage.example.test",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["workers/expenses-site/**/*.workers.test.mjs"],
    testTimeout: 60_000,
  },
});
