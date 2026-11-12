import type { Prisma } from "@prisma/client";
import {
  persistExternalUsageEventsInTransaction,
  type ExternalUsageEventInput,
  type PersistExternalUsageEventsResult,
} from "@/lib/external-usage-events";
import { prisma } from "@/lib/prisma";
import type { OtlpPointDescriptor } from "./mapping-utils";

export interface OtlpUsageEventInput {
  event: ExternalUsageEventInput;
  point: OtlpPointDescriptor;
}

export interface PersistOtlpUsageEventsResult extends PersistExternalUsageEventsResult {
  ignoredOutOfOrder: number;
  idempotentRetries: number;
}

const DEFAULT_MAX_CUMULATIVE_SERIES = 100_000;

function maxCumulativeSeries(): number {
  const configured = Number(process.env.OTLP_MAX_CUMULATIVE_SERIES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CUMULATIVE_SERIES;
}

export class OtlpMetricStateCapacityError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `OTLP cumulative-series checkpoint capacity (${limit}) is exhausted; ` +
        "reduce high-cardinality resource attributes or raise OTLP_MAX_CUMULATIVE_SERIES"
    );
    this.name = "OtlpMetricStateCapacityError";
    this.limit = limit;
  }
}

function compareNano(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function withNormalizedValue(
  input: ExternalUsageEventInput,
  descriptor: OtlpPointDescriptor,
  value: number,
  reset: boolean
): ExternalUsageEventInput {
  const metadata = {
    ...(input.metadata ?? {}),
    otlpMetric: descriptor.metricName,
    otlpTemporality: descriptor.temporality,
    otlpSeriesKey: descriptor.seriesKey,
    otlpRawValue: descriptor.rawValue,
    ...(reset ? { otlpCounterReset: true } : {}),
  } as Prisma.InputJsonObject;
  if (input.costUsd !== undefined) return { ...input, costUsd: value, metadata };
  if (input.requests !== undefined) return { ...input, requests: Math.round(value), metadata };
  if (input.quantity !== undefined) return { ...input, quantity: value, metadata };
  return { ...input, metadata };
}

/**
 * Convert OTLP cumulative Sum points to deltas and persist the resulting usage
 * rows atomically with their durable checkpoints. Delta/unspecified Sums and
 * Gauges pass through unchanged. A point at or behind a series checkpoint is
 * ignored unless it is an already-persisted retry.
 */
export async function persistOtlpUsageEvents(
  inputs: OtlpUsageEventInput[]
): Promise<PersistOtlpUsageEventsResult> {
  if (inputs.length === 0) {
    return {
      attempted: 0,
      persisted: 0,
      skippedPrunedDuplicates: 0,
      newEvents: [],
      ignoredOutOfOrder: 0,
      idempotentRetries: 0,
    };
  }

  return prisma.$transaction(async (tx) => {
    const idempotencyKeys = Array.from(new Set(inputs.map(({ event }) => event.idempotencyKey)));
    const [existing, tombstones] = await Promise.all([
      tx.externalUsageEvent.findMany({
        where: { idempotencyKey: { in: idempotencyKeys } },
        select: { idempotencyKey: true },
      }),
      tx.externalUsageEventTombstone.findMany({
        where: { idempotencyKey: { in: idempotencyKeys } },
        select: { idempotencyKey: true },
      }),
    ]);
    const existingKeys = new Set(existing.map((row) => row.idempotencyKey));
    const tombstonedKeys = new Set(tombstones.map((row) => row.idempotencyKey));

    const cumulative = inputs
      .filter(
        ({ event, point }) =>
          point.temporality === "cumulative" &&
          !existingKeys.has(event.idempotencyKey) &&
          !tombstonedKeys.has(event.idempotencyKey)
      )
      .sort((left, right) => {
        const seriesOrder = left.point.seriesKey.localeCompare(right.point.seriesKey);
        return seriesOrder || compareNano(left.point.timeUnixNano, right.point.timeUnixNano);
      });
    const seriesKeys = Array.from(new Set(cumulative.map(({ point }) => point.seriesKey)));
    const checkpoints =
      seriesKeys.length > 0
        ? await tx.otlpMetricState.findMany({ where: { seriesKey: { in: seriesKeys } } })
        : [];
    const newSeriesCount = seriesKeys.length - checkpoints.length;
    if (newSeriesCount > 0) {
      const currentSeriesCount = await tx.otlpMetricState.count();
      const limit = maxCumulativeSeries();
      if (currentSeriesCount + newSeriesCount > limit) {
        throw new OtlpMetricStateCapacityError(limit);
      }
    }
    const stateBySeries = new Map(checkpoints.map((state) => [state.seriesKey, state]));
    const normalizedByKey = new Map<string, ExternalUsageEventInput>();
    let ignoredOutOfOrder = 0;

    for (const { event, point } of cumulative) {
      const state = stateBySeries.get(point.seriesKey);
      if (state && compareNano(point.timeUnixNano, state.lastTimeUnixNano) <= 0) {
        ignoredOutOfOrder += 1;
        continue;
      }

      const startChanged =
        !!state &&
        state.startTimeUnixNano !== null &&
        point.startTimeUnixNano !== undefined &&
        state.startTimeUnixNano !== point.startTimeUnixNano;
      const monotonicReset = !!state && point.isMonotonic && point.rawValue < state.lastValue;
      const reset = startChanged || monotonicReset;
      const delta = !state || reset ? point.rawValue : point.rawValue - state.lastValue;
      if (!Number.isFinite(delta)) {
        ignoredOutOfOrder += 1;
        continue;
      }
      // Wave F / E9: zero cumulative deltas (no change since last checkpoint)
      // still advance the durable checkpoint but do not create a zero-value
      // ExternalUsageEvent that would thrash budget/rollup scans.
      if (delta === 0 && !reset) {
        const nextStateZero = {
          seriesKey: point.seriesKey,
          metricName: point.metricName,
          startTimeUnixNano:
            point.startTimeUnixNano ?? state?.startTimeUnixNano ?? null,
          lastTimeUnixNano: point.timeUnixNano,
          lastValue: point.rawValue,
          lastPointKey: event.idempotencyKey,
          createdAt: state?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        stateBySeries.set(point.seriesKey, nextStateZero);
        ignoredOutOfOrder += 1;
        continue;
      }

      normalizedByKey.set(
        event.idempotencyKey,
        withNormalizedValue(event, point, delta, reset)
      );
      const nextState = {
        seriesKey: point.seriesKey,
        metricName: point.metricName,
        startTimeUnixNano: point.startTimeUnixNano ?? state?.startTimeUnixNano ?? null,
        lastTimeUnixNano: point.timeUnixNano,
        lastValue: point.rawValue,
        lastPointKey: event.idempotencyKey,
        createdAt: state?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      stateBySeries.set(point.seriesKey, nextState);
    }

    for (const state of stateBySeries.values()) {
      if (!seriesKeys.includes(state.seriesKey)) continue;
      await tx.otlpMetricState.upsert({
        where: { seriesKey: state.seriesKey },
        create: {
          seriesKey: state.seriesKey,
          metricName: state.metricName,
          startTimeUnixNano: state.startTimeUnixNano,
          lastTimeUnixNano: state.lastTimeUnixNano,
          lastValue: state.lastValue,
          lastPointKey: state.lastPointKey,
        },
        update: {
          metricName: state.metricName,
          startTimeUnixNano: state.startTimeUnixNano,
          lastTimeUnixNano: state.lastTimeUnixNano,
          lastValue: state.lastValue,
          lastPointKey: state.lastPointKey,
        },
      });
    }

    const passThrough = inputs
      .filter(
        ({ event, point }) =>
          point.temporality !== "cumulative" && !tombstonedKeys.has(event.idempotencyKey)
      )
      .map(({ event, point }) =>
        withNormalizedValue(event, point, point.rawValue, false)
      );
    const normalized = [
      ...passThrough,
      ...Array.from(normalizedByKey.values()),
    ].filter((event) => !existingKeys.has(event.idempotencyKey));

    const persisted = await persistExternalUsageEventsInTransaction(tx, normalized);
    return {
      ...persisted,
      attempted: inputs.length,
      skippedPrunedDuplicates:
        persisted.skippedPrunedDuplicates +
        inputs.filter(({ event }) => tombstonedKeys.has(event.idempotencyKey)).length,
      idempotentRetries: inputs.filter(({ event }) => existingKeys.has(event.idempotencyKey)).length,
      ignoredOutOfOrder,
    };
  }, { timeout: 30_000 });
}
