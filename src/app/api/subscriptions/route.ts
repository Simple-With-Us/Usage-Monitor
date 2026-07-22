import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";
import { isUsageReadAuthorized } from "@/lib/ingest-auth";
import { parseSubscriptionCreateInput } from "@/lib/subscription-input";
import {
  canLinkSubscriptionToExternalBilling,
  externalBillingFreshnessWindowMs,
  isExternalBillingLinkCandidate,
  resolveExternalBillingPeriod,
} from "@/lib/external-billing-link";
import {
  findExternalAdoptionGuardKeyForCharge,
} from "@/lib/external-billing-subscription-adoption";
import {
  normalizeMonthlyUsd,
  effectiveSubscriptionStatus,
  isSubscriptionInterval,
  type SubscriptionInterval,
} from "@/lib/subscriptions";

// GET /api/subscriptions — list every subscription with provider/project labels
// and a monthly-equivalent cost (so mixed cadences are comparable).
//
// This is the ONE collection route the dashboard-session middleware excludes
// (see src/middleware.ts's `api/subscriptions/?$` — collection path only, the
// [id] sub-route stays session-gated there), so GET self-authenticates here:
// the dashboard session cookie OR a bearer/x-usage-ingest-token
// (USAGE_READ_TOKEN falling back to USAGE_INGEST_TOKEN, same as
// GET /api/budget-status) so a headless sibling app can read the
// subscription/knobEnv list without a browser session.
export async function GET(request: NextRequest) {
  if (!hasValidDashboardSession(request) && !isUsageReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const subscriptions = await prisma.subscription.findMany({
      orderBy: [{ status: "asc" }, { nextRenewalAt: "asc" }],
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            displayName: true,
            plan: { select: { knobEnv: true } },
          },
        },
        project: { select: { id: true, name: true } },
      },
    });

    const result = subscriptions.map((sub) => {
      const interval: SubscriptionInterval = isSubscriptionInterval(sub.interval)
        ? sub.interval
        : "monthly";
      const freeTierKnobEnv = (sub.provider.plan?.knobEnv as Record<string, string> | null) ?? null;
      // A subscription's own knobEnv overrides the provider's free-tier
      // baseline ONLY while the subscription is active|considering — a
      // paused/canceled row's override is stale and must not be reported as
      // effective (it would tell a consumer to apply paid-tier knobs for a
      // plan that isn't currently in force). freeTierKnobEnv below stays the
      // provider baseline unconditionally, regardless of status.
      const effectiveStatus = effectiveSubscriptionStatus(sub);
      const knobOverrideApplies =
        effectiveStatus === "active" || effectiveStatus === "considering";
      const knobEnv = knobOverrideApplies
        ? ((sub.knobEnv as Record<string, string> | null) ?? freeTierKnobEnv)
        : freeTierKnobEnv;
      return {
        id: sub.id,
        name: sub.name,
        description: sub.description,
        costUsd: sub.costUsd,
        currency: sub.currency,
        interval: sub.interval,
        intervalCount: sub.intervalCount,
        monthlyEquivalentUsd: normalizeMonthlyUsd(sub.costUsd, interval, sub.intervalCount),
        anchorDay: sub.anchorDay,
        startDate: sub.startDate.toISOString(),
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        nextRenewalAt: sub.nextRenewalAt.toISOString(),
        autoRenew: sub.autoRenew,
        status: sub.status,
        effectiveStatus,
        notes: sub.notes,
        externalBillingSource: sub.externalBillingSource,
        externalBillingId: sub.externalBillingId,
        // Effective knobEnv: this subscription's own override if set, else the
        // provider's free-tier ProviderPlan.knobEnv. freeTierKnobEnv is always
        // the provider's free-tier map (may be null), regardless of override,
        // so a consumer can diff "what I'd get on the free tier" vs "what this
        // plan actually implies."
        knobEnv,
        freeTierKnobEnv,
        provider: { id: sub.provider.id, name: sub.provider.name, displayName: sub.provider.displayName },
        project: sub.project,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch subscriptions:", error);
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}

// POST /api/subscriptions — dashboard-session-only (deliberately NOT covered
// by the token auth above): the middleware exclusion is collection-path-wide
// (it can't distinguish GET from POST), so this handler enforces the session
// cookie itself now that middleware no longer gates this path.
export async function POST(request: NextRequest) {
  // Always enforce session here: middleware excludes the collection path so
  // GET can accept read tokens, but POST must remain dashboard-session-only
  // (including under vitest — tests assert 401 without a cookie).
  if (!hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input;
  try {
    input = parseSubscriptionCreateInput(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const provider = await prisma.provider.findUnique({
    where: { id: input.providerId },
    include: { plan: { select: { fixedMonthlyCostUsd: true } } },
  });
  if (!provider) {
    return NextResponse.json({ error: "providerId does not match a known provider" }, { status: 400 });
  }
  // Double-count guard: recurring fee is EITHER plan fixed OR a Subscription.
  if (
    provider.plan?.fixedMonthlyCostUsd != null &&
    provider.plan.fixedMonthlyCostUsd > 0
  ) {
    return NextResponse.json(
      {
        error:
          "This provider already has a Plan price / mo (fixedMonthlyCostUsd). Clear that field before adding a Subscription for the same recurring fee, or the two would double-count in spend.",
      },
      { status: 400 }
    );
  }
  if (input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      return NextResponse.json({ error: "projectId does not match a known project" }, { status: 400 });
    }
  }
  const validationNow = new Date();
  let linkedCycle: {
    startDate: Date;
    currentPeriodStart: Date;
    nextRenewalAt: Date;
    anchorDay: null;
  } | null = null;
  let externalAdoptionGuardKey: string | null = null;
  if (input.externalBillingSource && input.externalBillingId) {
    const externalBilling = await prisma.providerExternalBilling.findUnique({
      where: {
        providerId_source_externalId: {
          providerId: input.providerId,
          source: input.externalBillingSource,
          externalId: input.externalBillingId,
        },
      },
      select: {
        externalId: true,
        kind: true,
        status: true,
        amountUsd: true,
        currency: true,
        billingInterval: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        rollupRole: true,
        syncedAt: true,
      },
    });
    if (!externalBilling) {
      return NextResponse.json(
        { error: "External billing link does not match this provider" },
        { status: 400 }
      );
    }
    if (
      !isExternalBillingLinkCandidate(externalBilling, {
        now: validationNow,
        staleAfterMs: externalBillingFreshnessWindowMs(
          provider.refreshIntervalMin
        ),
      }) ||
      !canLinkSubscriptionToExternalBilling(input, externalBilling)
    ) {
      return NextResponse.json(
        {
          error:
            "External billing link must be fresh, current, live, canonical, USD, and match the subscription amount and cadence",
        },
        { status: 400 }
      );
    }
    const linkedPeriod = resolveExternalBillingPeriod(externalBilling)!;
    linkedCycle = {
      startDate: linkedPeriod.start,
      currentPeriodStart: linkedPeriod.start,
      nextRenewalAt: linkedPeriod.end,
      anchorDay: null,
    };
    const existingLink = await prisma.subscription.findFirst({
      where: {
        providerId: input.providerId,
        externalBillingSource: input.externalBillingSource,
        externalBillingId: input.externalBillingId,
      },
      select: { id: true },
    });
    if (existingLink) {
      return NextResponse.json(
        { error: "External billing record is already linked to another subscription" },
        { status: 409 }
      );
    }
  }

  try {
    const subscription = await prisma.$transaction(async (tx) => {
      // Take SQLite's writer lock before the final exact-identity reread so an
      // adapter refresh cannot invalidate guard authority between read/create.
      await tx.$executeRaw`
        UPDATE "Provider"
        SET "name" = "name"
        WHERE "id" = ${input.providerId}
      `;
      externalAdoptionGuardKey = await findExternalAdoptionGuardKeyForCharge(
        {
          providerId: input.providerId,
          refreshIntervalMin: provider.refreshIntervalMin,
          externalBillingSource: input.externalBillingSource,
          externalBillingId: input.externalBillingId,
          costUsd: input.costUsd,
          currency: input.currency,
          interval: input.interval,
          intervalCount: input.intervalCount,
          now: validationNow,
        },
        tx
      );
      return tx.subscription.create({
        data: {
          providerId: input.providerId,
          projectId: input.projectId,
          externalBillingSource: input.externalBillingSource,
          externalBillingId: input.externalBillingId,
          externalAdoptionGuardKey,
          name: input.name,
          description: input.description,
          costUsd: input.costUsd,
          currency: input.currency,
          interval: input.interval,
          intervalCount: input.intervalCount,
          anchorDay: linkedCycle ? linkedCycle.anchorDay : input.anchorDay,
          startDate: linkedCycle?.startDate ?? input.startDate,
          currentPeriodStart:
            linkedCycle?.currentPeriodStart ?? input.currentPeriodStart,
          nextRenewalAt: linkedCycle?.nextRenewalAt ?? input.nextRenewalAt,
          autoRenew: input.autoRenew,
          status: input.status,
          notes: input.notes,
          knobEnv:
            input.knobEnv === null
              ? Prisma.JsonNull
              : (input.knobEnv as Prisma.InputJsonObject),
        },
      });
    });
    return NextResponse.json(subscription, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: externalAdoptionGuardKey
            ? "An equivalent authoritative external charge is already represented by another subscription"
            : "External billing record is already linked to another subscription",
        },
        { status: 409 }
      );
    }
    console.error("Failed to create subscription:", error);
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 });
  }
}
