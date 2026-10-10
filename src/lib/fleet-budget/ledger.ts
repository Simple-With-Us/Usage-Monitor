import type { PrismaClient, Prisma, FleetBudgetReservation } from "@prisma/client";
import {
  dayKey, nextDayStart, digest, policySchema, pricingSchema, priceFresh, requestSchema, upperBound, usageCost, usageSchema,
  type FleetPolicy, type Provider, type ReservationInput, type Usage,
} from "./policy";

export class FleetBudgetError extends Error {
  constructor(readonly code: "invalid_request" | "policy_changed" | "pricing_unavailable" | "conflict" | "not_found" | "not_dispatchable" | "ledger_unavailable") {
    super(code);
  }
}
const ZERO = BigInt(0);
type Clock = Date | (() => Date);
const clockNow = (clock: Clock): Date => typeof clock === "function" ? clock() : clock;
type Tx = Prisma.TransactionClient;
export type ReservationView = ReturnType<typeof reservationView>;
function reservationView(row: FleetBudgetReservation) {
  return {
    reservationId: row.id, requestId: row.requestId, day: row.dayId,
    provider: row.provider, model: row.model, reason: row.routingReason, status: row.status,
    maximumCostMicros: row.maximumCostMicros.toString(),
    reservedPolicyMicros: row.reservedPolicyMicros.toString(),
    estimatedCostMicros: row.estimatedCostMicros?.toString() ?? null,
    providerReportedCostMicros: row.providerReportedCostMicros?.toString() ?? null,
    costBasis: "server_priced_producer_usage" as const,
    providerReportedCostVerified: false as const,
    dispatchBefore: row.dispatchBefore.toISOString(),
  };
}
function reservationId(clientId: string, requestId: string) {
  return digest([clientId, requestId]);
}
function isBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  // A failed Prisma transaction is rolled back before the whole unit retries.
  return e.code === "P2034" || e.code === "P1008" || e.code === "P2024" || ((e.code === "P2010" || e.code === "P2028")
    && /database is locked|database is busy|SQLITE_BUSY|timed out|timeout/i.test(e.message ?? ""));
}

/** SQLite is the authority, not a process-local mutex or cached status reader. */
export class FleetBudgetLedger {
  constructor(private readonly db: PrismaClient) {}

  private async write<T>(day: string, policy: FleetPolicy | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      const remaining = Math.floor(15_000 - (performance.now() - started));
      if (remaining <= 0) throw new FleetBudgetError("ledger_unavailable");
      const maxWait = Math.min(1_000, Math.max(1, Math.floor(remaining / 3)));
      try {
        return await this.db.$transaction(async (tx) => {
          // The FIRST statement acquires SQLite's database write lock.  Never
          // read-then-write through a deferred transaction or another client.
          await tx.$executeRaw`INSERT INTO "FleetBudgetGuard" ("id", "blocked", "revision")
            VALUES ('fleet-v1', false, 0)
            ON CONFLICT("id") DO UPDATE SET "revision" = "revision" + 1`;
          if (policy) {
            await tx.$executeRaw`INSERT INTO "FleetBudgetDay"
              ("id", "policyDigest", "softLimitMicros", "hardLimitMicros", "settledPolicyMicros", "reservedPolicyMicros", "estimatedDeepSeekMicros", "estimatedMiniMaxMicros", "blocked", "revision")
              VALUES (${day}, ${digest(policy)}, ${BigInt(policy.softLimitMicros)}, ${BigInt(policy.hardLimitMicros)}, 0, 0, 0, 0, false, 0)
              ON CONFLICT("id") DO UPDATE SET "revision" = "revision" + 1`;
          } else {
            const locked = await tx.$executeRaw`UPDATE "FleetBudgetDay" SET "revision" = "revision" + 1 WHERE "id" = ${day}`;
            if (locked !== 1) throw new FleetBudgetError("not_found");
          }
          return work(tx);
        }, { maxWait, timeout: Math.min(4_000, Math.max(1, remaining - maxWait)) });
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (attempt >= 19 || performance.now() - started >= 15_000) throw new FleetBudgetError("ledger_unavailable");
        await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 5));
      }
    }
  }

  async reserve(clientId: string, raw: ReservationInput, rawPolicy: FleetPolicy, clock: Clock = () => new Date()): Promise<ReservationView> {
    const parsed = requestSchema.safeParse(raw);
    const policyParsed = policySchema.safeParse(rawPolicy);
    if (!parsed.success || !policyParsed.success || !/^[a-zA-Z0-9._-]{1,80}$/.test(clientId)) throw new FleetBudgetError("invalid_request");
    const input = parsed.data, policy = policyParsed.data;
    const id = reservationId(clientId, input.requestId), day = dayKey(clockNow(clock)), requestDigest = digest(input);
    return this.write(day, policy, async (tx) => {
      const now = clockNow(clock);
      if (dayKey(now) !== day) throw new FleetBudgetError("not_dispatchable");
      const prior = await tx.fleetBudgetReservation.findUnique({ where: { id } });
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new FleetBudgetError("conflict");
        // An idempotent replay is never a second dispatch permission, including
        // after midnight, cancellation, expiry, or a client process restart.
        return reservationView(prior);
      }
      const ledger = await tx.fleetBudgetDay.findUniqueOrThrow({ where: { id: day } });
      if (ledger.policyDigest !== digest(policy)) throw new FleetBudgetError("policy_changed");
      const guard = await tx.fleetBudgetGuard.findUniqueOrThrow({ where: { id: "fleet-v1" } });
      const liability = ledger.settledPolicyMicros + ledger.reservedPolicyMicros;
      const primary: Provider = liability < ledger.softLimitMicros ? "deepseek" : "minimax";
      let provider: Provider = input.route === "primary" ? primary : primary === "deepseek" ? "minimax" : "deepseek";
      let reason = input.route === "fallback" ? "fallback_requested" : primary === "deepseek" ? "below_soft_limit" : "soft_limit_reached";
      if (provider === "deepseek" && (guard.blocked || ledger.blocked || liability >= ledger.hardLimitMicros)) {
        provider = "minimax"; reason = guard.blocked || ledger.blocked ? "ledger_blocked" : "hard_limit_reached";
      }
      if (provider === "deepseek" && !priceFresh(policy.deepseek, now)) {
        provider = "minimax"; reason = "deepseek_pricing_unavailable";
      }
      if (provider === "deepseek" && liability + upperBound(policy.deepseek, input) > ledger.hardLimitMicros) {
        provider = "minimax"; reason = "insufficient_headroom";
      }
      const price = policy[provider];
      if (!priceFresh(price, now)) throw new FleetBudgetError("pricing_unavailable");
      if (input.maxInputTokens > price.maxInputTokens || input.maxOutputTokens > price.maxOutputTokens) throw new FleetBudgetError("invalid_request");
      const bound = upperBound(price, input), policyBound = provider === "deepseek" ? bound : ZERO;
      // A conditional SQL update independently protects the cap invariant even
      // if selection/refactoring above ever stops checking it correctly.
      const admitted = await tx.$executeRaw`UPDATE "FleetBudgetDay"
        SET "reservedPolicyMicros" = "reservedPolicyMicros" + ${policyBound}
        WHERE "id" = ${day} AND (${provider} = 'minimax' OR
          ("blocked" = false AND NOT EXISTS (SELECT 1 FROM "FleetBudgetGuard" WHERE "id" = 'fleet-v1' AND "blocked" = true) AND "settledPolicyMicros" + "reservedPolicyMicros" + ${policyBound} <= "hardLimitMicros"))`;
      if (admitted !== 1) throw new FleetBudgetError("ledger_unavailable");
      const dispatchBefore = new Date(Math.min(now.getTime() + 60_000, Date.parse(price.validUntil), nextDayStart(now).getTime()));
      const row = await tx.fleetBudgetReservation.create({ data: {
        id, clientId, requestId: input.requestId, requestDigest, dayId: day, provider,
        model: price.model, pricingJson: JSON.stringify(price), routingReason: reason,
        maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens,
        maximumCostMicros: bound, reservedPolicyMicros: policyBound,
        createdAt: now, dispatchBefore,
      } });
      return reservationView(row);
    });
  }

  private async existing(clientId: string, requestId: string) {
    const id = reservationId(clientId, requestId);
    const row = await this.db.fleetBudgetReservation.findUnique({ where: { id } });
    if (!row || row.clientId !== clientId) throw new FleetBudgetError("not_found");
    return row;
  }

  async dispatch(clientId: string, requestId: string, clock: Clock = () => new Date()) {
    const existing = await this.existing(clientId, requestId);
    const result = await this.write(existing.dayId, null, async (tx) => {
      const now = clockNow(clock);
      const row = await tx.fleetBudgetReservation.findUniqueOrThrow({ where: { id: existing.id } });
      const day = await tx.fleetBudgetDay.findUniqueOrThrow({ where: { id: row.dayId } });
      const guard = await tx.fleetBudgetGuard.findUniqueOrThrow({ where: { id: "fleet-v1" } });
      if (row.status !== "reserved" || now >= row.dispatchBefore || dayKey(now) !== row.dayId
        || (row.provider === "deepseek" && (day.blocked || guard.blocked))) throw new FleetBudgetError("not_dispatchable");
      const updated = await tx.fleetBudgetReservation.update({ where: { id: row.id }, data: { status: "dispatched", dispatchedAt: now } });
      // Only this newly committed transition authorizes exactly one upstream
      // request.  Lost responses remain charged; retries NEVER return true.
      return { ...reservationView(updated), dispatchAllowed: true as const };
    });
    // A lock/commit delay must not return a fresh permit after its deadline.
    // Keep the committed liability if this response becomes ambiguous.
    const completedAt = clockNow(clock);
    if (completedAt >= new Date(result.dispatchBefore) || dayKey(completedAt) !== result.day) {
      throw new FleetBudgetError("not_dispatchable");
    }
    return result;
  }

  async cancel(clientId: string, requestId: string, now = new Date()) {
    const existing = await this.existing(clientId, requestId);
    return this.write(existing.dayId, null, async (tx) => {
      const row = await tx.fleetBudgetReservation.findUniqueOrThrow({ where: { id: existing.id } });
      if (row.status === "cancelled") return reservationView(row);
      if (row.status !== "reserved") throw new FleetBudgetError("not_dispatchable");
      await tx.fleetBudgetDay.update({ where: { id: row.dayId }, data: { reservedPolicyMicros: { decrement: row.reservedPolicyMicros } } });
      return reservationView(await tx.fleetBudgetReservation.update({ where: { id: row.id }, data: { status: "cancelled", settledAt: now } }));
    });
  }

  async reconcile(clientId: string, requestId: string, rawUsage: Usage | null, now = new Date()) {
    const result = rawUsage === null ? null : usageSchema.safeParse(rawUsage);
    if (result && !result.success) throw new FleetBudgetError("invalid_request");
    const usage = result?.success ? result.data : null;
    const existing = await this.existing(clientId, requestId);
    return this.write(existing.dayId, null, async (tx) => {
      const row = await tx.fleetBudgetReservation.findUniqueOrThrow({ where: { id: existing.id } });
      const settlementDigest = digest(usage);
      if (row.status === "settled") {
        if (row.settlementDigest !== settlementDigest) throw new FleetBudgetError("conflict");
        return reservationView(row);
      }
      if (row.status !== "dispatched" && row.status !== "uncertain") throw new FleetBudgetError("not_dispatchable");
      if (usage === null) {
        return reservationView(await tx.fleetBudgetReservation.update({ where: { id: row.id }, data: { status: "uncertain" } }));
      }
      let decoded: unknown;
      try { decoded = JSON.parse(row.pricingJson); } catch { throw new FleetBudgetError("ledger_unavailable"); }
      const savedPrice = pricingSchema.safeParse(decoded);
      if (!savedPrice.success) throw new FleetBudgetError("ledger_unavailable");
      const price = savedPrice.data;
      if ((row.provider !== "deepseek" && row.provider !== "minimax") || price.model !== row.model
        || row.maxInputTokens < 1 || row.maxOutputTokens < 1
        || row.maxInputTokens > price.maxInputTokens || row.maxOutputTokens > price.maxOutputTokens
        || upperBound(price, { requestId: row.requestId, maxInputTokens: row.maxInputTokens, maxOutputTokens: row.maxOutputTokens, route: "primary" }) !== row.maximumCostMicros
        || row.reservedPolicyMicros !== (row.provider === "deepseek" ? row.maximumCostMicros : ZERO)) {
        throw new FleetBudgetError("ledger_unavailable");
      }
      const estimate = usageCost(price, usage);
      // Policy accounting is conservative if a trusted provider reports a
      // larger amount.  Preserve both figures with their provenance intact.
      const reported = usage.providerReportedCostMicros == null ? null : BigInt(usage.providerReportedCostMicros);
      const accounted = reported != null && reported > estimate ? reported : estimate;
      const policyCost = row.provider === "deepseek" ? accounted : ZERO;
      const violated = usage.inputTokens > row.maxInputTokens || usage.outputTokens > row.maxOutputTokens || accounted > row.maximumCostMicros;
      if (violated && row.provider === "deepseek") {
        await tx.fleetBudgetGuard.update({ where: { id: "fleet-v1" }, data: { blocked: true, blockedAt: now } });
      }
      await tx.fleetBudgetDay.update({ where: { id: row.dayId }, data: {
        reservedPolicyMicros: { decrement: row.reservedPolicyMicros },
        settledPolicyMicros: { increment: policyCost },
        ...(row.provider === "deepseek" ? { estimatedDeepSeekMicros: { increment: estimate } } : { estimatedMiniMaxMicros: { increment: estimate } }),
        ...(violated && row.provider === "deepseek" ? { blocked: true } : {}),
      } });
      return reservationView(await tx.fleetBudgetReservation.update({ where: { id: row.id }, data: {
        status: "settled", settlementDigest, estimatedCostMicros: estimate,
        providerReportedCostMicros: reported, settledAt: now,
      } }));
    });
  }

  async status(now = new Date()) {
    // Bind the group query before the transaction tuple so Prisma retains
    // its literal aggregate selection instead of widening _count to true.
    const costQuery = this.db.fleetBudgetReservation.groupBy({
      by: ["provider", "status"],
      where: { dayId: dayKey(now), status: { in: ["reserved", "dispatched", "uncertain", "settled"] } },
      _sum: { maximumCostMicros: true, estimatedCostMicros: true, providerReportedCostMicros: true },
      _count: { _all: true, estimatedCostMicros: true, providerReportedCostMicros: true },
    });
    const [day, guard, costs] = await this.db.$transaction([
      this.db.fleetBudgetDay.findUnique({ where: { id: dayKey(now) } }),
      this.db.fleetBudgetGuard.findUnique({ where: { id: "fleet-v1" } }),
      costQuery,
    ]);
    const providerCosts = (["deepseek", "minimax"] as const).map((provider) => {
      const settled = costs.filter((row) => row.provider === provider && row.status === "settled");
      const pending = costs.filter((row) => row.provider === provider && row.status !== "settled");
      const estimatedCalls = settled.reduce((sum, row) => sum + row._count.estimatedCostMicros, 0);
      const reportedCalls = settled.reduce((sum, row) => sum + row._count.providerReportedCostMicros, 0);
      return {
        provider, policyWeight: provider === "deepseek" ? 1 : 0,
        settledCalls: settled.reduce((sum, row) => sum + row._count._all, 0),
        outstandingCalls: pending.reduce((sum, row) => sum + row._count._all, 0),
        outstandingMaximumCostMicros: pending.reduce((sum, row) => sum + (row._sum.maximumCostMicros ?? ZERO), ZERO).toString(),
        estimatedCalls,
        knownEstimatedCostMicros: estimatedCalls ? settled.reduce((sum, row) => sum + (row._sum.estimatedCostMicros ?? ZERO), ZERO).toString() : null,
        providerReportedCalls: reportedCalls,
        knownProviderReportedCostMicros: reportedCalls ? settled.reduce((sum, row) => sum + (row._sum.providerReportedCostMicros ?? ZERO), ZERO).toString() : null,
        providerReportedCostVerified: false,
      };
    });
    return {
      day: dayKey(now), timeZone: "America/Chicago", configured: day !== null,
      settledPolicyMicros: (day?.settledPolicyMicros ?? ZERO).toString(),
      reservedPolicyMicros: (day?.reservedPolicyMicros ?? ZERO).toString(),
      estimatedDeepSeekMicros: (day?.estimatedDeepSeekMicros ?? ZERO).toString(),
      estimatedMiniMaxMicros: (day?.estimatedMiniMaxMicros ?? ZERO).toString(),
      softLimitMicros: day?.softLimitMicros.toString() ?? null,
      hardLimitMicros: day?.hardLimitMicros.toString() ?? null,
      blocked: Boolean(guard?.blocked || day?.blocked),
      globalBlockedAt: guard?.blockedAt?.toISOString() ?? null,
      estimatesAreCash: false,
      providerCosts,
    };
  }
}
