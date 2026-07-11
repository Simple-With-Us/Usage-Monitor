#!/usr/bin/env node

/**
 * Reconstruct deltas from Claude Code cumulative counter samples that older
 * receiver versions persisted as additive usage/cost rows.
 *
 * Dry-run (default):
 *   node scripts/repair-claude-cumulative-cost.mjs
 * Apply only after a verified DB backup:
 *   node scripts/repair-claude-cumulative-cost.mjs --apply --backup-acknowledged
 *
 * Historical rows did not retain OTLP startTimeUnixNano or a precomputed
 * series key. Reconstruction therefore groups by all persisted dimensions and
 * metadata, sorts by occurredAt, computes adjacent deltas, and treats a value
 * decrease as a reset. This is the safest available reconstruction, but a
 * reset whose first value exceeds the old counter cannot be proven after the
 * fact. Any already-compacted Claude rollup aborts --apply because its
 * individual samples cannot be reconstructed exactly.
 */

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const backupAcknowledged = process.argv.includes("--backup-acknowledged");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function cleanHistoricalMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const mapperGeneratedKeys = new Set(["tokenType", "locType", "activeType", "toolName", "unit"]);
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

function groupKey(row) {
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
        metadata: cleanHistoricalMetadata(row.metadata),
      })
    )
    .digest("hex");
}

// Reconstruct the same merged-attribute series hash used by mapping-utils.ts.
// The old receiver persisted the merged resource+point metadata verbatim,
// which makes this checkpoint seed deterministic.
function metricNameFor(row) {
  if (row.metricType === "cost" || row.label === "cost") return "claude_code.cost.usage";
  if (row.label?.startsWith("token:")) return "claude_code.token.usage";
  if (row.label === "session") return "claude_code.session.count";
  if (row.label?.startsWith("lines_of_code:")) return "claude_code.lines_of_code.count";
  if (row.label === "commit") return "claude_code.commit.count";
  if (row.label === "pull_request") return "claude_code.pull_request.count";
  if (row.label?.startsWith("active_time:")) return "claude_code.active_time.total";
  if (row.label?.startsWith("code_edit_tool.decision:")) {
    return "claude_code.code_edit_tool.decision";
  }
  return null;
}

function rawField(row) {
  if (row.costUsd !== null) return { field: "costUsd", value: row.costUsd };
  if (row.requests !== null) return { field: "requests", value: row.requests };
  if (row.quantity !== null) return { field: "quantity", value: row.quantity };
  return null;
}

function otlpSeriesKey(row, metricName) {
  const metadata = cleanHistoricalMetadata(row.metadata);
  const attributes = Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ metric: metricName, attributes }))
    .digest("hex");
}

async function main() {
  if (apply && !backupAcknowledged) {
    throw new Error("--apply requires --backup-acknowledged after verifying a current DB backup");
  }

  const compacted = await prisma.externalUsageEventDailyRollup.count({
    where: { sourceApp: "claude-code" },
  });
  const candidates = (
    await prisma.externalUsageEvent.findMany({
      where: { sourceApp: "claude-code" },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    })
  ).filter(
    (row) =>
      metricNameFor(row) !== null &&
      rawField(row) !== null &&
      (!row.metadata ||
        typeof row.metadata !== "object" ||
        Array.isArray(row.metadata) ||
        (!("otlpTemporality" in row.metadata) && !("cumulativeMetricRepair" in row.metadata)))
  );

  const groups = new Map();
  for (const row of candidates) {
    const key = groupKey(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const repairs = [];
  const states = [];
  let rawTotal = 0;
  let repairedTotal = 0;
  let rawCostTotal = 0;
  let repairedCostTotal = 0;
  let resets = 0;
  for (const rows of groups.values()) {
    let previous = null;
    for (const row of rows) {
      const rawValue = rawField(row);
      if (!rawValue) continue;
      const raw = rawValue.value;
      const reset = previous !== null && raw < previous;
      const delta = previous === null || reset ? raw : raw - previous;
      rawTotal += raw;
      repairedTotal += delta;
      if (rawValue.field === "costUsd") {
        rawCostTotal += raw;
        repairedCostTotal += delta;
      }
      if (reset) resets += 1;
      repairs.push({ row, field: rawValue.field, raw, delta, reset });
      previous = raw;
    }
    const latest = rows[rows.length - 1];
    if (latest) {
      const latestValue = rawField(latest);
      const metricName = metricNameFor(latest);
      if (!latestValue || !metricName) continue;
      states.push({
        seriesKey: otlpSeriesKey(latest, metricName),
        metricName,
        last: latest,
        rawValue: latestValue.value,
      });
    }
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    candidateRows: candidates.length,
    series: groups.size,
    detectedResets: resets,
    currentSummedCostUsd: rawCostTotal,
    reconstructedCostUsd: repairedCostTotal,
    reductionUsd: rawCostTotal - repairedCostTotal,
    rawCounterTotalAcrossUnits: rawTotal,
    reconstructedCounterTotalAcrossUnits: repairedTotal,
    compactedClaudeRollups: compacted,
    caveat:
      "Historical start timestamps were not stored; decreases are detectable resets, higher-valued resets are not provable. Cross-unit totals are diagnostic only.",
  };
  console.log(JSON.stringify(report, null, 2));

  if (!apply || candidates.length === 0) return;
  if (compacted > 0) {
    throw new Error(
      "Refusing --apply: compacted Claude rollups exist and cannot be reconstructed from aggregate rows"
    );
  }

  await prisma.$transaction(
    async (tx) => {
      for (const repair of repairs) {
        const priorMetadata =
          repair.row.metadata &&
          typeof repair.row.metadata === "object" &&
          !Array.isArray(repair.row.metadata)
            ? repair.row.metadata
            : {};
        await tx.externalUsageEvent.update({
          where: { id: repair.row.id },
          data: {
            [repair.field]: repair.delta,
            metadata: {
              ...priorMetadata,
              cumulativeMetricRepair: "adjacent-delta-v1",
              otlpRawValue: repair.raw,
              ...(repair.reset ? { otlpCounterReset: true } : {}),
            },
          },
        });
      }
      for (const state of states) {
        await tx.otlpMetricState.upsert({
          where: { seriesKey: state.seriesKey },
          create: {
            seriesKey: state.seriesKey,
            metricName: state.metricName,
            startTimeUnixNano: null,
            lastTimeUnixNano: String(BigInt(state.last.occurredAt.getTime()) * 1_000_000n),
            lastValue: state.rawValue,
            lastPointKey: state.last.idempotencyKey,
          },
          update: {
            lastTimeUnixNano: String(BigInt(state.last.occurredAt.getTime()) * 1_000_000n),
            lastValue: state.rawValue,
            lastPointKey: state.last.idempotencyKey,
          },
        });
      }
    },
    { timeout: 300_000 }
  );
  console.log(JSON.stringify({ applied: repairs.length, checkpointsSeeded: states.length }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
