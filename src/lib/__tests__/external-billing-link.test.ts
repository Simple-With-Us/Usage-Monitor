import { describe, expect, it } from "vitest";
import {
  canLinkSubscriptionToExternalBilling,
  formatExternalBillingAmount,
  hasExactExternalBillingCadencePeriod,
  isExternalBillingLinkCandidate,
  type ExternalBillingLinkCandidateRecord,
} from "@/lib/external-billing-link";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const baseRecord = {
  externalId: "sub-1",
  kind: "subscription",
  status: "active",
  amountUsd: 5,
  currency: "USD",
  billingInterval: "monthly",
  currentPeriodStart: "2026-07-01T00:00:00.000Z",
  currentPeriodEnd: "2026-08-01T00:00:00.000Z",
  syncedAt: "2026-07-12T11:00:00.000Z",
};

function isCandidate(
  record: ExternalBillingLinkCandidateRecord,
  staleAfterMs = DAY_MS
): boolean {
  return isExternalBillingLinkCandidate(record, { now: NOW, staleAfterMs });
}

describe("external billing links", () => {
  it("offers only live canonical USD recurring charges that budget dedupe can match", () => {
    expect(isCandidate(baseRecord)).toBe(true);
    expect(isCandidate({ ...baseRecord, status: "paid" })).toBe(true);
    expect(isCandidate({ ...baseRecord, status: "trialing" })).toBe(false);
    expect(isCandidate({ ...baseRecord, currency: "EUR" })).toBe(false);
    expect(isCandidate({ ...baseRecord, kind: "service_plan" })).toBe(false);
    expect(isCandidate({ ...baseRecord, rollupRole: "metadata" })).toBe(false);
    expect(isCandidate({ ...baseRecord, currentPeriodStart: null })).toBe(false);
    expect(isCandidate({ ...baseRecord, status: "canceled" })).toBe(false);
    expect(isCandidate({ ...baseRecord, status: "disabled" })).toBe(false);
    expect(isCandidate({ ...baseRecord, status: "unavailable" })).toBe(false);
    expect(isCandidate({ ...baseRecord, status: "unknown" })).toBe(false);
    expect(isCandidate({ ...baseRecord, status: null })).toBe(false);
    expect(isCandidate({ ...baseRecord, currency: null })).toBe(false);
    expect(isCandidate({ ...baseRecord, billingInterval: "biweekly" })).toBe(false);
  });

  it("rejects stale syncs and billing periods that no longer cover now", () => {
    expect(isCandidate({
      ...baseRecord,
      syncedAt: "2026-07-11T12:00:00.000Z",
    })).toBe(true);
    expect(isCandidate({
      ...baseRecord,
      syncedAt: "2026-07-11T11:59:59.000Z",
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      syncedAt: "2026-07-12T12:05:00.001Z",
    })).toBe(false);
    expect(isCandidate({ ...baseRecord, syncedAt: "not-a-date" })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodEnd: "2026-07-12T12:00:00.000Z",
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodStart: "2019-01-01T00:00:00.000Z",
      currentPeriodEnd: "2027-01-01T00:00:00.000Z",
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodEnd: "not-a-date",
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodStart: "not-a-date",
    })).toBe(false);
  });

  it("derives the active period end from cadence when the provider omits it", () => {
    expect(isCandidate({
      ...baseRecord,
      currentPeriodEnd: null,
    })).toBe(true);
    expect(isCandidate({
      ...baseRecord,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: null,
    })).toBe(false);
    expect(isCandidate({
      ...baseRecord,
      billingInterval: "annual",
      currentPeriodStart: "2026-01-31T00:00:00.000Z",
      currentPeriodEnd: null,
    })).toBe(true);
  });

  it.each([
    ["weekly", "2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z"],
    ["monthly", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["quarterly", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["annual", "2026-07-01T00:00:00.000Z", "2027-07-01T00:00:00.000Z"],
  ])("requires one exact %s period", (billingInterval, start, end) => {
    expect(
      hasExactExternalBillingCadencePeriod({
        billingInterval,
        currentPeriodStart: start,
        currentPeriodEnd: end,
      })
    ).toBe(true);
    expect(
      hasExactExternalBillingCadencePeriod({
        billingInterval,
        currentPeriodStart: start,
        currentPeriodEnd: new Date(Date.parse(end) - 1).toISOString(),
      })
    ).toBe(false);
  });

  it("accepts UTC month-end cadence clamping without accepting a short month", () => {
    expect(
      hasExactExternalBillingCadencePeriod({
        billingInterval: "monthly",
        currentPeriodStart: "2026-01-31T08:30:00.000Z",
        currentPeriodEnd: "2026-02-28T08:30:00.000Z",
      })
    ).toBe(true);
    expect(
      hasExactExternalBillingCadencePeriod({
        billingInterval: "monthly",
        currentPeriodStart: "2026-01-31T08:30:00.000Z",
        currentPeriodEnd: "2026-02-27T08:30:00.000Z",
      })
    ).toBe(false);
  });

  it("uses one exact compatibility predicate for display and money-path dedupe", () => {
    const subscription = {
      costUsd: 5,
      currency: "USD",
      interval: "monthly",
      intervalCount: 1,
      status: "active",
    };

    expect(canLinkSubscriptionToExternalBilling(subscription, {
      ...baseRecord,
      billingInterval: "month",
    })).toBe(true);
    expect(canLinkSubscriptionToExternalBilling(subscription, {
      ...baseRecord,
      amountUsd: 6,
    })).toBe(false);
    expect(canLinkSubscriptionToExternalBilling(subscription, {
      ...baseRecord,
      rollupRole: "component",
    })).toBe(false);
    expect(canLinkSubscriptionToExternalBilling(subscription, {
      ...baseRecord,
      status: "paused",
    })).toBe(false);
  });

  it("formats native currency without a hard-coded dollar sign", () => {
    expect(formatExternalBillingAmount(12.5, "EUR")).toContain("€");
    expect(formatExternalBillingAmount(12.5, "USD")).toContain("$");
    expect(formatExternalBillingAmount(12.5, null)).toContain("UNKNOWN");
  });
});
