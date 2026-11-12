/**
 * Opt-in live probe harness — SKIPPED unless `PLATFORM_STATUS_LIVE=1`.
 *
 * Runs the real platform-status registry against whatever credentials are in
 * the environment and prints one line per platform.  It hits real third-party
 * APIs, so it must never run in CI or in the default suite — hence the
 * env-gated skip.
 *
 * Cards are secret-free by contract (see the "never emits a value that looks
 * like a credential" assertion in platform-status-registry.test.ts), so this
 * OUTPUT is safe.  The ENVIRONMENT it runs with is not: never print
 * `process.env` here, and redirect stderr away from anything that displays it.
 *
 * Run with:
 *   fleet-secrets run -- env PLATFORM_STATUS_LIVE=1 node_modules/.bin/vitest run \
 *     src/lib/__tests__/platform-status-live.test.ts
 */

import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { fetchPlatformStatus } from "@/lib/platform-status/registry";

const LIVE = process.env.PLATFORM_STATUS_LIVE === "1";

describe.skipIf(!LIVE)("live platform probe (opt-in)", () => {
  it(
    "reports each platform's live state",
    async () => {
      const payload = await fetchPlatformStatus();

      const rows = payload.platforms.map((platform) => ({
        platform: platform.name,
        state: platform.state,
        configured: platform.configured,
        headline: platform.headline ?? "",
        metrics: platform.metrics.map((m) => `${m.label}=${m.value}`).join(" | "),
        error: platform.error ?? "",
      }));

      const lines = ["=== LIVE PLATFORM STATUS ==="];
      for (const row of rows) {
        lines.push(
          `${row.configured ? "*" : "-"} ${row.platform.padEnd(22)} ${row.state.padEnd(14)} ${
            row.error ? `[${row.error}] ` : ""
          }${row.headline}`
        );
        if (row.metrics) lines.push(`    ${row.metrics}`);
      }
      lines.push(`\nsummary: ${JSON.stringify(payload.summary)}`);
      const report = `${lines.join("\n")}\n`;

      // Vitest swallows console output in `run` mode, so write the report where
      // the operator asked for it.  Cards are secret-free by contract.
      const destination = process.env.PLATFORM_STATUS_LIVE_OUT;
      if (destination) writeFileSync(destination, report);
      else process.stdout.write(report);
    },
    180_000
  );
});
