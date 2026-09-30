#!/usr/bin/env node
// Local collector for Google Antigravity quota usage.
//
// WHY THIS IS A LOCAL SCRIPT, NOT A GITHUB ACTION: Antigravity's quota is
// only readable where the `agy` CLI is installed and authenticated (it talks
// to the local Antigravity language server / the user's cached Google Cloud
// Code OAuth session). A GitHub Actions runner has neither, so it cannot
// observe real usage — it can only fabricate numbers. This script is meant to
// run on the same machine as Antigravity (see the launchd template alongside
// this file) and push real readings to the monitor's existing generic ingest
// endpoint.
//
// Usage:
//   node scripts/antigravity-usage-collector.mjs [--dry-run] [--debug]
//
// Required env (see docs/rollouts/2026-08-11-antigravity-usage-collector.md):
//   ANTIGRAVITY_INGEST_TOKEN   - the token half of the "antigravity-cli:<token>"
//                                pair added to this app's USAGE_INGEST_PRODUCER_TOKENS
//                                Infisical secret. Fetch it locally with the
//                                Infisical CLI, e.g.:
//                                  infisical run --projectId <INFISICAL_UM_PROJECT_ID> \
//                                    --env prod -- node scripts/antigravity-usage-collector.mjs
// Optional env:
//   USAGE_MONITOR_INGEST_URL  - default https://usage.jays.services/api/ingest/usage
//   ANTIGRAVITY_PRODUCER_ID   - default "antigravity-cli"; must equal the
//                                producerId half of the USAGE_INGEST_PRODUCER_TOKENS pair
//   ANTIGRAVITY_CLI_BIN       - default "agy"
//
// OUTPUT SHAPE — verified against a real authenticated `agy` on 2026-08-12
// (agy is not installed in CI, so scripts/test-antigravity-collector.mjs
// replays a captured envelope instead of shelling out):
//
//   {
//     conversation_id, status: "SUCCESS", duration_seconds, num_turns,
//     usage: { input_tokens, output_tokens, ... },
//     response: "Gemini Models\tWeekly Limit Remaining\t93%\t2026-08-19T02:08:16Z\n...",
//     command: { name: "usage", data: { description, groups: [ {
//       name: "Gemini Models",
//       description: "Models within this group: Gemini Flash, Gemini Pro",
//       buckets: [ { id: "gemini-weekly", name: "Weekly Limit Remaining",
//                    description, window: "weekly",
//                    remaining_fraction: 0.9276916, reset_time: "2026-08-19T02:08:16Z" } ],
//     } ] } },
//   }
//
// Three things about that shape drive the parsing below:
//
//  1. `command.data.groups[].buckets[]` is the authoritative reading and is
//     what this script prefers. It carries full-precision fractions
//     (0.9276916, vs. the `response` line's rounded "93%"), stable bucket ids,
//     and an explicit window kind. `response` is only a rendered view of it,
//     and is parsed solely as a fallback for CLI versions that omit `command`.
//  2. Quota is NOT per model. Antigravity meters per model *group* ("Gemini
//     Models", "Claude and GPT models" -- displayed as "Third-Party Models",
//     see antigravityGroupDisplayName), and each group has two independent
//     windows — weekly and 5h. So one reading is four series, and the series
//     identity is (group, bucket), never the group alone.
//  3. `usage` in the envelope is the token cost of running THIS CLI
//     invocation (what it cost to ask "/usage"). It has nothing to do with
//     account quota and is never sent as telemetry.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { antigravityGroupDisplayName } from "./lib/quota-event.mjs";
import { resolveCollectorToken } from "./lib/run-session-token-collector.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");

const CLI_BIN = process.env.ANTIGRAVITY_CLI_BIN || "agy";
const USAGE_CLI_BIN = process.env.ANTIGRAVITY_USAGE_BIN || "";
const INCLUDE_AUTOCOMPLETE = process.argv.includes("--all-models");
const PRODUCER_ID = process.env.ANTIGRAVITY_PRODUCER_ID || "antigravity-cli";
const INGEST_URL =
  process.env.USAGE_MONITOR_INGEST_URL ||
  "https://usage.jays.services/api/ingest/usage";

function log(message) {
  console.log(`[antigravity-usage-collector] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[antigravity-usage-collector] ${message}`);
  process.exit(code);
}

// A healthy `agy -p /usage` returns in 7-11s. A second concurrent invocation
// does not queue behind the first — it decides it has no usable session and
// drops into the interactive OAuth flow, which sits for ~160s before giving
// up (observed 2026-08-12, when a launchd tick overlapped a manual run). The
// budget here is sized to cover a genuinely slow-but-real run without waiting
// out that whole dead auth path; the launchd job only fires every 4h, so a
// tick lost to an overlap is not worth a retry loop.
const CLI_TIMEOUT_MS = 90_000;

function findAntigravityUsageBin() {
  if (USAGE_CLI_BIN && existsSync(USAGE_CLI_BIN)) return USAGE_CLI_BIN;
  const home = process.env.HOME || homedir();
  const candidates = [
    join(home, ".local", "bin", "antigravity-usage"),
    "/opt/homebrew/bin/antigravity-usage",
    "/usr/local/bin/antigravity-usage",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "antigravity-usage";
}

function runQuotaCli(bin, args) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
  });
}

function runAntigravityCli() {
  const usageBin = findAntigravityUsageBin();
  try {
    const raw = runQuotaCli(usageBin, ["quota", "--json", "--refresh"]);
    return { source: "antigravity-usage", raw };
  } catch (error) {
    if (error.code !== "ENOENT") {
      log(
        `"${usageBin} quota --json" failed (${error.stderr?.toString().trim() || error.message}); falling back to agy /usage`
      );
    }
  }

  try {
    const raw = runQuotaCli(CLI_BIN, ["-p", "/usage", "--output-format", "json"]);
    return { source: "agy", raw };
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`Neither antigravity-usage nor "${CLI_BIN}" is installed or on PATH.`, 127);
    }
    if (error.code === "ETIMEDOUT") {
      fail(
        `"${CLI_BIN} -p /usage" did not answer within ${CLI_TIMEOUT_MS / 1000}s. ` +
          "A healthy call takes about 10s, so this usually means another `agy` " +
          "invocation was running at the same time and this one fell into the " +
          "interactive login flow with nowhere to prompt. Re-run it on its own; " +
          "if it still hangs, run `antigravity-usage quota --json` in a terminal."
      );
    }
    fail(
      `"${CLI_BIN} -p /usage --output-format json" failed: ${
        error.stderr?.toString().trim() || error.message
      }`
    );
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// 0.9276916... -> 92.77. Two decimals is well inside the precision the CLI
// actually varies at between ticks, and keeps the stored numbers readable.
function fractionToPercent(fraction) {
  return Math.round(fraction * 10_000) / 100;
}

function parsePercentCell(cell) {
  if (typeof cell !== "string") return undefined;
  const match = cell.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

// PRIMARY PATH. `command.data.groups[].buckets[]` — see the OUTPUT SHAPE note
// at the top of this file. Returns [] (not an error) when this CLI version
// doesn't emit `command`, so the caller can fall back to `response`.
function parseUsageCommandGroups(command) {
  const groups = command?.data?.groups;
  if (!Array.isArray(groups)) return [];

  const records = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const groupName = firstString(group.name, group.id);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const fraction = firstFiniteNumber(bucket.remaining_fraction);
      if (fraction == null) continue;

      const bucketId = firstString(bucket.id);
      const bucketName = firstString(bucket.name);
      const window = firstString(bucket.window);
      const seriesKey = bucketId ?? `${groupName ?? "?"}|${bucketName ?? window ?? "?"}`;

      records.push({
        seriesKey,
        // Display label only: the raw group name stays in `group` (stored as
        // metadata.modelGroup) and in `seriesKey`, so event ids do not move.
        label: `${antigravityGroupDisplayName(groupName) ?? "Antigravity"} (${window ?? bucketName ?? "quota"})`,
        group: groupName,
        bucketId,
        window: window ?? bucketName,
        percentRemaining: fractionToPercent(fraction),
        resetAt: firstString(bucket.reset_time, bucket.resetTime),
      });
    }
  }
  return records;
}

// Column-name aliases the header-row detector accepts, lowercased. Real `agy`
// output as of 2026-08-12 has NO header row — see parseUsageResponseText's
// headerless branch — but a future version might add one.
const COLUMN_ALIASES = {
  group: ["group", "modelgroup", "models", "family"],
  bucket: ["bucket", "limit", "limitname", "quota", "quotaname"],
  model: ["model", "modelname", "name", "id"],
  percentRemaining: ["remaining", "percentremaining", "remainingpercent", "left"],
  percentUsed: ["percentused", "percentageused", "usedpercent", "usagepercent", "used"],
  limitAbsolute: ["quotalimit", "total", "max"],
  resetAt: ["resetat", "resetsat", "nextreset", "refreshat", "reset", "resettime"],
  window: ["window", "quotawindow", "period", "cadence"],
  tier: ["tier", "plan", "plantier"],
};

function matchColumn(headerCell) {
  const normalized = headerCell.trim().toLowerCase().replace(/[^a-z]/g, "");
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

// FALLBACK PATH. `response` is the rendered view of the same data, one
// tab-separated record per line. Observed real layout (headerless, 4 cells):
//
//   Gemini Models<TAB>Weekly Limit Remaining<TAB>93%<TAB>2026-08-19T02:08:16Z
//
// Loses precision versus the structured path (93% vs 92.77) and is only used
// when `command` is absent. A self-describing header row, if a future CLI
// version grows one, takes priority over the positional read.
function parseUsageResponseText(responseText) {
  const lines = responseText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headerCells = lines[0].split("\t").map((cell) => cell.trim());
  const columnMap = headerCells.map(matchColumn);
  const hasHeaderRow =
    columnMap.filter(Boolean).length >= 2 &&
    (columnMap.includes("model") || columnMap.includes("group")) &&
    // A data line's percent cell ("93%") must not be mistaken for a header.
    !headerCells.some((cell) => parsePercentCell(cell) != null);

  const records = [];
  const dataLines = hasHeaderRow ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const cells = line.split("\t").map((cell) => cell.trim());

    let byField;
    if (hasHeaderRow) {
      byField = {};
      columnMap.forEach((field, index) => {
        if (field) byField[field] = cells[index];
      });
    } else {
      // Positional read of the observed layout: group, bucket, percent, reset.
      // Anchored on the percent cell rather than a fixed index so an extra
      // leading or trailing column doesn't silently shift every field.
      const percentIndex = cells.findIndex((cell) => parsePercentCell(cell) != null);
      if (percentIndex < 1) continue;
      byField = {
        group: cells[0],
        bucket: cells.slice(1, percentIndex).join(" ") || undefined,
        percentRemaining: cells[percentIndex],
        resetAt: cells[percentIndex + 1],
      };
    }

    const group = firstString(byField.group);
    const bucket = firstString(byField.bucket);
    const model = firstString(byField.model);
    const window = firstString(byField.window, bucket);
    const name = group ?? model;
    if (!name) continue;

    const percentRemaining =
      parsePercentCell(byField.percentRemaining) ??
      firstFiniteNumber(Number.parseFloat(byField.percentRemaining));
    const percentUsed =
      parsePercentCell(byField.percentUsed) ??
      firstFiniteNumber(Number.parseFloat(byField.percentUsed));
    const limitAbsolute = firstFiniteNumber(Number.parseFloat(byField.limitAbsolute));
    if (percentRemaining == null && percentUsed == null && limitAbsolute == null) continue;

    records.push({
      seriesKey: window ? `${name}|${window}` : name,
      label: window
        ? `${antigravityGroupDisplayName(name)} (${window})`
        : antigravityGroupDisplayName(name),
      group,
      window,
      percentRemaining,
      percentUsed,
      limit: limitAbsolute,
      resetAt: firstString(byField.resetAt),
      tier: firstString(byField.tier),
    });
  }
  return records;
}

// LAST-RESORT PATH for a structured response that isn't the `command`
// envelope — e.g. a future CLI version, or a caller passing
// --output-format stream-json, nesting per-model objects at the top level.
function parseUsageResponseObject(raw) {
  const root = Array.isArray(raw)
    ? raw
    : raw?.models ?? raw?.quotas ?? raw?.records ?? null;
  if (!Array.isArray(root)) return [];

  const records = [];
  for (const entry of root) {
    if (!entry || typeof entry !== "object") continue;
    const model = firstString(entry.model, entry.modelName, entry.name, entry.id);
    if (!model) continue;

    const percentUsed = firstFiniteNumber(
      entry.percentUsed,
      entry.percentageUsed,
      entry.usedPercent,
      entry.usagePercent
    );
    const remaining = firstFiniteNumber(
      entry.remaining,
      entry.remainingQuota,
      entry.quotaRemaining
    );
    const limit = firstFiniteNumber(entry.limit, entry.quotaLimit, entry.total);
    if (percentUsed == null && remaining == null && limit == null) continue;

    const window = firstString(entry.window, entry.quotaWindow, entry.period);
    records.push({
      seriesKey: window ? `${model}|${window}` : model,
      label: window ? `${model} (${window})` : model,
      window,
      percentUsed,
      remaining,
      limit,
      resetAt: firstString(entry.resetAt, entry.resetsAt, entry.nextReset, entry.refreshAt),
      tier: firstString(entry.tier, entry.plan, entry.planTier),
    });
  }
  return records;
}

function quotaWindowFromResetMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  if (ms <= 6 * 3600 * 1000) return "5h";
  if (ms <= 36 * 3600 * 1000) return "daily";
  return "weekly";
}

// PRIMARY PATH as of 2026-09-03: `antigravity-usage quota --json` from the
// MIT npm CLI. Per-model remainingPercentage (0–1), isExhausted, resetTime.
// Owner 2026-09-04: omitted remainingPercentage (N/A in the table) means
// none remains — treat as exhausted 0%, not "unknown" and not 100%.
export function parseAntigravityUsageCli(envelope, { includeAutocomplete = INCLUDE_AUTOCOMPLETE } = {}) {
  const rows = envelope?.models;
  if (!Array.isArray(rows)) return [];
  if (!rows.some((row) => row && typeof row.modelId === "string")) return [];

  const records = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const modelId = firstString(entry.modelId, entry.id);
    if (!modelId) continue;
    if (entry.isAutocompleteOnly === true && !includeAutocomplete) continue;

    const fraction = firstFiniteNumber(entry.remainingPercentage);
    const isExhausted = entry.isExhausted === true || fraction == null;

    records.push({
      seriesKey: modelId,
      label: firstString(entry.label, entry.name) ?? modelId,
      modelId,
      window: quotaWindowFromResetMs(firstFiniteNumber(entry.timeUntilResetMs)),
      percentRemaining: fraction == null ? 0 : fractionToPercent(fraction),
      remainingUnknown: false,
      isExhausted,
      resetAt: firstString(entry.resetTime, entry.reset_time, entry.resetsAt),
      source: "antigravity-usage",
    });
  }
  return records;
}

export function extractQuotaRecords(envelope, { debug = DEBUG } = {}) {
  const fromUsageCli = parseAntigravityUsageCli(envelope);
  if (fromUsageCli.length > 0) {
    if (debug) log(`read ${fromUsageCli.length} model(s) from antigravity-usage quota --json`);
    return fromUsageCli;
  }

  if (typeof envelope?.status === "string" && envelope.status !== "SUCCESS") {
    fail(
      `agy reported a non-success status: ${envelope.status}` +
        (envelope.error ? ` (${envelope.error})` : "") +
        // The headless CLI reports a lost/contended session this way rather
        // than by exiting non-zero, so spell out the fix instead of leaving
        // "authentication failed or timed out" as the whole message.
        (/auth/i.test(String(envelope.error ?? ""))
          ? ". Run `agy -p \"/usage\"` in a terminal to re-establish the cached " +
            "session — headless mode can only use an existing one. Also check " +
            "nothing else was invoking agy at the same time."
          : "")
    );
  }
  if (debug && envelope?.usage) {
    log(
      `this CLI invocation itself cost ${envelope.usage.total_tokens ?? "?"} tokens ` +
        "(not account quota, not sent as telemetry)"
    );
  }

  const fromCommand = parseUsageCommandGroups(envelope?.command);
  if (fromCommand.length > 0) {
    if (debug) log(`read ${fromCommand.length} bucket(s) from the structured command payload`);
    return fromCommand;
  }

  if (typeof envelope?.response === "string") {
    const fromText = parseUsageResponseText(envelope.response);
    if (debug) {
      log(
        `no structured command payload; read ${fromText.length} record(s) from the ` +
          "rendered `response` text (reduced precision)"
      );
    }
    return fromText;
  }

  return parseUsageResponseObject(envelope);
}

function eventIdFor(occurredAtIso, seriesKey) {
  return createHash("sha256")
    .update(`${PRODUCER_ID} ${seriesKey} ${occurredAtIso}`)
    .digest("hex");
}

export function toTelemetryEvent(record, occurredAtIso) {
  // Prefer real absolute counts when the CLI provides them; otherwise fall
  // back to a normalized 0-100 percentage scale (limit=100). Either way,
  // `limit`/`credits` stay on the SAME scale so downstream percentage math
  // (credits / limit) is meaningful regardless of which branch fired. Real
  // Antigravity only ever reports fractions, so the percentage branch is the
  // live one; the absolute branch is there for a CLI that starts reporting
  // raw credit counts.
  const hasAbsolute = record.limit != null && record.remaining != null;
  const limit = hasAbsolute ? record.limit : 100;
  const credits = hasAbsolute
    ? record.remaining
    : record.percentRemaining != null
      ? record.percentRemaining
      : record.percentUsed != null
        ? Math.max(0, 100 - record.percentUsed)
        : undefined;

  const metadata = {};
  if (record.group) metadata.modelGroup = record.group;
  if (record.bucketId) metadata.bucketId = record.bucketId;
  if (record.modelId) metadata.modelId = record.modelId;
  if (record.window) metadata.quotaWindow = record.window;
  if (record.resetAt) metadata.resetAt = record.resetAt;
  if (record.source) metadata.source = record.source;
  if (record.isExhausted != null) metadata.isExhausted = record.isExhausted;
  if (record.remainingUnknown) metadata.remainingUnknown = true;
  if (!hasAbsolute) {
    metadata.scale = "percent_0_100";
    const percentUsed =
      record.percentUsed ??
      (record.percentRemaining != null
        ? Math.round((100 - record.percentRemaining) * 100) / 100
        : undefined);
    if (percentUsed != null) metadata.rawPercentUsed = percentUsed;
  }

  return {
    eventId: eventIdFor(occurredAtIso, record.seriesKey),
    provider: "google-antigravity",
    service: "antigravity-cli",
    label: record.label,
    ...(record.tier ? { tier: record.tier } : {}),
    metricType: "quota",
    billingMode: "actual",
    confidence: "actual",
    limit,
    ...(credits != null ? { credits } : {}),
    occurredAt: occurredAtIso,
    metadata,
  };
}

// The ingest idempotency key for a v2 event is derived from
// (producerId, eventId) alone, so two records in one batch that hash to the
// same eventId would collide and one reading would be silently dropped. That
// is exactly what a group-name-only key used to do here: "Gemini Models"
// names two distinct series (weekly and 5h). Fail loudly instead.
export function assertUniqueSeriesKeys(records) {
  const seen = new Map();
  for (const record of records) {
    const previous = seen.get(record.seriesKey);
    if (previous) {
      throw new Error(
        `Two quota records share the series key "${record.seriesKey}" ` +
          `("${previous.label}" and "${record.label}"). They would collide on ` +
          "eventId and one reading would be dropped by ingest idempotency."
      );
    }
    seen.set(record.seriesKey, record);
  }
}

export function buildEvents(envelope, occurredAtIso, options = {}) {
  const records = extractQuotaRecords(envelope, options);
  assertUniqueSeriesKeys(records);
  return records.map((record) => toTelemetryEvent(record, occurredAtIso));
}

export function extractAntigravityUsageModels(payload) {
  return parseAntigravityUsageCli(payload, { includeAutocomplete: true });
}

export function buildPerModelEvents(payload, occurredAtIso) {
  return buildEvents(payload, occurredAtIso);
}

async function postBatch(events, ingestToken) {
  const body = JSON.stringify({
    schemaVersion: 2,
    producerId: PRODUCER_ID,
    producerInstanceId: hostname(),
    events,
  });

  const response = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usage-telemetry-version": "2",
      authorization: `Bearer ${ingestToken}`,
    },
    body,
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok && response.status !== 202) {
    fail(
      `Ingest rejected the batch (HTTP ${response.status}): ${
        parsed ? JSON.stringify(parsed) : text
      }`
    );
  }
  return parsed ?? { raw: text };
}

async function main() {
  const ingestToken = resolveCollectorToken([
    "ANTIGRAVITY_INGEST_TOKEN",
    "USAGE_INGEST_TOKEN",
  ]);
  if (!ingestToken && !DRY_RUN) {
    fail(
      "Missing ANTIGRAVITY_INGEST_TOKEN or USAGE_INGEST_TOKEN. Ensure token is set in environment or ~/.secrets/global-api-keys."
    );
  }

  const { source, raw } = runAntigravityCli();
  if (DEBUG) log(`raw CLI output (${source}):\n${raw}`);

  let parsedJson;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    fail(
      "Could not parse CLI output as JSON. Prefer `antigravity-usage quota --json`. " +
        "The agy fallback is `-p \"/usage\" --output-format json` (agy v1.1.8+)."
    );
  }

  const occurredAtIso = new Date().toISOString();
  let events;
  try {
    events = buildEvents(parsedJson, occurredAtIso);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (events.length === 0) {
    fail(
      "Parsed a valid envelope but extracted zero quota records from it. Run " +
        "with --debug and compare the raw output against the OUTPUT SHAPE note " +
        "at the top of this script — the CLI's payload has probably changed."
    );
  }

  log(`parsed ${events.length} quota record(s):`);
  for (const event of events) {
    log(
      `  - ${event.label}: ${event.credits ?? "n/a"}/${event.limit} remaining` +
        (event.metadata.resetAt ? ` (resets ${event.metadata.resetAt})` : "")
    );
  }

  if (DRY_RUN) {
    log("--dry-run set; not sending. Payload would be:");
    console.log(JSON.stringify({ schemaVersion: 2, producerId: PRODUCER_ID, events }, null, 2));
    return;
  }

  const ack = await postBatch(events, ingestToken);
  log(`ingest ack: ${JSON.stringify(ack)}`);
  if (ack.ok === false || (typeof ack.rejected === "number" && ack.rejected > 0)) {
    fail(`Ingest reported rejections: ${JSON.stringify(ack)}`, 1);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    fail(error instanceof Error ? error.stack || error.message : String(error));
  });
}
