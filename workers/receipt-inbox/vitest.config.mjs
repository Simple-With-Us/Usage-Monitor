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
          RECEIPT_INBOX_ADDRESS: "receipts-secret-123@receipts.jays.services",
          RECEIPT_INBOX_RETENTION_ACK: "receipt-evidence-lifecycle-configured-v1",
          RECEIPT_INBOX_IDENTITY_KEY: "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
          RECEIPT_INBOX_READ_TOKEN: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
          RECEIPT_INBOX_EVIDENCE_TOKEN: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          RECEIPT_FALLBACK_ADDRESS: "socratic.trade@jays.services",
        },
        serviceBindings: {
          LIFECYCLE_AUDITOR: async () => Response.json({ ok: true, checkedAt: Date.now() }),
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["workers/receipt-inbox/**/*.workers.test.mjs"],
    testTimeout: 30_000,
  },
});
