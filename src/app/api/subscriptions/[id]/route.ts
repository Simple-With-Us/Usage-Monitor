import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseSubscriptionUpdateInput } from "@/lib/subscription-input";
import {
  advancePeriod,
  initialCycle,
  rescheduleCycle,
  isSubscriptionInterval,
  type SubscriptionInterval,
} from "@/lib/subscriptions";

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const data: Prisma.SubscriptionUpdateInput = {};
  if (update.providerId !== undefined) {
    data.provider = { connect: { id: update.providerId } };
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
  const isActivating = update.status === "active" && existing.status !== "active";

  if (isActivating) {
    const activationStartDate = update.startDate ?? new Date();
    const cycle = initialCycle({ startDate: activationStartDate, interval, intervalCount, anchorDay });
    data.interval = interval;
    data.intervalCount = intervalCount;
    data.anchorDay = anchorDay;
    data.startDate = activationStartDate;
    data.currentPeriodStart = cycle.currentPeriodStart;
    data.nextRenewalAt = cycle.nextRenewalAt;
    data.lastChargedPeriodStart = null;
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
    const subscription = await prisma.subscription.update({ where: { id }, data });
    return NextResponse.json(subscription);
  } catch (error) {
    console.error("Failed to update subscription:", error);
    return NextResponse.json({ error: "Failed to update subscription" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.subscription.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete subscription:", error);
    return NextResponse.json({ error: "Failed to delete subscription" }, { status: 500 });
  }
}
