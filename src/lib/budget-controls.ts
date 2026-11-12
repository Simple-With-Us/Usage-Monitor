import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeBudgetStatus } from "@/lib/budget-status";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

// ---------------------------------------------------------------------------
// Budget-breach automated control actions (DESIGN: default-off, reversible,
// audited, hysteresis, fail-safe, recommendation-only key handling).
//
// Today's alerting is NOTIFY-ONLY. This module adds a **guarded advisory layer**
// when a provider breaches its configured monthly budget, plus **owner-driven
// manual** poll pause/resume:
//   1. track sustained breach state + key-disable RECOMMENDATION (advisory only
//      — NEVER disables/rotates credentials),
//   2. optional **manual** pause of polling (owner API only — auto-pause was
//      rejected: this app is a read-only observer, so auto-pausing only blinds
//      the dashboard while real spend continues; see owner review on PR #623),
//   3. durable audit trail via BudgetControlEvent.
//
// SAFETY MODEL
//   - DEFAULT-OFF: gated behind BOTH BUDGET_AUTO_CONTROLS_ENABLED (default false)
//     AND Provider.budgetControlsEnabled (default false). Master off ⇒ zero I/O.
//   - AUTOMATED PATH IS ADVISORY ONLY: sustained breach never auto-pauses poll.
//   - MANUAL PAUSE is owner-initiated, audited, and cleared on period roll /
//     opt-out / explicit resume. Polling skip still requires master+opt-in so
//     BUDGET_AUTO_CONTROLS_ENABLED=false is a global kill-switch.
//   - FAIL-SAFE: applyBudgetControls never throws into the scheduler.
// ---------------------------------------------------------------------------

export type BudgetBreachState = "ok" | "breached" | "paused";

export const BUDGET_BREACH_STATES: readonly BudgetBreachState[] = [
  "ok",
  "breached",
  "paused",
];

export type BudgetControlAction =
  | "pause"
  | "pause_manual"
  | "resume_breach_resolved"
  | "resume_period_roll"
  | "resume_controls_disabled"
  | "resume_manual"
  | "recommend_key_disable"
  | "clear_key_disable_recommendation"
  | "breach_observed"
  | "breach_cleared"
  | "controls_enabled"
  | "controls_disabled";

const DEFAULT_BREACH_TICKS = 3;
const DEFAULT_BREACH_MARGIN_RATIO = 1.0;
const DEFAULT_RESUME_MARGIN_RATIO = 0.9;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export interface BudgetControlConfig {
  masterEnabled: boolean;
  breachTicks: number;
  breachMarginRatio: number;
  resumeMarginRatio: number;
  cooldownMs: number;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Master gate. When false the entire control layer is inert (byte-identical to notify-only). */
export function budgetAutoControlsEnabled(
  env: Partial<NodeJS.ProcessEnv> = process.env
): boolean {
  return parseBooleanFlag(env.BUDGET_AUTO_CONTROLS_ENABLED);
}

export function readBudgetControlConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env
): BudgetControlConfig {
  return {
    masterEnabled: budgetAutoControlsEnabled(env),
    // At least 1 breach observation; a very large N would effectively disable
    // pausing, which is a safe (notify-only) failure mode.
    breachTicks: Math.floor(
      boundedNumber(env.BUDGET_CONTROL_BREACH_TICKS, DEFAULT_BREACH_TICKS, {
        min: 1,
        max: 1000,
      })
    ),
    // Pause threshold multiplier on the monthly budget. 1.0 = pause at/over
    // budget; 1.1 tolerates a 10% overage before pausing.
    breachMarginRatio: boundedNumber(
      env.BUDGET_CONTROL_BREACH_MARGIN_RATIO,
      DEFAULT_BREACH_MARGIN_RATIO,
      { min: 1, max: 100 }
    ),
    // Resume band multiplier on the monthly budget. Must be <= 1 so resume
    // requires spend to fall strictly under the budget line, never equal to the
    // pause threshold (that would flap).
    resumeMarginRatio: boundedNumber(
      env.BUDGET_CONTROL_RESUME_MARGIN_RATIO,
      DEFAULT_RESUME_MARGIN_RATIO,
      { min: 0, max: 1 }
    ),
    cooldownMs: boundedNumber(
      env.BUDGET_CONTROL_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
      { min: 0, max: 30 * 24 * 60 * 60 * 1000 }
    ),
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Pure decision layer. No I/O, no wall clock, no randomness — fully
// deterministic given (state, observation, config, now). This is where the
// hysteresis/anti-flap/reversibility invariants live so they can be unit
// tested in isolation from the database.
// ---------------------------------------------------------------------------

export interface BudgetControlProviderState {
  budgetControlsEnabled: boolean;
  budgetBreachState: BudgetBreachState;
  budgetBreachStreak: number;
  budgetControlPeriodStart: Date | null;
  budgetPausedAt: Date | null;
  budgetPauseReason: string | null;
  budgetPauseThresholdUsd: number | null;
  budgetPauseObservedSpendUsd: number | null;
  budgetControlLastActionAt: Date | null;
  keyDisableRecommended: boolean;
}

export interface BudgetControlObservation {
  monthlyBudgetUsd: number | null;
  spentUsd: number;
}

export interface BudgetControlEventDraft {
  action: BudgetControlAction;
  reason: string;
  breachState: BudgetBreachState;
  thresholdUsd: number | null;
  observedSpendUsd: number | null;
  breachStreak: number | null;
  periodStart: Date;
}

export interface BudgetControlDecision {
  changed: boolean;
  next: BudgetControlProviderState;
  events: BudgetControlEventDraft[];
  paused: boolean;
  resumed: boolean;
  recommendationRaised: boolean;
  recommendationCleared: boolean;
  breachObserved: boolean;
}

function cleanState(
  state: BudgetControlProviderState,
  periodStart: Date
): BudgetControlProviderState {
  return {
    budgetControlsEnabled: state.budgetControlsEnabled,
    budgetBreachState: "ok",
    budgetBreachStreak: 0,
    budgetControlPeriodStart: periodStart,
    budgetPausedAt: null,
    budgetPauseReason: null,
    budgetPauseThresholdUsd: null,
    budgetPauseObservedSpendUsd: null,
    budgetControlLastActionAt: state.budgetControlLastActionAt,
    keyDisableRecommended: false,
  };
}

function hasResidualControlState(state: BudgetControlProviderState): boolean {
  return (
    state.budgetBreachState !== "ok" ||
    state.budgetBreachStreak !== 0 ||
    state.budgetPausedAt !== null ||
    state.keyDisableRecommended
  );
}

function statesEqual(
  a: BudgetControlProviderState,
  b: BudgetControlProviderState
): boolean {
  return (
    a.budgetBreachState === b.budgetBreachState &&
    a.budgetBreachStreak === b.budgetBreachStreak &&
    (a.budgetControlPeriodStart?.getTime() ?? null) ===
      (b.budgetControlPeriodStart?.getTime() ?? null) &&
    (a.budgetPausedAt?.getTime() ?? null) ===
      (b.budgetPausedAt?.getTime() ?? null) &&
    a.budgetPauseReason === b.budgetPauseReason &&
    a.budgetPauseThresholdUsd === b.budgetPauseThresholdUsd &&
    a.budgetPauseObservedSpendUsd === b.budgetPauseObservedSpendUsd &&
    (a.budgetControlLastActionAt?.getTime() ?? null) ===
      (b.budgetControlLastActionAt?.getTime() ?? null) &&
    a.keyDisableRecommended === b.keyDisableRecommended
  );
}

export function decideBudgetControlAction(
  state: BudgetControlProviderState,
  observation: BudgetControlObservation,
  config: BudgetControlConfig,
  now: Date
): BudgetControlDecision {
  const periodStart = monthStartUtc(now);
  const events: BudgetControlEventDraft[] = [];
  const noChange: BudgetControlDecision = {
    changed: false,
    next: state,
    events,
    paused: false,
    resumed: false,
    recommendationRaised: false,
    recommendationCleared: false,
    breachObserved: false,
  };

  // Not under active control (master off is handled by the caller, but a
  // per-provider opt-out while the master flag is on must revert any residual
  // pause/recommendation — the feature turning off for a provider fully
  // resumes it). No opt-in and no residue => nothing to do.
  if (!config.masterEnabled || !state.budgetControlsEnabled) {
    if (!hasResidualControlState(state)) return noChange;
    const next = cleanState(state, periodStart);
    next.budgetControlLastActionAt = now;
    events.push({
      action: "resume_controls_disabled",
      reason: "Budget auto-controls disabled for this provider; pause reverted.",
      breachState: "ok",
      thresholdUsd: null,
      observedSpendUsd: observation.spentUsd,
      breachStreak: 0,
      periodStart,
    });
    return {
      changed: true,
      next,
      events,
      paused: false,
      resumed: state.budgetPausedAt !== null,
      recommendationRaised: false,
      recommendationCleared: state.keyDisableRecommended,
      breachObserved: false,
    };
  }

  const next: BudgetControlProviderState = { ...state };
  let paused = false;
  let resumed = false;
  let recommendationRaised = false;
  let recommendationCleared = false;
  let breachObserved = false;

  // --- Period roll: a new UTC month resets hysteresis and resumes any pause,
  // because a fresh budget period is a legitimately new spend window, not flap.
  const periodRolled =
    state.budgetControlPeriodStart != null &&
    state.budgetControlPeriodStart.getTime() !== periodStart.getTime();
  if (periodRolled) {
    if (next.budgetPausedAt !== null) {
      resumed = true;
      recommendationCleared = next.keyDisableRecommended;
      events.push({
        action: "resume_period_roll",
        reason:
          "Budget period rolled to a new UTC month; pause auto-cleared for the new period.",
        breachState: "ok",
        thresholdUsd: null,
        observedSpendUsd: observation.spentUsd,
        breachStreak: 0,
        periodStart,
      });
    }
    next.budgetBreachState = "ok";
    next.budgetBreachStreak = 0;
    next.budgetPausedAt = null;
    next.budgetPauseReason = null;
    next.budgetPauseThresholdUsd = null;
    next.budgetPauseObservedSpendUsd = null;
    next.keyDisableRecommended = false;
    if (resumed) next.budgetControlLastActionAt = now;
  }
  next.budgetControlPeriodStart = periodStart;

  const budget = observation.monthlyBudgetUsd;
  const budgetConfigured = budget != null && budget > 0;
  const threshold = budgetConfigured ? budget * config.breachMarginRatio : null;
  const inBreach =
    budgetConfigured && threshold != null && observation.spentUsd >= threshold;

  const cooldownElapsed =
    next.budgetControlLastActionAt == null ||
    now.getTime() - next.budgetControlLastActionAt.getTime() >=
      config.cooldownMs;

  if (inBreach) {
    if (next.budgetPausedAt !== null) {
      // Already paused and still in breach — freeze state (no churn, no flap).
    } else {
      const newStreak = next.budgetBreachStreak + 1;
      next.budgetBreachStreak = newStreak;
      if (next.budgetBreachState === "ok") {
        next.budgetBreachState = "breached";
        breachObserved = true;
        events.push({
          action: "breach_observed",
          reason: `Spend ${observation.spentUsd} reached the pause threshold ${threshold}.`,
          breachState: "breached",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: newStreak,
          periodStart,
        });
      }
      // ADVISORY ONLY after sustained breach: never auto-pause polling.
      // Auto-pause was rejected for this app (read-only observer): pausing the
      // poll blinds the dashboard while real spend continues on the key.
      if (
        newStreak >= config.breachTicks &&
        cooldownElapsed &&
        !next.keyDisableRecommended
      ) {
        next.budgetControlLastActionAt = now;
        next.keyDisableRecommended = true;
        next.budgetPauseThresholdUsd = threshold;
        next.budgetPauseObservedSpendUsd = observation.spentUsd;
        recommendationRaised = true;
        events.push({
          action: "recommend_key_disable",
          reason:
            `Sustained budget breach: spend ${observation.spentUsd} at/over threshold ${threshold} for ${newStreak} consecutive observation(s). RECOMMENDATION ONLY: consider disabling or rotating this key, or use the owner pause API if you intentionally want to stop polling. No credential was modified and polling was NOT auto-paused.`,
          breachState: "breached",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: newStreak,
          periodStart,
        });
      }
    }
  } else {
    // Not in breach this observation.
    if (next.budgetPausedAt !== null) {
      // Manual pauses stay until owner resumes, opt-out, or period roll.
      // Auto-resume on "spend fell under resume band" is intentionally disabled:
      // spentUsd is monotonic within a UTC month, so resume would never fire for
      // a true over-budget pause (owner review F2). Period roll still clears.
    } else if (next.budgetBreachState === "breached" || next.budgetBreachStreak > 0) {
      // Partial hysteresis progress that never reached a pause — clear it.
      const hadProgress =
        next.budgetBreachState === "breached" || next.budgetBreachStreak > 0;
      next.budgetBreachState = "ok";
      next.budgetBreachStreak = 0;
      if (hadProgress) {
        events.push({
          action: "breach_cleared",
          reason: `Spend ${observation.spentUsd} fell under threshold before pausing; breach progress cleared.`,
          breachState: "ok",
          thresholdUsd: threshold,
          observedSpendUsd: observation.spentUsd,
          breachStreak: 0,
          periodStart,
        });
      }
    }
  }

  const changed = !statesEqual(state, next) || events.length > 0;
  return {
    changed,
    next,
    events,
    paused,
    resumed,
    recommendationRaised,
    recommendationCleared,
    breachObserved,
  };
}

// ---------------------------------------------------------------------------
// Side-effectful apply layer. Reads the current per-provider control state +
// canonical budget spend, runs the pure decider, and persists state + audit
// rows. The WHOLE body is fail-safe: any error is logged and degraded to
// notify-only (degraded:true) rather than propagated to the scheduler.
// ---------------------------------------------------------------------------

type BudgetControlsPrisma = Pick<
  PrismaClient,
  "provider" | "budgetControlEvent" | "$transaction"
>;

export interface ApplyBudgetControlsOptions {
  now?: Date;
  env?: Partial<NodeJS.ProcessEnv>;
  prismaClient?: BudgetControlsPrisma;
  computeStatus?: (
    now: Date
  ) => Promise<{
    providers: Array<{
      id: string;
      monthlyBudgetUsd: number | null;
      spentUsd: number;
    }>;
  }>;
  /** When true (default off the injected path) writes are wrapped in the internal SQLite write-admission lease. */
  useWriteAdmission?: boolean;
}

export interface BudgetControlsResult {
  enabled: boolean;
  evaluated: number;
  paused: number;
  resumed: number;
  recommendationsRaised: number;
  recommendationsCleared: number;
  breachesObserved: number;
  auditRowsWritten: number;
  degraded: boolean;
  error?: string;
}

function emptyResult(enabled: boolean): BudgetControlsResult {
  return {
    enabled,
    evaluated: 0,
    paused: 0,
    resumed: 0,
    recommendationsRaised: 0,
    recommendationsCleared: 0,
    breachesObserved: 0,
    auditRowsWritten: 0,
    degraded: false,
  };
}

export async function applyBudgetControls(
  options: ApplyBudgetControlsOptions = {}
): Promise<BudgetControlsResult> {
  const env = options.env ?? process.env;
  const config = readBudgetControlConfig(env);

  // Master gate: OFF => zero I/O, byte-identical to notify-only.
  if (!config.masterEnabled) {
    return emptyResult(false);
  }

  const now = options.now ?? new Date();
  const db = options.prismaClient ?? prisma;
  const computeStatus = options.computeStatus ?? computeBudgetStatus;
  // Default to admission-wrapped writes only on the shared prisma singleton.
  const useAdmission = options.useWriteAdmission ?? options.prismaClient == null;
  const result = emptyResult(true);

  try {
    const [providers, budget] = await Promise.all([
      db.provider.findMany({
        where: {
          OR: [
            { budgetControlsEnabled: true },
            // Also sweep any provider carrying residual control state so an
            // opt-out reverts a prior pause even if the row is no longer
            // opted in.
            { budgetBreachState: { not: "ok" } },
            { budgetPausedAt: { not: null } },
            { keyDisableRecommended: true },
          ],
        },
        select: {
          id: true,
          budgetControlsEnabled: true,
          budgetBreachState: true,
          budgetBreachStreak: true,
          budgetControlPeriodStart: true,
          budgetPausedAt: true,
          budgetPauseReason: true,
          budgetPauseThresholdUsd: true,
          budgetPauseObservedSpendUsd: true,
          budgetControlLastActionAt: true,
          keyDisableRecommended: true,
        },
      }),
      computeStatus(now),
    ]);

    const spendByProviderId = new Map(
      budget.providers.map((entry) => [entry.id, entry])
    );

    for (const provider of providers) {
      try {
        const spend = spendByProviderId.get(provider.id);
        const observation: BudgetControlObservation = {
          monthlyBudgetUsd: spend?.monthlyBudgetUsd ?? null,
          spentUsd: spend?.spentUsd ?? 0,
        };
        const state: BudgetControlProviderState = {
          budgetControlsEnabled: provider.budgetControlsEnabled,
          budgetBreachState: normalizeBreachState(provider.budgetBreachState),
          budgetBreachStreak: provider.budgetBreachStreak,
          budgetControlPeriodStart: provider.budgetControlPeriodStart,
          budgetPausedAt: provider.budgetPausedAt,
          budgetPauseReason: provider.budgetPauseReason,
          budgetPauseThresholdUsd: provider.budgetPauseThresholdUsd,
          budgetPauseObservedSpendUsd: provider.budgetPauseObservedSpendUsd,
          budgetControlLastActionAt: provider.budgetControlLastActionAt,
          keyDisableRecommended: provider.keyDisableRecommended,
        };

        if (config.masterEnabled && provider.budgetControlsEnabled) {
          result.evaluated += 1;
        }

        const decision = decideBudgetControlAction(
          state,
          observation,
          config,
          now
        );
        if (!decision.changed) continue;

        const write = async () => {
          await db.$transaction(async (tx) => {
            await tx.provider.update({
              where: { id: provider.id },
              data: {
                budgetBreachState: decision.next.budgetBreachState,
                budgetBreachStreak: decision.next.budgetBreachStreak,
                budgetControlPeriodStart:
                  decision.next.budgetControlPeriodStart,
                budgetPausedAt: decision.next.budgetPausedAt,
                budgetPauseReason: decision.next.budgetPauseReason,
                budgetPauseThresholdUsd: decision.next.budgetPauseThresholdUsd,
                budgetPauseObservedSpendUsd:
                  decision.next.budgetPauseObservedSpendUsd,
                budgetControlLastActionAt:
                  decision.next.budgetControlLastActionAt,
                keyDisableRecommended: decision.next.keyDisableRecommended,
              },
            });
            for (const event of decision.events) {
              await tx.budgetControlEvent.create({
                data: {
                  providerId: provider.id,
                  action: event.action,
                  reason: event.reason,
                  breachState: event.breachState,
                  thresholdUsd: event.thresholdUsd,
                  observedSpendUsd: event.observedSpendUsd,
                  breachStreak: event.breachStreak,
                  periodStart: event.periodStart,
                },
              });
            }
          });
        };

        if (useAdmission) {
          await withInternalUsageWriteAdmission(write);
        } else {
          await write();
        }

        result.auditRowsWritten += decision.events.length;
        if (decision.paused) result.paused += 1;
        if (decision.resumed) result.resumed += 1;
        if (decision.recommendationRaised) result.recommendationsRaised += 1;
        if (decision.recommendationCleared) result.recommendationsCleared += 1;
        if (decision.breachObserved) result.breachesObserved += 1;
      } catch (providerError) {
        // One bad provider must not abort the rest, and must never break the
        // scheduler cycle. Degrade to notify-only for this provider.
        result.degraded = true;
        // eslint-disable-next-line no-console -- surfaces control-layer failures for on-call visibility
        console.error(
          `[budget-controls] provider ${provider.id} control evaluation failed; degrading to notify-only`,
          providerError
        );
      }
    }

    return result;
  } catch (error) {
    // Total fail-safe: never throw out of the control layer. The caller (usage
    // maintenance / scheduler) keeps running exactly as the notify-only path.
    // eslint-disable-next-line no-console -- surfaces control-layer failures for on-call visibility
    console.error(
      "[budget-controls] control evaluation failed; degrading to notify-only",
      error
    );
    return {
      ...emptyResult(true),
      degraded: true,
      error: error instanceof Error ? error.message : "Unknown budget-controls failure",
    };
  }
}

function normalizeBreachState(value: string): BudgetBreachState {
  return value === "breached" || value === "paused" ? value : "ok";
}

// ---------------------------------------------------------------------------
// Scheduler helper. Polling is paused ONLY for an **owner-set** durable pause
// while master + per-provider opt-in are both on. Master flag off is a global
// kill-switch that immediately resumes all polling.
// ---------------------------------------------------------------------------
export function budgetPollingPaused(
  provider: {
    budgetControlsEnabled?: boolean | null;
    budgetPausedAt?: Date | null;
  },
  env: Partial<NodeJS.ProcessEnv> = process.env
): boolean {
  if (!budgetAutoControlsEnabled(env)) return false;
  return Boolean(provider.budgetControlsEnabled) && provider.budgetPausedAt != null;
}

// ---------------------------------------------------------------------------
// Owner manual controls (session API). Auto-path never pauses; these do.
// ---------------------------------------------------------------------------

export type ManualBudgetControlAction =
  | "enable"
  | "disable"
  | "pause"
  | "resume";

export interface ManualBudgetControlInput {
  action: ManualBudgetControlAction;
  /** Required for pause: refuse when coverage is untrusted. */
  spendCoverage?: string | null;
  monthlyBudgetUsd?: number | null;
  spentUsd?: number | null;
  /** Variable usage portion; pause refused when breach is fixed-fee-only. */
  observedVariableUsageUsd?: number | null;
  fixedAccruedUsd?: number | null;
  reason?: string | null;
  now?: Date;
}

export interface ManualBudgetControlResult {
  ok: true;
  action: ManualBudgetControlAction;
  providerId: string;
  budgetControlsEnabled: boolean;
  budgetPausedAt: Date | null;
  keyDisableRecommended: boolean;
  budgetBreachState: string;
}

export class ManualBudgetControlError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "ManualBudgetControlError";
  }
}

export async function applyManualBudgetControl(
  providerId: string,
  input: ManualBudgetControlInput,
  prismaClient: BudgetControlsPrisma = prisma
): Promise<ManualBudgetControlResult> {
  const now = input.now ?? new Date();
  const periodStart = monthStartUtc(now);
  const provider = await prismaClient.provider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      budgetControlsEnabled: true,
      budgetBreachState: true,
      budgetBreachStreak: true,
      budgetPausedAt: true,
      keyDisableRecommended: true,
    },
  });
  if (!provider) {
    throw new ManualBudgetControlError("Provider not found", 404);
  }

  let budgetControlsEnabled = provider.budgetControlsEnabled;
  let budgetPausedAt: Date | null = provider.budgetPausedAt;
  let budgetPauseReason: string | null = null;
  let keyDisableRecommended = provider.keyDisableRecommended;
  let budgetBreachState = normalizeBreachState(provider.budgetBreachState);
  let budgetBreachStreak = provider.budgetBreachStreak;
  const events: BudgetControlEventDraft[] = [];

  switch (input.action) {
    case "enable":
      budgetControlsEnabled = true;
      events.push({
        action: "controls_enabled",
        reason: "Owner enabled budget controls for this provider.",
        breachState: budgetBreachState,
        thresholdUsd: null,
        observedSpendUsd: input.spentUsd ?? null,
        breachStreak: budgetBreachStreak,
        periodStart,
      });
      break;
    case "disable":
      budgetControlsEnabled = false;
      budgetPausedAt = null;
      budgetPauseReason = null;
      keyDisableRecommended = false;
      budgetBreachState = "ok";
      budgetBreachStreak = 0;
      events.push({
        action: "controls_disabled",
        reason: "Owner disabled budget controls; pause and recommendations cleared.",
        breachState: "ok",
        thresholdUsd: null,
        observedSpendUsd: input.spentUsd ?? null,
        breachStreak: 0,
        periodStart,
      });
      break;
    case "pause": {
      const coverage = (input.spendCoverage ?? "").toLowerCase();
      if (coverage !== "complete") {
        throw new ManualBudgetControlError(
          "Refuse to pause polling when spendCoverage is not complete — untrusted spend must not hide the provider.",
          400
        );
      }
      const variable = input.observedVariableUsageUsd ?? 0;
      const fixed = input.fixedAccruedUsd ?? 0;
      const spent = input.spentUsd ?? 0;
      const budget = input.monthlyBudgetUsd;
      if (budget != null && budget > 0 && spent >= budget && variable <= 0.005 && fixed >= budget) {
        throw new ManualBudgetControlError(
          "Refuse to pause for a fixed-subscription-only breach — raise the monthly budget or model the fee correctly instead of blinding the poll.",
          400
        );
      }
      if (!budgetControlsEnabled) {
        budgetControlsEnabled = true;
        events.push({
          action: "controls_enabled",
          reason: "Owner enabled controls as part of a manual pause.",
          breachState: budgetBreachState,
          thresholdUsd: null,
          observedSpendUsd: spent,
          breachStreak: budgetBreachStreak,
          periodStart,
        });
      }
      budgetPausedAt = now;
      budgetPauseReason =
        input.reason?.trim() ||
        "Owner manually paused polling for this provider.";
      budgetBreachState = "paused";
      events.push({
        action: "pause_manual",
        reason: budgetPauseReason,
        breachState: "paused",
        thresholdUsd: budget ?? null,
        observedSpendUsd: spent,
        breachStreak: budgetBreachStreak,
        periodStart,
      });
      break;
    }
    case "resume":
      budgetPausedAt = null;
      budgetPauseReason = null;
      if (budgetBreachState === "paused") {
        budgetBreachState = "breached";
      }
      events.push({
        action: "resume_manual",
        reason: "Owner manually resumed polling for this provider.",
        breachState: budgetBreachState,
        thresholdUsd: null,
        observedSpendUsd: input.spentUsd ?? null,
        breachStreak: budgetBreachStreak,
        periodStart,
      });
      break;
    default:
      throw new ManualBudgetControlError(`Unknown action: ${String(input.action)}`);
  }

  await withInternalUsageWriteAdmission(async () => {
    await prismaClient.$transaction(async (tx) => {
      await tx.provider.update({
        where: { id: providerId },
        data: {
          budgetControlsEnabled,
          budgetPausedAt,
          budgetPauseReason,
          keyDisableRecommended,
          budgetBreachState,
          budgetBreachStreak,
          budgetControlLastActionAt: now,
          budgetControlPeriodStart: periodStart,
        },
      });
      for (const event of events) {
        await tx.budgetControlEvent.create({
          data: {
            providerId,
            action: event.action,
            reason: event.reason,
            breachState: event.breachState,
            thresholdUsd: event.thresholdUsd,
            observedSpendUsd: event.observedSpendUsd,
            breachStreak: event.breachStreak,
            periodStart: event.periodStart,
          },
        });
      }
    });
  });

  return {
    ok: true,
    action: input.action,
    providerId,
    budgetControlsEnabled,
    budgetPausedAt,
    keyDisableRecommended,
    budgetBreachState,
  };
}
