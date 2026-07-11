import crypto from "node:crypto";

export const PROVIDER_SUBSCRIPTION_PLAN_ID =
  "provider-subscriptions-2026-07-10-v1";
export const PROVIDER_SUBSCRIPTION_EFFECTIVE_AT =
  "2026-07-10T00:00:00.000Z";

const nextRenewalAt = "2026-08-10T00:00:00.000Z";

const provider = (name, displayName) => ({
  id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:provider:${name}`,
  name,
  displayName,
  category: "Market Data",
});

const subscription = (providerName, slug, values) => ({
  id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:subscription:${slug}`,
  providerName,
  startDate: PROVIDER_SUBSCRIPTION_EFFECTIVE_AT,
  currentPeriodStart: PROVIDER_SUBSCRIPTION_EFFECTIVE_AT,
  nextRenewalAt,
  anchorDay: 10,
  currency: "USD",
  interval: "monthly",
  intervalCount: 1,
  autoRenew: true,
  projectId: null,
  externalBillingSource: null,
  externalBillingId: null,
  description: null,
  canceledAt: null,
  ...values,
});

export const PROVIDER_SUBSCRIPTION_PLAN = Object.freeze({
  schemaVersion: 1,
  planId: PROVIDER_SUBSCRIPTION_PLAN_ID,
  effectiveAt: PROVIDER_SUBSCRIPTION_EFFECTIVE_AT,
  providers: [
    provider("massive", "Massive"),
    provider("fmp", "FMP"),
    provider("tiingo", "Tiingo"),
    provider("twelvedata", "Twelve Data"),
    provider("alphavantage", "Alpha Vantage"),
    provider("finnhub", "Finnhub"),
  ],
  subscriptions: [
    subscription("massive", "massive-stocks-starter", {
      name: "Stocks Starter",
      status: "active",
      costUsd: 29,
      notes: "annual available $288/yr",
      knobEnv: { MASSIVE_REST_MAX_CALLS_PER_MINUTE: "100" },
    }),
    subscription("fmp", "fmp-starter", {
      name: "Starter",
      status: "active",
      costUsd: 22,
      notes: "billed annually $264/yr",
      knobEnv: {},
    }),
    subscription("tiingo", "tiingo-power", {
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
    }),
    subscription("fmp", "fmp-premium", {
      name: "Premium",
      status: "considering",
      costUsd: 59,
      notes:
        "billed annually $708/yr; quarterly fundamentals + 750 calls/min",
      knobEnv: {},
    }),
  ],
  freeTierKnobMaps: [
    {
      id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:provider-plan:tiingo`,
      providerName: "tiingo",
      knobEnv: {
        PROVIDER_QUOTA_TIINGO_PER_HOUR: "50",
        PROVIDER_QUOTA_TIINGO_PER_DAY: "1000",
        TIINGO_DROP_NEWS: "true",
      },
    },
    {
      id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:provider-plan:twelvedata`,
      providerName: "twelvedata",
      knobEnv: {
        PROVIDER_QUOTA_TWELVEDATA_PER_MIN: "8",
        PROVIDER_QUOTA_TWELVEDATA_PER_DAY: "800",
      },
    },
    {
      id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:provider-plan:alphavantage`,
      providerName: "alphavantage",
      knobEnv: {
        PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS: "1100",
        PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_CONCURRENCY: "1",
      },
    },
    {
      id: `release:${PROVIDER_SUBSCRIPTION_PLAN_ID}:provider-plan:finnhub`,
      providerName: "finnhub",
      knobEnv: { PROVIDER_RATE_LIMIT_FINNHUB_PER_MIN: "50" },
    },
  ],
});

function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

// Pin the reviewed payload independently from its computed digest. This makes
// an accidental edit under the same plan ID fail even before a receipt exists.
export const PROVIDER_SUBSCRIPTION_PLAN_HASH =
  "1faf2328f66698886c2bcc18599e412c7e4525b643f0ab4e8a032d62a1d60cbb";
const computedPlanHash = digest(PROVIDER_SUBSCRIPTION_PLAN);
if (computedPlanHash !== PROVIDER_SUBSCRIPTION_PLAN_HASH) {
  throw new Error(
    `immutable release plan hash mismatch: expected ${PROVIDER_SUBSCRIPTION_PLAN_HASH}, computed ${computedPlanHash}`
  );
}

export class ReleasePlanConflictError extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.name = "ReleasePlanConflictError";
    this.conflicts = conflicts;
  }
}

function normalizedName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sameJson(left, right) {
  return canonical(left) === canonical(right);
}

function rowFingerprint(row) {
  return digest(row);
}

function expectedSubscription(providerId, spec) {
  return {
    id: spec.id,
    providerId,
    projectId: spec.projectId,
    externalBillingSource: spec.externalBillingSource,
    externalBillingId: spec.externalBillingId,
    name: spec.name,
    description: spec.description,
    costUsd: spec.costUsd,
    currency: spec.currency,
    interval: spec.interval,
    intervalCount: spec.intervalCount,
    anchorDay: spec.anchorDay,
    startDate: new Date(spec.startDate),
    currentPeriodStart: new Date(spec.currentPeriodStart),
    nextRenewalAt: new Date(spec.nextRenewalAt),
    lastChargedPeriodStart: null,
    autoRenew: spec.autoRenew,
    status: spec.status,
    canceledAt: spec.canceledAt,
    notes: spec.notes,
    knobEnv: spec.knobEnv,
  };
}

function comparableSubscription(row, { includeWatermark }) {
  return {
    providerId: row.providerId,
    projectId: row.projectId,
    externalBillingSource: row.externalBillingSource,
    externalBillingId: row.externalBillingId,
    name: row.name,
    description: row.description,
    costUsd: row.costUsd,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.intervalCount,
    anchorDay: row.anchorDay,
    startDate: row.startDate,
    currentPeriodStart: row.currentPeriodStart,
    nextRenewalAt: row.nextRenewalAt,
    ...(includeWatermark
      ? { lastChargedPeriodStart: row.lastChargedPeriodStart }
      : {}),
    autoRenew: row.autoRenew,
    status: row.status,
    canceledAt: row.canceledAt,
    notes: row.notes,
    knobEnv: row.knobEnv,
  };
}

function subscriptionMatches(row, expected, { managed }) {
  const expectedComparable = comparableSubscription(expected, {
    includeWatermark: managed,
  });
  const actualComparable = comparableSubscription(row, {
    includeWatermark: managed,
  });
  return sameJson(actualComparable, expectedComparable);
}

function reportFromPreflight(preflight) {
  return {
    planId: PROVIDER_SUBSCRIPTION_PLAN_ID,
    planHash: PROVIDER_SUBSCRIPTION_PLAN_HASH,
    effectiveAt: PROVIDER_SUBSCRIPTION_EFFECTIVE_AT,
    status: preflight.status,
    operations: {
      providersToCreate: preflight.providersToCreate.map((item) => item.name),
      providerPlansToCreate: preflight.plansToCreate.map(
        (item) => item.providerName
      ),
      providerPlansToUpdate: preflight.plansToUpdate.map(
        (item) => item.providerName
      ),
      subscriptionsToCreate: preflight.subscriptionsToCreate.map(
        (item) => `${item.providerName}:${item.name}`
      ),
    },
    preserved: {
      manualSubscriptions: preflight.preservedManualSubscriptions.map(
        (item) => `${item.providerName}:${item.name}`
      ),
      manualKnobMaps: preflight.preservedManualKnobMaps.map(
        (item) => item.providerName
      ),
    },
    expected: {
      activeMonthlyUsd: 51,
      consideringMonthlyUsd: 89,
      subscriptions: PROVIDER_SUBSCRIPTION_PLAN.subscriptions.length,
      freeTierKnobMaps: PROVIDER_SUBSCRIPTION_PLAN.freeTierKnobMaps.length,
    },
  };
}

async function buildPreflight(client) {
  const completed = await client.releaseMaintenanceRun.findUnique({
    where: { planId: PROVIDER_SUBSCRIPTION_PLAN_ID },
  });
  if (completed) {
    if (completed.planHash !== PROVIDER_SUBSCRIPTION_PLAN_HASH) {
      throw new ReleasePlanConflictError(
        `release receipt hash mismatch for ${PROVIDER_SUBSCRIPTION_PLAN_ID}`
      );
    }
    return {
      status: "already_completed",
      completed,
      providersToCreate: [],
      plansToCreate: [],
      plansToUpdate: [],
      satisfiedProviderPlans: [],
      subscriptionsToCreate: [],
      satisfiedManagedSubscriptions: [],
      preservedManualSubscriptions: [],
      preservedManualKnobMaps: [],
      providerIdByName: new Map(),
      fingerprint: null,
    };
  }

  const [providers, plans, subscriptions] = await Promise.all([
    client.provider.findMany(),
    client.providerPlan.findMany(),
    client.subscription.findMany(),
  ]);
  const conflicts = [];
  const providerIdByName = new Map();
  const providersToCreate = [];

  const alphaNearMisses = providers.filter((item) => {
    const name = normalizedName(item.name);
    return name !== "alphavantage" && name.replace(/[-_]/g, "") === "alphavantage";
  });
  if (alphaNearMisses.length > 0) {
    conflicts.push(
      `alphavantage has ${alphaNearMisses.length} hyphen/underscore near-miss provider row(s)`
    );
  }

  for (const spec of PROVIDER_SUBSCRIPTION_PLAN.providers) {
    const matches = providers.filter(
      (item) => normalizedName(item.name) === spec.name
    );
    if (matches.length > 1) {
      conflicts.push(
        `${spec.name} has ${matches.length} case-insensitive provider rows`
      );
      continue;
    }
    if (matches.length === 1) {
      providerIdByName.set(spec.name, matches[0].id);
      continue;
    }
    const idCollision = providers.find((item) => item.id === spec.id);
    if (idCollision) {
      conflicts.push(`${spec.name} deterministic provider id is already in use`);
      continue;
    }
    providersToCreate.push(spec);
    providerIdByName.set(spec.name, spec.id);
  }

  const plansToCreate = [];
  const plansToUpdate = [];
  const satisfiedProviderPlans = [];
  const preservedManualKnobMaps = [];
  for (const spec of PROVIDER_SUBSCRIPTION_PLAN.freeTierKnobMaps) {
    const providerId = providerIdByName.get(spec.providerName);
    if (!providerId) continue;
    const matchingPlans = plans.filter((item) => item.providerId === providerId);
    if (matchingPlans.length > 1) {
      conflicts.push(`${spec.providerName} has multiple ProviderPlan rows`);
      continue;
    }
    const current = matchingPlans[0];
    if (!current) {
      const idCollision = plans.find((item) => item.id === spec.id);
      if (idCollision) {
        conflicts.push(
          `${spec.providerName} deterministic ProviderPlan id is already in use`
        );
      } else {
        plansToCreate.push({ ...spec, providerId });
      }
    } else if (current.knobEnv == null) {
      plansToUpdate.push({
        id: current.id,
        providerId,
        providerName: spec.providerName,
        knobEnv: spec.knobEnv,
      });
    } else if (!sameJson(current.knobEnv, spec.knobEnv)) {
      preservedManualKnobMaps.push({
        id: current.id,
        providerId,
        providerName: spec.providerName,
        fingerprint: rowFingerprint(current),
      });
    } else {
      satisfiedProviderPlans.push({
        id: current.id,
        providerId,
        providerName: spec.providerName,
        knobEnv: spec.knobEnv,
      });
    }
  }

  const subscriptionsToCreate = [];
  const satisfiedManagedSubscriptions = [];
  const preservedManualSubscriptions = [];
  for (const spec of PROVIDER_SUBSCRIPTION_PLAN.subscriptions) {
    const providerId = providerIdByName.get(spec.providerName);
    if (!providerId) continue;
    const expected = expectedSubscription(providerId, spec);
    const matches = subscriptions.filter(
      (item) =>
        item.providerId === providerId &&
        normalizedName(item.name) === normalizedName(spec.name)
    );
    if (matches.length > 1) {
      conflicts.push(
        `${spec.providerName}:${spec.name} has ${matches.length} subscription rows`
      );
      continue;
    }
    if (matches.length === 0) {
      const idCollision = subscriptions.find((item) => item.id === spec.id);
      if (idCollision) {
        conflicts.push(
          `${spec.providerName}:${spec.name} deterministic subscription id is already in use`
        );
      } else {
        subscriptionsToCreate.push({
          ...expected,
          providerName: spec.providerName,
        });
      }
      continue;
    }

    const current = matches[0];
    const managed = current.id === spec.id;
    if (!subscriptionMatches(current, expected, { managed })) {
      conflicts.push(
        `${spec.providerName}:${spec.name} conflicts with an existing ${
          managed ? "managed" : "manual"
        } subscription row`
      );
      continue;
    }
    if (!managed) {
      preservedManualSubscriptions.push({
        id: current.id,
        providerId,
        providerName: spec.providerName,
        name: spec.name,
        fingerprint: rowFingerprint(current),
      });
    } else {
      satisfiedManagedSubscriptions.push({
        ...expected,
        providerName: spec.providerName,
      });
    }
  }

  if (conflicts.length > 0) {
    throw new ReleasePlanConflictError(
      `release plan preflight found ${conflicts.length} conflict(s)`,
      conflicts
    );
  }

  const state = {
    status: "pending",
    completed: null,
    providerIdByName,
    providersToCreate,
    plansToCreate,
    plansToUpdate,
    satisfiedProviderPlans,
    subscriptionsToCreate,
    satisfiedManagedSubscriptions,
    preservedManualSubscriptions,
    preservedManualKnobMaps,
  };
  state.fingerprint = digest({
    planHash: PROVIDER_SUBSCRIPTION_PLAN_HASH,
    providersToCreate,
    plansToCreate,
    plansToUpdate,
    satisfiedProviderPlans,
    subscriptionsToCreate,
    satisfiedManagedSubscriptions,
    preservedManualSubscriptions,
    preservedManualKnobMaps,
  });
  return state;
}

async function verifyPostconditions(client, preflight) {
  const providerRows = await client.provider.findMany({
    select: { id: true, name: true },
  });
  for (const spec of PROVIDER_SUBSCRIPTION_PLAN.providers) {
    const id = preflight.providerIdByName.get(spec.name);
    const matches = providerRows.filter(
      (item) => normalizedName(item.name) === spec.name
    );
    if (matches.length !== 1 || matches[0].id !== id) {
      throw new Error(`postcondition failed for provider ${spec.name}`);
    }
  }

  for (const item of preflight.plansToCreate) {
    const row = await client.providerPlan.findUnique({ where: { id: item.id } });
    if (!row || row.providerId !== item.providerId || !sameJson(row.knobEnv, item.knobEnv)) {
      throw new Error(`postcondition failed for ProviderPlan ${item.providerName}`);
    }
  }
  for (const item of preflight.plansToUpdate) {
    const row = await client.providerPlan.findUnique({ where: { id: item.id } });
    if (!row || row.providerId !== item.providerId || !sameJson(row.knobEnv, item.knobEnv)) {
      throw new Error(`postcondition failed for ProviderPlan ${item.providerName}`);
    }
  }
  for (const item of preflight.satisfiedProviderPlans) {
    const row = await client.providerPlan.findUnique({ where: { id: item.id } });
    if (!row || row.providerId !== item.providerId || !sameJson(row.knobEnv, item.knobEnv)) {
      throw new Error(`postcondition failed for ProviderPlan ${item.providerName}`);
    }
  }
  for (const item of preflight.preservedManualKnobMaps) {
    const row = await client.providerPlan.findUnique({ where: { id: item.id } });
    if (!row || rowFingerprint(row) !== item.fingerprint) {
      throw new Error(
        `postcondition failed while preserving ${item.providerName} manual knob map`
      );
    }
  }

  for (const item of preflight.subscriptionsToCreate) {
    const row = await client.subscription.findUnique({ where: { id: item.id } });
    if (!row || !subscriptionMatches(row, item, { managed: true })) {
      throw new Error(
        `postcondition failed for ${item.providerName}:${item.name}`
      );
    }
  }
  for (const item of preflight.satisfiedManagedSubscriptions) {
    const row = await client.subscription.findUnique({ where: { id: item.id } });
    if (!row || !subscriptionMatches(row, item, { managed: true })) {
      throw new Error(
        `postcondition failed for ${item.providerName}:${item.name}`
      );
    }
  }
  for (const item of preflight.preservedManualSubscriptions) {
    const row = await client.subscription.findUnique({ where: { id: item.id } });
    if (!row || rowFingerprint(row) !== item.fingerprint) {
      throw new Error(
        `postcondition failed while preserving ${item.providerName}:${item.name}`
      );
    }
  }

  return {
    providersResolved: PROVIDER_SUBSCRIPTION_PLAN.providers.length,
    subscriptionsSatisfied: PROVIDER_SUBSCRIPTION_PLAN.subscriptions.length,
    freeTierKnobMapsSatisfied:
      PROVIDER_SUBSCRIPTION_PLAN.freeTierKnobMaps.length,
  };
}

async function verifySqliteIntegrity(client) {
  const rows = await client.$queryRawUnsafe("PRAGMA integrity_check");
  const values = Array.isArray(rows)
    ? rows.flatMap((row) => Object.values(row ?? {}))
    : [];
  if (values.length !== 1 || values[0] !== "ok") {
    throw new Error(
      `SQLite integrity_check failed after release-plan writes: ${JSON.stringify(
        rows
      )}`
    );
  }
  return "ok";
}

function createReceipt(preflight, postconditions) {
  return {
    receiptVersion: 1,
    planId: PROVIDER_SUBSCRIPTION_PLAN_ID,
    planHash: PROVIDER_SUBSCRIPTION_PLAN_HASH,
    effectiveAt: PROVIDER_SUBSCRIPTION_EFFECTIVE_AT,
    operations: {
      providerIdsCreated: preflight.providersToCreate.map((item) => item.id),
      providerPlanIdsCreated: preflight.plansToCreate.map((item) => item.id),
      providerPlanIdsUpdated: preflight.plansToUpdate.map((item) => item.id),
      subscriptionIdsCreated: preflight.subscriptionsToCreate.map(
        (item) => item.id
      ),
    },
    preserved: {
      manualSubscriptionIds: preflight.preservedManualSubscriptions.map(
        (item) => item.id
      ),
      manualProviderPlanIds: preflight.preservedManualKnobMaps.map(
        (item) => item.id
      ),
    },
    postconditions,
  };
}

export async function preflightProviderSubscriptionReleasePlan(client) {
  const preflight = await buildPreflight(client);
  return { preflight, report: reportFromPreflight(preflight) };
}

export async function runProviderSubscriptionReleasePlan({
  prisma,
  apply = false,
  testFailpoint = null,
}) {
  const initial = await buildPreflight(prisma);
  if (!apply || initial.status === "already_completed") {
    return {
      applied: false,
      alreadyCompleted: initial.status === "already_completed",
      report: reportFromPreflight(initial),
      receipt: initial.completed?.receipt ?? null,
    };
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const current = await buildPreflight(tx);
      if (current.status === "already_completed") {
        return {
          applied: false,
          alreadyCompleted: true,
          report: reportFromPreflight(current),
          receipt: current.completed.receipt,
        };
      }
      if (current.fingerprint !== initial.fingerprint) {
        throw new ReleasePlanConflictError(
          "release plan database state changed after preflight"
        );
      }

      for (const item of current.providersToCreate) {
        await tx.provider.create({
          data: {
            id: item.id,
            name: item.name,
            displayName: item.displayName,
            type: "builtin",
            category: item.category,
            refreshIntervalMin: 60,
          },
        });
      }
      for (const item of current.plansToCreate) {
        await tx.providerPlan.create({
          data: {
            id: item.id,
            providerId: item.providerId,
            knobEnv: item.knobEnv,
          },
        });
      }
      for (const item of current.plansToUpdate) {
        await tx.providerPlan.update({
          where: { id: item.id },
          data: { knobEnv: item.knobEnv },
        });
      }
      for (const { providerName: _providerName, ...item } of current.subscriptionsToCreate) {
        await tx.subscription.create({ data: item });
      }

      if (testFailpoint === "after_writes") {
        throw new Error("test failpoint after writes");
      }

      const postconditions = {
        ...(await verifyPostconditions(tx, current)),
        // Run against the same transaction before the receipt write so a
        // failed database-level check rolls back every business-data change.
        sqliteIntegrity: await verifySqliteIntegrity(tx),
      };
      if (testFailpoint === "after_postconditions") {
        throw new Error("test failpoint after postconditions");
      }
      const receipt = createReceipt(current, postconditions);

      // Receipt is deliberately the last write. Any earlier write or
      // postcondition failure rolls back the whole SQLite transaction.
      await tx.releaseMaintenanceRun.create({
        data: {
          planId: PROVIDER_SUBSCRIPTION_PLAN_ID,
          planHash: PROVIDER_SUBSCRIPTION_PLAN_HASH,
          receipt,
        },
      });

      return {
        applied: true,
        alreadyCompleted: false,
        report: reportFromPreflight(current),
        receipt,
      };
    },
    { timeout: 30_000 }
  );

  return result;
}
