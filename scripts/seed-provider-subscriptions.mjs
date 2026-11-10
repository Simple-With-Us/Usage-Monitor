#!/usr/bin/env node
/**
 * One-time, idempotent seed for "subscription -> knob linkage phase 1" (see
 * docs/rollouts/2026-07-10-subscription-knob-linkage.md).
 *
 * Creates/updates:
 *   1. `Subscription` rows for catalog plans the owner may be on (or
 *      considering).  New rows default to `considering` so a seed pass
 *      cannot invent paid cash on the next maintenance cycle.  Activate a
 *      row only after a receipt or owner-recorded expense confirms it.
 *      each carrying a `knobEnv` map (env-var knob name -> string value) that
 *      overrides the provider's free-tier baseline while active/considered.
 *   2. `ProviderPlan.knobEnv` FREE-TIER baseline maps for tiingo, twelvedata,
 *      alphavantage, and finnhub — the values a consuming app (Socratic.Trade)
 *      should use when NOT on a paid plan for that provider.
 *
 * Run this EXACTLY ONCE against a writable app database (local or the
 * Coolify / Hetzner SQLite volume).  Do not use it to invent paid cash:
 *
 *   node scripts/seed-provider-subscriptions.mjs
 *
 * Safe to re-run (every write is idempotent):
 *   - Provider lookup is case-insensitive-by-name find-or-create (never
 *     renames an existing row).
 *   - Subscription lookup is by (providerId, name) — if a match already
 *     exists this script SKIPS it (never overwrites a row an operator may
 *     have since edited by hand).
 *   - ProviderPlan.knobEnv is written ONLY IF the column is currently null —
 *     an already-set value (from this script's prior run, or a manual edit)
 *     is left untouched.
 *
 * IMPORTANT - Alpha Vantage provider name: "alphavantage" (NO hyphen). The
 * adapter registry (src/lib/adapters/index.ts) dispatches usage-fetch on
 * `provider.name.toLowerCase()` and only registers the key "alphavantage" —
 * a Provider row named e.g. "alpha-vantage" would fail closed as an unknown
 * built-in (no polling) instead of reaching the Alpha Vantage adapter. This
 * script creates/matches the provider as
 * "alphavantage" and WARNS (does not rename) if a hyphenated near-miss name
 * is found in the database instead.
 */

import { createPrismaClient } from "./lib/create-prisma-client.mjs";

const prisma = createPrismaClient();

function log(message) {
  console.log(`[seed-provider-subscriptions] ${message}`);
}

// Duplicated from src/lib/subscriptions.ts's addUtcMonths/initialCycle (that
// module is TypeScript compiled as part of the Next.js app; this script is
// plain standalone ESM run directly via `node`, so it re-implements the same
// small piece of pure date math rather than pulling in a build step).
function addUtcMonths(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(
    Date.UTC(
      year,
      month + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

function initialMonthlyCycle(startDate) {
  return { currentPeriodStart: startDate, nextRenewalAt: addUtcMonths(startDate, 1) };
}

// name -> Provider defaults used ONLY when a matching provider doesn't exist
// yet. displayName/category match the conventions already used in
// src/components/AddProviderModal.tsx's PROVIDER_CATALOG for these same
// providers.
const PROVIDER_DEFAULTS = {
  massive: { displayName: "Massive", category: "Market Data" },
  fmp: { displayName: "FMP", category: "Market Data" },
  tiingo: { displayName: "Tiingo", category: "Market Data" },
  twelvedata: { displayName: "Twelve Data", category: "Market Data" },
  alphavantage: { displayName: "Alpha Vantage", category: "Market Data" },
  finnhub: { displayName: "Finnhub", category: "Market Data" },
  anthropic: { displayName: "Anthropic", category: "LLM" },
  kimi: { displayName: "Kimi / Moonshot AI", category: "LLM" },
};

// Subscriptions to seed. costUsd/interval are the CURRENT (monthly) sticker
// price; `notes` records the annual-billing alternative where relevant so a
// human comparing tiers has it without leaving this table.
const SUBSCRIPTIONS = [
  {
    providerName: "massive",
    name: "Stocks Starter",
    status: "considering",
    costUsd: 29,
    notes:
      "Catalog only.  Gmail 2026-07: Stripe $29 renewals failed (not paid).  Activate only after a successful receipt.",
    knobEnv: { MASSIVE_REST_MAX_CALLS_PER_MINUTE: "100" },
  },
  {
    providerName: "fmp",
    name: "Starter",
    status: "considering",
    costUsd: 29,
    notes:
      "Catalog only.  Gmail: last paid receipt #2240-0152 on 2026-06-22 ($31.90 with tax); July renewals failed and API was suspended 2026-07-27.",
    knobEnv: {},
  },
  {
    providerName: "anthropic",
    name: "Claude Pro",
    status: "considering",
    costUsd: 20,
    notes:
      "Catalog only.  Gmail: Pro $21.32 on 2026-07-02, then Max upgrades, then Max canceled 2026-07-03 (access ended 2026-08-03).  No August Anthropic receipt in Gmail.",
    knobEnv: {},
  },
  {
    providerName: "kimi",
    name: "Kimi Apple IAP",
    status: "considering",
    costUsd: 199,
    notes:
      "Catalog only.  Owner email 2026-08-11: highest tier $199 via Apple IAP.  Apple receipt lives on iCloud, not Gmail.",
    knobEnv: {},
  },
  {
    providerName: "tiingo",
    name: "Power",
    status: "considering",
    costUsd: 30,
    notes:
      "annual $300/yr (2 months free) — owner-verified 2026-07-10; marketing matrix hides it",
    knobEnv: {
      PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000",
      PROVIDER_QUOTA_TIINGO_PER_DAY: "100000",
      TIINGO_DROP_NEWS: "false",
    },
  },
  {
    providerName: "fmp",
    name: "Premium",
    status: "considering",
    costUsd: 59,
    notes: "billed annually $708/yr; quarterly fundamentals + 750 calls/min",
    knobEnv: {},
  },
];

// Provider name -> FREE-TIER knobEnv map (ProviderPlan.knobEnv). Set
// only-if-currently-null — see the idempotency note in the file header.
const FREE_TIER_KNOB_MAPS = {
  tiingo: {
    PROVIDER_QUOTA_TIINGO_PER_HOUR: "50",
    PROVIDER_QUOTA_TIINGO_PER_DAY: "1000",
    TIINGO_DROP_NEWS: "true",
  },
  twelvedata: {
    PROVIDER_QUOTA_TWELVEDATA_PER_MIN: "8",
    PROVIDER_QUOTA_TWELVEDATA_PER_DAY: "800",
  },
  alphavantage: {
    PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS: "1100",
    PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY: "1",
  },
  finnhub: {
    PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "50",
  },
};

async function findProviderCaseInsensitive(name) {
  const providers = await prisma.provider.findMany();
  return providers.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
}

async function warnOnHyphenatedNearMiss(canonicalName) {
  if (!canonicalName.includes("-") && canonicalName === "alphavantage") {
    const providers = await prisma.provider.findMany();
    const nearMiss = providers.find(
      (p) => p.name.toLowerCase() !== canonicalName && p.name.toLowerCase().replace(/[-_]/g, "") === canonicalName
    );
    if (nearMiss) {
      log(
        `WARNING: found provider "${nearMiss.name}" (id=${nearMiss.id}) which looks like a ` +
          `hyphen/underscore variant of "${canonicalName}". The adapter registry only recognizes ` +
          `the exact name "alphavantage" (src/lib/adapters/index.ts) — "${nearMiss.name}" fails ` +
          `closed without a poll adapter. This script does ` +
          `NOT rename it; that is a manual data-repair decision.`
      );
    }
  }
}

async function findOrCreateProvider(name) {
  const defaults = PROVIDER_DEFAULTS[name];
  if (!defaults) throw new Error(`No PROVIDER_DEFAULTS entry for "${name}"`);

  await warnOnHyphenatedNearMiss(name);

  const existing = await findProviderCaseInsensitive(name);
  if (existing) {
    log(`Provider "${name}" already exists as "${existing.name}" (id=${existing.id}).`);
    return existing;
  }

  log(`Creating provider "${name}" (${defaults.displayName})...`);
  return prisma.provider.create({
    data: {
      name,
      displayName: defaults.displayName,
      type: "builtin",
      category: defaults.category,
      refreshIntervalMin: 60,
    },
  });
}

async function seedFreeTierKnobEnv(providerId, providerName, knobEnv) {
  const existingPlan = await prisma.providerPlan.findUnique({ where: { providerId } });

  if (!existingPlan) {
    log(`Creating ProviderPlan for "${providerName}" with free-tier knobEnv...`);
    await prisma.providerPlan.create({ data: { providerId, knobEnv } });
    return;
  }

  if (existingPlan.knobEnv != null) {
    log(`ProviderPlan.knobEnv for "${providerName}" is already set — leaving it untouched (idempotent).`);
    return;
  }

  log(`Setting free-tier knobEnv on existing ProviderPlan for "${providerName}"...`);
  await prisma.providerPlan.update({ where: { providerId }, data: { knobEnv } });
}

async function seedSubscription(provider, def) {
  const existing = await prisma.subscription.findFirst({
    where: { providerId: provider.id, name: def.name },
  });
  if (existing) {
    log(
      `Subscription "${def.name}" for provider "${provider.name}" already exists ` +
        `(id=${existing.id}, status=${existing.status}) — skipping (idempotent, not overwriting).`
    );
    return existing;
  }

  const now = new Date();
  const { currentPeriodStart, nextRenewalAt } = initialMonthlyCycle(now);

  log(
    `Creating subscription "${def.name}" for provider "${provider.name}" ` +
      `($${def.costUsd}/mo, status=${def.status})...`
  );
  return prisma.subscription.create({
    data: {
      providerId: provider.id,
      name: def.name,
      costUsd: def.costUsd,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      startDate: now,
      currentPeriodStart,
      nextRenewalAt,
      autoRenew: true,
      status: def.status,
      notes: def.notes,
      knobEnv: def.knobEnv,
    },
  });
}

async function main() {
  log("Starting...");

  const providerCache = new Map();
  async function provider(name) {
    if (!providerCache.has(name)) {
      providerCache.set(name, await findOrCreateProvider(name));
    }
    return providerCache.get(name);
  }

  for (const def of SUBSCRIPTIONS) {
    const p = await provider(def.providerName);
    await seedSubscription(p, def);
  }

  for (const [providerName, knobEnv] of Object.entries(FREE_TIER_KNOB_MAPS)) {
    const p = await provider(providerName);
    await seedFreeTierKnobEnv(p.id, providerName, knobEnv);
  }

  log("Done.");
}

main()
  .catch((error) => {
    console.error("[seed-provider-subscriptions] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
