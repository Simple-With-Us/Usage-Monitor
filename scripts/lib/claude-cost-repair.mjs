import crypto from "node:crypto";

export const CLAUDE_COST_METRIC = "claude_code.cost.usage";
const PLAN_VERSION = "claude-cumulative-cost-adjacent-delta-v2";
const REPAIR_MARKER = "adjacent-delta-v2";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

export function cleanHistoricalClaudeCostMetadata(value) {
  if (!isRecord(value)) return {};
  const mapperGeneratedKeys = new Set([
    "tokenType",
    "locType",
    "activeType",
    "toolName",
    "unit",
  ]);
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        !key.startsWith("otlp") &&
        key !== "cumulativeCostRepair" &&
        key !== "cumulativeMetricRepair" &&
        !mapperGeneratedKeys.has(key)
    )
  );
}

function historicalGroupKey(row) {
  return crypto
    .createHash("sha256")
    .update(
      stable({
        sourceApp: row.sourceApp,
        environment: row.environment,
        provider: row.provider.toLowerCase(),
        service: row.service,
        label: row.label,
        keyRef: row.keyRef,
        projectId: row.projectId,
        metadata: cleanHistoricalClaudeCostMetadata(row.metadata),
      })
    )
    .digest("hex");
}

/** Reconstruct mapping-utils.ts's merged-attribute series hash. */
export function historicalClaudeCostSeriesKey(metadata) {
  const attributes = Object.entries(cleanHistoricalClaudeCostMetadata(metadata)).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ metric: CLAUDE_COST_METRIC, attributes }))
    .digest("hex");
}

function isUnrepairedHistoricalCost(row) {
  if (row.metricType !== "cost" || row.costUsd === null) return false;
  if (!Number.isFinite(row.costUsd) || row.costUsd < 0) return false;
  if (!isRecord(row.metadata)) return true;
  return !(
    "otlpTemporality" in row.metadata ||
    "cumulativeCostRepair" in row.metadata ||
    "cumulativeMetricRepair" in row.metadata
  );
}

function checkpointFrom(row) {
  return {
    seriesKey: historicalClaudeCostSeriesKey(row.metadata),
    metricName: CLAUDE_COST_METRIC,
    lastTimeUnixNano: String(BigInt(row.occurredAt.getTime()) * 1_000_000n),
    lastValue: row.costUsd,
    lastPointKey: row.idempotencyKey,
  };
}

function compareNano(left, right) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export async function planClaudeCumulativeCostRepair(client) {
  const [compactedClaudeRollups, rows] = await Promise.all([
    client.externalUsageEventDailyRollup.count({
      where: { sourceApp: "claude-code" },
    }),
    client.externalUsageEvent.findMany({
      where: {
        sourceApp: "claude-code",
        metricType: "cost",
        costUsd: { not: null },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const candidates = rows.filter(isUnrepairedHistoricalCost);
  const groups = new Map();
  for (const row of candidates) {
    const key = historicalGroupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const repairs = [];
  const checkpoints = new Map();
  let rawCostTotal = 0;
  let repairedCostTotal = 0;
  let resets = 0;
  for (const groupRows of groups.values()) {
    let previous = null;
    for (const row of groupRows) {
      const raw = row.costUsd;
      const reset = previous !== null && raw < previous;
      const delta = previous === null || reset ? raw : raw - previous;
      rawCostTotal += raw;
      repairedCostTotal += delta;
      if (reset) resets += 1;
      repairs.push({
        id: row.id,
        raw,
        delta,
        reset,
        metadata: isRecord(row.metadata) ? row.metadata : {},
      });
      previous = raw;
    }
    const latest = groupRows[groupRows.length - 1];
    if (latest) {
      const checkpoint = checkpointFrom(latest);
      const prior = checkpoints.get(checkpoint.seriesKey);
      if (!prior || compareNano(prior.lastTimeUnixNano, checkpoint.lastTimeUnixNano) < 0) {
        checkpoints.set(checkpoint.seriesKey, checkpoint);
      }
    }
  }

  const report = {
    mode: "dry-run",
    scope: "cost-only",
    candidateRows: candidates.length,
    series: groups.size,
    detectedResets: resets,
    currentSummedCostUsd: rawCostTotal,
    reconstructedCostUsd: repairedCostTotal,
    reductionUsd: rawCostTotal - repairedCostTotal,
    // Retained for compatibility with the original dry-run JSON schema. With
    // the production-safe cost-only scope these values are both USD totals.
    rawCounterTotalAcrossUnits: rawCostTotal,
    reconstructedCounterTotalAcrossUnits: repairedCostTotal,
    compactedClaudeRollups,
    caveat:
      "Historical start timestamps were not stored; decreases are detectable resets, higher-valued resets are not provable.",
  };

  return {
    version: PLAN_VERSION,
    report,
    repairs,
    checkpoints: Array.from(checkpoints.values()),
  };
}

/**
 * Apply using a caller-owned Prisma transaction. The rollup refusal is checked
 * again inside that same transaction before the first mutation. Callers must
 * also provide startup exclusivity so the in-process retention scheduler is
 * not running concurrently.
 */
export async function applyClaudeCumulativeCostRepair(client, plan) {
  if (
    plan?.version !== PLAN_VERSION ||
    !Array.isArray(plan.repairs) ||
    !Array.isArray(plan.checkpoints)
  ) {
    throw new Error("invalid Claude cumulative-cost repair plan");
  }
  if (plan.repairs.length === 0) {
    return { applied: 0, checkpointsSeeded: 0, checkpointsAdvanced: 0, checkpointsPreserved: 0 };
  }

  const compacted = await client.externalUsageEventDailyRollup.count({
    where: { sourceApp: "claude-code" },
  });
  if (compacted > 0) {
    throw new Error(
      "Refusing --apply: compacted Claude rollups exist and cannot be reconstructed from aggregate rows"
    );
  }

  for (const repair of plan.repairs) {
    await client.externalUsageEvent.update({
      where: { id: repair.id },
      data: {
        costUsd: repair.delta,
        metadata: {
          ...repair.metadata,
          cumulativeCostRepair: REPAIR_MARKER,
          otlpRawValue: repair.raw,
          ...(repair.reset ? { otlpCounterReset: true } : {}),
        },
      },
      select: { id: true },
    });
  }

  let checkpointsSeeded = 0;
  let checkpointsAdvanced = 0;
  let checkpointsPreserved = 0;
  for (const checkpoint of plan.checkpoints) {
    const existing = await client.otlpMetricState.findUnique({
      where: { seriesKey: checkpoint.seriesKey },
    });
    if (!existing) {
      await client.otlpMetricState.create({
        data: {
          ...checkpoint,
          startTimeUnixNano: null,
        },
        select: { seriesKey: true },
      });
      checkpointsSeeded += 1;
      continue;
    }
    // Equal/newer state is authoritative. Never rewind a checkpoint that may
    // already include post-fix telemetry received after the historical rows.
    if (compareNano(existing.lastTimeUnixNano, checkpoint.lastTimeUnixNano) >= 0) {
      checkpointsPreserved += 1;
      continue;
    }
    await client.otlpMetricState.update({
      where: { seriesKey: checkpoint.seriesKey },
      data: {
        metricName: checkpoint.metricName,
        lastTimeUnixNano: checkpoint.lastTimeUnixNano,
        lastValue: checkpoint.lastValue,
        lastPointKey: checkpoint.lastPointKey,
      },
      select: { seriesKey: true },
    });
    checkpointsAdvanced += 1;
  }

  return {
    applied: plan.repairs.length,
    checkpointsSeeded,
    checkpointsAdvanced,
    checkpointsPreserved,
  };
}
