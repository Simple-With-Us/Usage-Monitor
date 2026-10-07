import type { FleetBudgetView } from "../view";
export const BUDGET_VIEW: FleetBudgetView = {
  ok: true, generatedAt: "2026-10-06T20:00:00.000Z", enabled: false, admissionEnabled: false,
  snapshot: {
    day: "2026-10-06", timeZone: "America/Chicago", configured: true,
    settledPolicyMicros: "400000", reservedPolicyMicros: "100000", softLimitMicros: "500000", hardLimitMicros: "1500000",
    blocked: false, estimatesAreCash: false,
    providerCosts: [
      { provider: "deepseek", policyWeight: 1, settledCalls: 2, outstandingCalls: 1, outstandingMaximumCostMicros: "100000",
        estimatedCalls: 2, knownEstimatedCostMicros: "400000", providerReportedCalls: 1, knownProviderReportedCostMicros: "150000", providerReportedCostVerified: false },
      { provider: "minimax", policyWeight: 0, settledCalls: 0, outstandingCalls: 1, outstandingMaximumCostMicros: "50000",
        estimatedCalls: 0, knownEstimatedCostMicros: null, providerReportedCalls: 0, knownProviderReportedCostMicros: null, providerReportedCostVerified: false },
    ],
  },
};
