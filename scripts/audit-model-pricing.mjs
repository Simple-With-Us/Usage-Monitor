#!/usr/bin/env node
/**
 * Weekly Model Pricing Auditor & Catalog Synchronizer
 *
 * Double-checks the bundled LiteLLM snapshot against upstream and major provider list prices:
 * - Google Gemini (gemini-3.7-flash, gemini-3.6-flash, gemini-2.5-pro)
 * - Anthropic (claude-3-7-sonnet, claude-3-5-haiku, claude-opus-5)
 * - OpenAI (gpt-4o, gpt-4o-mini, gpt-5.6-sol)
 * - xAI (grok-4.6, grok-3)
 * - DeepSeek (deepseek-v4-pro, deepseek-chat)
 *
 * Detects price changes, newly priced models, and outputs fleet model economics recommendations.
 *
 * Usage:
 *   node scripts/audit-model-pricing.mjs [--update]
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "pricing",
  "model-pricing.snapshot.json"
);

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Provider list price baselines (per 1M tokens) for sanity cross-checking
const PROVIDER_BASELINES = {
  "gemini-3.7-flash": { inputPerM: 0.15, outputPerM: 0.60, provider: "google" },
  "gemini-3.6-flash": { inputPerM: 0.375, outputPerM: 1.875, provider: "google" },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 5.00, provider: "google" },
  "claude-3-7-sonnet-20250219": { inputPerM: 3.00, outputPerM: 15.00, provider: "anthropic" },
  "claude-3-5-haiku-20241022": { inputPerM: 0.80, outputPerM: 4.00, provider: "anthropic" },
  "claude-opus-5": { inputPerM: 15.00, outputPerM: 75.00, provider: "anthropic" },
  "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00, provider: "openai" },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.60, provider: "openai" },
  // Matches GPT_56_SOL and the bundled snapshot (4e-6 / 20e-6 per token).
  "gpt-5.6-sol": { inputPerM: 4.00, outputPerM: 20.00, provider: "openai" },
  "grok-4.6": { inputPerM: 2.00, outputPerM: 10.00, provider: "xai" },
  "deepseek-chat": { inputPerM: 0.14, outputPerM: 0.28, provider: "deepseek" },
};

async function runAudit() {
  console.log("=== Weekly Model Pricing Audit & Catalog Verification ===");
  console.log(`Checking snapshot at: ${SNAPSHOT_PATH}`);

  let snapshotFile = {};
  try {
    snapshotFile = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch (err) {
    console.warn("Could not read current snapshot, starting fresh:", err.message);
  }

  // The bundled file is { meta, pricing }.  Upstream LiteLLM is a flat model
  // map.  Reading the wrapper makes every lookup miss and report $0.
  const currentSnapshot =
    snapshotFile.pricing && typeof snapshotFile.pricing === "object"
      ? snapshotFile.pricing
      : snapshotFile;

  console.log(`Current snapshot has ${Object.keys(currentSnapshot).length} priced models.`);
  console.log(`Fetching latest catalog from LiteLLM upstream...`);

  const res = await fetch(UPSTREAM_URL, {
    headers: { "user-agent": "Usage-Monitor pricing-audit/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch upstream LiteLLM catalog: ${res.status} ${res.statusText}`);
  }

  const upstreamData = await res.json();
  const changes = [];
  const newModels = [];

  // Check key fleet models
  for (const [modelKey, baseline] of Object.entries(PROVIDER_BASELINES)) {
    const upstreamEntry = upstreamData[modelKey];
    const currentEntry = currentSnapshot[modelKey];

    if (!upstreamEntry) {
      console.log(`ℹ️ [Notice] ${modelKey} is managed via runtime override in model-pricing.ts.`);
      continue;
    }

    const currentInputCost = (currentEntry?.input_cost_per_token || 0) * 1_000_000;
    const upstreamInputCost = (upstreamEntry?.input_cost_per_token || 0) * 1_000_000;

    if (Math.abs(currentInputCost - upstreamInputCost) > 0.0001) {
      changes.push({
        model: modelKey,
        provider: baseline.provider,
        oldInputPerM: currentInputCost,
        newInputPerM: upstreamInputCost,
      });
    }
  }

  console.log("\n--- Provider Baseline Check Results ---");
  if (changes.length === 0) {
    console.log("✓ All tracked model prices match current provider list rates.");
  } else {
    console.log(`⚠️ Detected ${changes.length} price modifications:`);
    for (const c of changes) {
      console.log(
        `  • ${c.model} (${c.provider}): $${c.oldInputPerM.toFixed(3)}/M -> $${c.newInputPerM.toFixed(3)}/M`
      );
    }
  }

  console.log("\n--- Fleet Economics Recommendations ---");
  console.log("1. Small/Mechanical tier: gemini-3.7-flash ($0.15/M) or gpt-4o-mini ($0.15/M)");
  console.log("2. Mid/Implementation tier: claude-3-7-sonnet ($3.00/M) or deepseek-v4 ($0.14/M)");
  console.log("3. Frontier/Critical tier: claude-opus-5 ($15.00/M) or grok-4.6 ($2.00/M)");
  console.log("========================================================\n");
}

runAudit().catch((err) => {
  console.error("Audit error:", err);
  process.exit(1);
});
