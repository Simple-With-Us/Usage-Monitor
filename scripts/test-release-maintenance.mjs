#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  PROVIDER_SUBSCRIPTION_PLAN,
  PROVIDER_SUBSCRIPTION_PLAN_HASH,
  PROVIDER_SUBSCRIPTION_PLAN_ID,
  ReleasePlanConflictError,
  runProviderSubscriptionReleasePlan,
} from "./provider-subscription-release-plan.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), "usage-release-maintenance-"));
const templateDb = path.join(work, "template.db");

function clientFor(dbPath) {
  return new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}

async function scenario(name, callback) {
  const dbPath = path.join(work, `${name.replace(/[^a-z0-9]+/gi, "-")}.db`);
  copyFileSync(templateDb, dbPath);
  const prisma = clientFor(dbPath);
  try {
    await callback(prisma);
    console.log(`[release-maintenance-test] PASS ${name}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function counts(prisma) {
  const [providers, plans, subscriptions, receipts] = await Promise.all([
    prisma.provider.count(),
    prisma.providerPlan.count(),
    prisma.subscription.count(),
    prisma.releaseMaintenanceRun.count(),
  ]);
  return { providers, plans, subscriptions, receipts };
}

function manualSubscriptionData(providerId, spec, overrides = {}) {
  return {
    id: overrides.id ?? `manual:${spec.providerName}:${spec.name}`,
    providerId,
    projectId: null,
    externalBillingSource: null,
    externalBillingId: null,
    name: spec.name,
    description: null,
    costUsd: spec.costUsd,
    currency: spec.currency,
    interval: spec.interval,
    intervalCount: spec.intervalCount,
    anchorDay: spec.anchorDay,
    startDate: new Date(spec.startDate),
    currentPeriodStart: new Date(spec.currentPeriodStart),
    nextRenewalAt: new Date(spec.nextRenewalAt),
    lastChargedPeriodStart: overrides.lastChargedPeriodStart ?? null,
    autoRenew: spec.autoRenew,
    status: overrides.status ?? spec.status,
    canceledAt: null,
    notes: spec.notes,
    knobEnv: spec.knobEnv,
    ...overrides,
  };
}

try {
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate"],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: `file:${templateDb}` },
      stdio: "pipe",
    }
  );

  assert.equal(
    PROVIDER_SUBSCRIPTION_PLAN_HASH,
    "1faf2328f66698886c2bcc18599e412c7e4525b643f0ab4e8a032d62a1d60cbb"
  );

  await scenario("dry run is write free", async (prisma) => {
    const before = await counts(prisma);
    const result = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: false,
    });
    assert.equal(result.applied, false);
    assert.equal(result.report.status, "pending");
    assert.deepEqual(await counts(prisma), before);
  });

  await scenario("atomic apply receipt and rerun", async (prisma) => {
    const first = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: true,
    });
    assert.equal(first.applied, true);
    assert.deepEqual(await counts(prisma), {
      providers: 6,
      plans: 4,
      subscriptions: 4,
      receipts: 1,
    });
    const rows = await prisma.subscription.findMany({ orderBy: { id: "asc" } });
    assert.equal(rows.filter((row) => row.status === "active").length, 2);
    assert.equal(rows.filter((row) => row.status === "considering").length, 2);
    for (const row of rows) {
      assert.equal(row.startDate.toISOString(), "2026-07-10T00:00:00.000Z");
      assert.equal(
        row.currentPeriodStart.toISOString(),
        "2026-07-10T00:00:00.000Z"
      );
      assert.equal(row.nextRenewalAt.toISOString(), "2026-08-10T00:00:00.000Z");
      assert.equal(row.anchorDay, 10);
    }
    const receiptBefore = await prisma.releaseMaintenanceRun.findUniqueOrThrow({
      where: { planId: PROVIDER_SUBSCRIPTION_PLAN_ID },
    });
    assert.equal(receiptBefore.planHash, PROVIDER_SUBSCRIPTION_PLAN_HASH);
    assert.equal(receiptBefore.receipt.postconditions.sqliteIntegrity, "ok");

    const second = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: true,
    });
    assert.equal(second.applied, false);
    assert.equal(second.alreadyCompleted, true);
    assert.deepEqual(
      await prisma.releaseMaintenanceRun.findUniqueOrThrow({
        where: { planId: PROVIDER_SUBSCRIPTION_PLAN_ID },
      }),
      receiptBefore
    );
    assert.deepEqual(await counts(prisma), {
      providers: 6,
      plans: 4,
      subscriptions: 4,
      receipts: 1,
    });
  });

  await scenario("duplicate provider aborts before writes", async (prisma) => {
    await prisma.provider.createMany({
      data: [
        { id: "massive-a", name: "massive", displayName: "Massive A" },
        { id: "massive-b", name: " MASSIVE ", displayName: "Massive B" },
      ],
    });
    await assert.rejects(
      runProviderSubscriptionReleasePlan({ prisma, apply: true }),
      ReleasePlanConflictError
    );
    assert.deepEqual(await counts(prisma), {
      providers: 2,
      plans: 0,
      subscriptions: 0,
      receipts: 0,
    });
  });

  await scenario("alpha near miss aborts before writes", async (prisma) => {
    await prisma.provider.create({
      data: {
        id: "alpha-near-miss",
        name: "alpha-vantage",
        displayName: "Alpha near miss",
      },
    });
    await assert.rejects(
      runProviderSubscriptionReleasePlan({ prisma, apply: true }),
      ReleasePlanConflictError
    );
    assert.deepEqual(await counts(prisma), {
      providers: 1,
      plans: 0,
      subscriptions: 0,
      receipts: 0,
    });
  });

  await scenario("divergent manual subscription is preserved and aborts", async (prisma) => {
    const provider = await prisma.provider.create({
      data: { id: "manual-massive", name: "massive", displayName: "Massive" },
    });
    const spec = PROVIDER_SUBSCRIPTION_PLAN.subscriptions.find(
      (item) => item.providerName === "massive"
    );
    await prisma.subscription.create({
      data: manualSubscriptionData(provider.id, spec, { status: "paused" }),
    });
    await assert.rejects(
      runProviderSubscriptionReleasePlan({ prisma, apply: true }),
      ReleasePlanConflictError
    );
    const row = await prisma.subscription.findFirstOrThrow();
    assert.equal(row.status, "paused");
    assert.deepEqual(await counts(prisma), {
      providers: 1,
      plans: 0,
      subscriptions: 1,
      receipts: 0,
    });
  });

  await scenario("identical manual subscription is preserved", async (prisma) => {
    const provider = await prisma.provider.create({
      data: { id: "manual-massive", name: "massive", displayName: "Massive" },
    });
    const spec = PROVIDER_SUBSCRIPTION_PLAN.subscriptions.find(
      (item) => item.providerName === "massive"
    );
    const manual = await prisma.subscription.create({
      data: manualSubscriptionData(provider.id, spec),
    });
    const result = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: true,
    });
    assert.equal(result.applied, true);
    assert.equal(await prisma.subscription.count(), 4);
    const stillManual = await prisma.subscription.findUniqueOrThrow({
      where: { id: manual.id },
    });
    assert.equal(stillManual.id, manual.id);
    assert.ok(
      result.receipt.preserved.manualSubscriptionIds.includes(manual.id)
    );
  });

  await scenario("operator knob map wins", async (prisma) => {
    const provider = await prisma.provider.create({
      data: { id: "manual-tiingo", name: "tiingo", displayName: "Tiingo" },
    });
    const plan = await prisma.providerPlan.create({
      data: {
        id: "manual-tiingo-plan",
        providerId: provider.id,
        knobEnv: { OPERATOR_OVERRIDE: "true" },
        notes: "manual",
      },
    });
    const result = await runProviderSubscriptionReleasePlan({
      prisma,
      apply: true,
    });
    const unchanged = await prisma.providerPlan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    assert.deepEqual(unchanged.knobEnv, { OPERATOR_OVERRIDE: "true" });
    assert.equal(unchanged.notes, "manual");
    assert.ok(result.receipt.preserved.manualProviderPlanIds.includes(plan.id));
  });

  for (const failpoint of ["after_writes", "after_postconditions"]) {
    await scenario(`${failpoint} rolls back without receipt`, async (prisma) => {
      await assert.rejects(
        runProviderSubscriptionReleasePlan({
          prisma,
          apply: true,
          testFailpoint: failpoint,
        }),
        /test failpoint/
      );
      assert.deepEqual(await counts(prisma), {
        providers: 0,
        plans: 0,
        subscriptions: 0,
        receipts: 0,
      });
    });
  }

  await scenario("receipt hash mismatch fails closed", async (prisma) => {
    await prisma.releaseMaintenanceRun.create({
      data: {
        planId: PROVIDER_SUBSCRIPTION_PLAN_ID,
        planHash: "0".repeat(64),
        receipt: { invalid: true },
      },
    });
    await assert.rejects(
      runProviderSubscriptionReleasePlan({ prisma, apply: true }),
      /receipt hash mismatch/
    );
    assert.deepEqual(await counts(prisma), {
      providers: 0,
      plans: 0,
      subscriptions: 0,
      receipts: 1,
    });
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("release maintenance checks passed");
