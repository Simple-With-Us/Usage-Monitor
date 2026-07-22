import { NextResponse } from "next/server";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";

/** Accept NextRequest in prod and plain Request in unit tests. */
function sessionRequest(request: Request): {
  cookies: { get: (name: string) => { value: string } | undefined };
} {
  const candidate = request as Request & {
    cookies?: { get: (name: string) => { value: string } | undefined };
  };
  if (candidate.cookies?.get) {
    return { cookies: candidate.cookies };
  }
  return { cookies: { get: () => undefined } };
}
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseSubscriptionUpdateInput } from "@/lib/subscription-input";
import {
  canLinkSubscriptionToExternalBilling,
  externalBillingFreshnessWindowMs,
  isExternalBillingLinkCandidate,
  resolveExternalBillingPeriod,
} from "@/lib/external-billing-link";
import {
  advancePeriod,
  effectiveSubscriptionStatus,
  initialCycle,
  rescheduleCycle,
  isSubscriptionInterval,
  type SubscriptionInterval,
} from "@/lib/subscriptions";
import { findExternalAdoptionGuardKeyForCharge } from "@/lib/external-billing-subscription-adoption";

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(sessionRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let update;
  try {
    update = parseSubscriptionUpdateInput(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const existing = await prisma.subscription.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  if (update.projectId) {
    const project = await prisma.project.findUnique({ where: { id: update.projectId } });
    if (!project) {
      return NextResponse.json({ error: "projectId does not match a known project" }, { status: 400 });
    }
  }
  if (update.providerId !== undefined) {
    const provider = await prisma.provider.findUnique({ where: { id: update.providerId } });
    if (!provider) {
      return NextResponse.json(
        { error: "providerId does not match a known provider" },
        { status: 400 }
      );
    }
  }

  const effectiveProviderId = update.providerId ?? existing.providerId;
  const validationNow = new Date();
  const wasEffectivelyExpired =
    effectiveSubscriptionStatus(existing, validationNow) === "expired";
  const isExpiredRepurchase =
    wasEffectivelyExpired &&
    (update.status ?? existing.status) === "active" &&
    (update.autoRenew ?? existing.autoRenew);
  const isRawActivating =
    update.status === "active" && existing.status !== "active";
  const isActivating = isRawActivating || isExpiredRepurchase;
  const isResume = isActivating && update.activationMode === "resume";
  const isRepurchase = isActivating && update.activationMode !== "resume";
  const externalBillingLinkSupplied =
    update.externalBillingSource !== undefined ||
    update.externalBillingId !== undefined;
  const providerChanged =
    update.providerId !== undefined && update.providerId !== existing.providerId;
  const clearLinkForProviderMove = providerChanged && !externalBillingLinkSupplied;
  const effectiveExternalSource = clearLinkForProviderMove
    ? null
    : update.externalBillingSource !== undefined
      ? update.externalBillingSource
      : existing.externalBillingSource;
  const effectiveExternalId = clearLinkForProviderMove
    ? null
    : update.externalBillingId !== undefined
      ? update.externalBillingId
      : existing.externalBillingId;
  const externalBillingLinkChanged =
    (update.externalBillingSource !== undefined &&
      update.externalBillingSource !== existing.externalBillingSource) ||
    (update.externalBillingId !== undefined &&
      update.externalBillingId !== existing.externalBillingId);
  const linkedScheduleChanged =
    (update.interval !== undefined && update.interval !== existing.interval) ||
    (update.intervalCount !== undefined &&
      update.intervalCount !== existing.intervalCount) ||
    (update.anchorDay !== undefined &&
      update.anchorDay !== existing.anchorDay) ||
    (update.startDate !== undefined &&
      !sameCalendarDay(update.startDate, existing.startDate));
  if (
    effectiveExternalSource &&
    effectiveExternalId &&
    linkedScheduleChanged &&
    !externalBillingLinkChanged &&
    !providerChanged &&
    !isRepurchase
  ) {
    return NextResponse.json(
      {
        error:
          "Unlink the provider billing record before changing billing dates or cadence",
      },
      { status: 400 }
    );
  }
  if (
    isResume &&
    (!["paused", "canceled"].includes(existing.status) ||
      !existing.lastChargedPeriodStart)
  ) {
    return NextResponse.json(
      {
        error:
          "Only a previously charged paused or canceled subscription can resume its paid-through term",
      },
      { status: 400 }
    );
  }
  if (
    effectiveExternalSource &&
    effectiveExternalId &&
    (externalBillingLinkChanged || providerChanged) &&
    isActivating &&
    update.activationMode === "resume"
  ) {
    return NextResponse.json(
      { error: "Resume cannot also change the provider billing identity" },
      { status: 400 }
    );
  }
  const linkCompatibilityChanged =
    externalBillingLinkChanged ||
    providerChanged ||
    (update.costUsd !== undefined && update.costUsd !== existing.costUsd) ||
    (update.currency !== undefined && update.currency !== existing.currency) ||
    (update.interval !== undefined && update.interval !== existing.interval) ||
    (update.intervalCount !== undefined &&
      update.intervalCount !== existing.intervalCount) ||
    (update.status !== undefined && update.status !== existing.status) ||
    (update.autoRenew !== undefined && update.autoRenew !== existing.autoRenew) ||
    isExpiredRepurchase;
  let linkedCycleOverride: {
    startDate: Date;
    currentPeriodStart: Date;
    nextRenewalAt: Date;
  } | null = null;
  if (
    effectiveExternalSource &&
    effectiveExternalId &&
    linkCompatibilityChanged
  ) {
    const externalBilling = await prisma.providerExternalBilling.findUnique({
      where: {
        providerId_source_externalId: {
          providerId: effectiveProviderId,
          source: effectiveExternalSource,
          externalId: effectiveExternalId,
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
        provider: { select: { refreshIntervalMin: true } },
      },
    });
    if (!externalBilling) {
      return NextResponse.json(
        { error: "External billing link does not match this provider" },
        { status: 400 }
      );
    }
    const candidateSubscription = {
      costUsd: update.costUsd ?? existing.costUsd,
      currency: update.currency ?? existing.currency,
      interval: update.interval ?? existing.interval,
      intervalCount: update.intervalCount ?? existing.intervalCount,
      status: update.status ?? existing.status,
    };
    const effectiveLinkSubscription = {
      ...candidateSubscription,
      status: isActivating
        ? "active"
        : effectiveSubscriptionStatus({
            status: candidateSubscription.status,
            autoRenew: update.autoRenew ?? existing.autoRenew,
            nextRenewalAt: existing.nextRenewalAt,
          }),
    };
    if (
      !isExternalBillingLinkCandidate(externalBilling, {
        now: validationNow,
        staleAfterMs: externalBillingFreshnessWindowMs(
          externalBilling.provider.refreshIntervalMin
        ),
      }) ||
      !canLinkSubscriptionToExternalBilling(
        effectiveLinkSubscription,
        externalBilling
      )
    ) {
      return NextResponse.json(
        {
          error:
            "External billing link must be fresh, current, live, canonical, USD, and match the subscription amount and cadence",
        },
        { status: 400 }
      );
    }
    if (
      externalBillingLinkChanged ||
      providerChanged ||
      isRepurchase ||
      isResume
    ) {
      const linkedPeriod = resolveExternalBillingPeriod(externalBilling)!;
      if (
        !isRepurchase &&
        !isResume &&
        existing.lastChargedPeriodStart &&
        (existing.lastChargedPeriodStart.getTime() !==
          linkedPeriod.start.getTime() ||
          existing.nextRenewalAt.getTime() !== linkedPeriod.end.getTime())
      ) {
        return NextResponse.json(
          {
            error:
              "This subscription has charged history from a different billing period; create a new linked term instead",
          },
          { status: 400 }
        );
      }
      linkedCycleOverride = {
        startDate: linkedPeriod.start,
        currentPeriodStart: linkedPeriod.start,
        nextRenewalAt: linkedPeriod.end,
      };
    }
    const existingLink = await prisma.subscription.findFirst({
      where: {
        providerId: effectiveProviderId,
        externalBillingSource: effectiveExternalSource,
        externalBillingId: effectiveExternalId,
        NOT: { id },
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

  const data: Prisma.SubscriptionUpdateInput = {};
  // Any owner edit converts an auto-managed row into an owner-managed row.
  // Maintenance must never overwrite explicit dashboard decisions.
  data.externalBillingManaged = false;
  const guardProvider = await prisma.provider.findUnique({
    where: { id: effectiveProviderId },
    select: { refreshIntervalMin: true },
  });
  if (!guardProvider) {
    return NextResponse.json(
      { error: "providerId does not match a known provider" },
      { status: 400 }
    );
  }
  if (update.providerId !== undefined) {
    data.provider = { connect: { id: update.providerId } };
    if (!externalBillingLinkSupplied && update.providerId !== existing.providerId) {
      data.externalBillingSource = null;
      data.externalBillingId = null;
    }
  }
  if (externalBillingLinkSupplied) {
    data.externalBillingSource = update.externalBillingSource;
    data.externalBillingId = update.externalBillingId;
  }
  if (update.name !== undefined) data.name = update.name;
  if (update.description !== undefined) data.description = update.description;
  if (update.costUsd !== undefined) data.costUsd = update.costUsd;
  if (update.currency !== undefined) data.currency = update.currency;
  if (update.autoRenew !== undefined) data.autoRenew = update.autoRenew;
  if (update.notes !== undefined) data.notes = update.notes;
  if (update.projectId !== undefined) {
    data.project = update.projectId
      ? { connect: { id: update.projectId } }
      : { disconnect: true };
  }
  if (update.status !== undefined) {
    data.status = update.status;
    // Stamp/clear the cancellation time so the UI and any future reporting can
    // tell when a subscription stopped generating charges.
    data.canceledAt = update.status === "canceled" ? new Date() : null;
  }
  if (update.knobEnv !== undefined) {
    data.knobEnv = update.knobEnv === null ? Prisma.JsonNull : (update.knobEnv as Prisma.InputJsonObject);
  }

  // Recompute the cycle only when the schedule ACTUALLY changes (by value — not
  // mere field presence, since the UI re-sends every field on any edit). When it
  // does, advance the cycle FORWARD to the period containing now and mark that
  // period already-settled, so charging resumes at the next period under the new
  // cadence. Critically this never regresses currentPeriodStart or nulls the
  // watermark into already-charged history — which would re-emit every past
  // period's charge with fresh idempotency keys and double-count spend.
  const interval: SubscriptionInterval = update.interval
    ? update.interval
    : isSubscriptionInterval(existing.interval)
      ? existing.interval
      : "monthly";
  const intervalCount = update.intervalCount ?? existing.intervalCount;
  const anchorDay = update.anchorDay !== undefined ? update.anchorDay : existing.anchorDay;
  const startDate = update.startDate ?? existing.startDate;

  const scheduleChanged =
    interval !== existing.interval ||
    intervalCount !== existing.intervalCount ||
    anchorDay !== existing.anchorDay ||
    !sameCalendarDay(startDate, existing.startDate);

  // Activation (status transitioning INTO "active" from considering/paused/
  // canceled) resets the billing cycle to the activation moment instead of
  // reusing whatever schedule the row happened to carry. Without this, a
  // `considering` row created months ago keeps its original
  // currentPeriodStart, and materializeDueSubscriptions (which walks forward
  // charging every elapsed period since currentPeriodStart) backfills a
  // charge for every period since the row was CREATED — including time
  // before the plan was actually purchased. Re-anchoring to now (or an
  // explicit startDate/purchase-date the caller supplies in the same PUT)
  // and clearing the watermark means the very next materializer run charges
  // only the current, post-activation period — never before. This
  // intentionally discards any prior lastChargedPeriodStart: activation
  // starts a fresh cycle, not a continuation of never-billed history. A row
  // that was already "active" is untouched (isActivating is false).
  if (linkedCycleOverride) {
    data.interval = interval;
    data.intervalCount = intervalCount;
    data.anchorDay = null;
    data.startDate = linkedCycleOverride.startDate;
    data.currentPeriodStart = linkedCycleOverride.currentPeriodStart;
    data.nextRenewalAt = linkedCycleOverride.nextRenewalAt;
    // A repurchase is a new charge. Merely linking an already-materialized
    // row marks the provider's current period as accounted so editing cannot
    // create a second overlapping charge.
    data.lastChargedPeriodStart = isRepurchase
      ? null
      : isResume
        ? linkedCycleOverride.currentPeriodStart
        : existing.lastChargedPeriodStart;
  } else if (isActivating) {
    if (update.activationMode === "resume") {
      if (
        !["paused", "canceled"].includes(existing.status) ||
        !existing.lastChargedPeriodStart
      ) {
        return NextResponse.json(
          { error: "Only a previously charged paused or canceled subscription can resume its paid-through term" },
          { status: 400 }
        );
      }
      if (scheduleChanged) {
        return NextResponse.json(
          { error: "Resume keeps the existing schedule; choose repurchase to change billing dates" },
          { status: 400 }
        );
      }
      const now = new Date();
      let currentPeriodStart = existing.currentPeriodStart;
      let nextRenewalAt = existing.nextRenewalAt;
      let guard = 0;
      while (nextRenewalAt <= now && guard < 1_000) {
        currentPeriodStart = nextRenewalAt;
        nextRenewalAt = advancePeriod(
          currentPeriodStart,
          interval,
          intervalCount
        );
        guard += 1;
      }
      // The resumed term is treated as already paid; no immediate synthetic
      // repurchase is emitted. Charging resumes at the next renewal.
      data.currentPeriodStart = currentPeriodStart;
      data.nextRenewalAt = nextRenewalAt;
      data.lastChargedPeriodStart = currentPeriodStart;
    } else {
      const activationStartDate = isExpiredRepurchase &&
        (!update.startDate || sameCalendarDay(update.startDate, existing.startDate))
        ? validationNow
        : update.startDate ?? validationNow;
      const cycle = initialCycle({ startDate: activationStartDate, interval, intervalCount, anchorDay });
      data.interval = interval;
      data.intervalCount = intervalCount;
      data.anchorDay = anchorDay;
      data.startDate = activationStartDate;
      data.currentPeriodStart = cycle.currentPeriodStart;
      data.nextRenewalAt = cycle.nextRenewalAt;
      data.lastChargedPeriodStart = null;
    }
  } else if (scheduleChanged) {
    // paidThrough = end of the last already-charged period under the OLD
    // schedule. Flooring the new cycle at this instant is what prevents a
    // re-anchored period from overlapping billed time.
    const existingInterval = isSubscriptionInterval(existing.interval) ? existing.interval : "monthly";
    const paidThrough = existing.lastChargedPeriodStart
      ? advancePeriod(existing.lastChargedPeriodStart, existingInterval, existing.intervalCount)
      : null;
    const cycle = rescheduleCycle({ startDate, interval, intervalCount, anchorDay, paidThrough });
    data.interval = interval;
    data.intervalCount = intervalCount;
    data.anchorDay = anchorDay;
    data.startDate = startDate;
    data.currentPeriodStart = cycle.currentPeriodStart;
    data.nextRenewalAt = cycle.nextRenewalAt;
    // Safe to clear: currentPeriodStart is floored at paidThrough, so no period
    // starting before billed time can ever be emitted.
    data.lastChargedPeriodStart = null;
  }

  try {
    const subscription = await prisma.$transaction(async (tx) => {
      // Lock before the final identity reread and row update. A concurrent
      // adapter refresh can only land before or after this transaction, never
      // between guard authorization and persistence.
      await tx.$executeRaw`
        UPDATE "Subscription"
        SET "costUsd" = "costUsd"
        WHERE "id" = ${id}
      `;
      // A guard is valid only for the final exact linked external identity and
      // provider/cadence/amount shape. Unlinking clears it; price equivalence
      // alone never restores it.
      data.externalAdoptionGuardKey =
        await findExternalAdoptionGuardKeyForCharge(
          {
            providerId: effectiveProviderId,
            refreshIntervalMin: guardProvider.refreshIntervalMin,
            externalBillingSource: effectiveExternalSource,
            externalBillingId: effectiveExternalId,
            costUsd: update.costUsd ?? existing.costUsd,
            currency: update.currency ?? existing.currency,
            interval: update.interval ?? existing.interval,
            intervalCount: update.intervalCount ?? existing.intervalCount,
            now: validationNow,
          },
          tx
        );
      return tx.subscription.update({ where: { id }, data });
    });
    return NextResponse.json(subscription);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: data.externalAdoptionGuardKey
            ? "An equivalent authoritative external charge is already represented by another subscription"
            : "External billing record is already linked to another subscription",
        },
        { status: 409 }
      );
    }
    console.error("Failed to update subscription:", error);
    return NextResponse.json({ error: "Failed to update subscription" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(sessionRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await prisma.subscription.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete subscription:", error);
    return NextResponse.json({ error: "Failed to delete subscription" }, { status: 500 });
  }
}
