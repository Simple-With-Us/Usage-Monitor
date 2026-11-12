#!/usr/bin/env node
/**
 * Import owner-directed manual subscription billing adjustments (historical
 * prior-tier charges, pro-rated upgrade-refund estimates, etc.) as plain
 * ExternalUsageEvent rows via POST /api/ingest/usage.
 *
 * These are NOT receipt-cash events (see src/lib/receipt-cash.ts) — they use
 * metricType "subscription", which is the one metricType the ingest route
 * permits a negative costUsd for (src/lib/usage-telemetry.ts), so a refund
 * can be recorded as a genuine negative cash adjustment instead of being
 * dropped or sign-flipped into a fake positive charge.
 *
 * sourceApp is always "manual-billing-adjustment" — NOT "subscription"
 * (SUBSCRIPTION_SOURCE_APP, src/lib/subscription-charge-identity.ts), which
 * is reserved for the internal subscription materializer and is rejected by
 * the ingest route if claimed here. That reservation is what keeps these
 * events out of budget-status's materializer-owned charge cross-reference
 * (the metadata.subscriptionId lookup keyed on sourceApp="subscription");
 * they instead flow through the ordinary additive
 * sumMonthToDateExternalCostByProvider -> fixedAccruedUsd path, on top of
 * whatever the provider's current-term subscription is already charging.
 *
 * Unlike scripts/import-private-billing-receipts.mjs, the ingest route does
 * NOT cross-check a provider ID against the provider name for plain events
 * (that check only runs for the dedicated receipt-cash channel — see
 * src/app/api/ingest/usage/route.ts). --provider-id is therefore accepted
 * here ONLY as a provenance note embedded in event metadata, never as a
 * server-enforced identity check. Get --provider-name right; the server
 * trusts it verbatim for plain events.
 *
 * Usage:
 *   npm run import:subscription-adjustments -- --input <chmod-600.json> --provider-name <name>
 *   npm run import:subscription-adjustments -- --input <file> --provider-name <name> --apply --base-url <https-url>
 *
 * Dry-run (the default) prints a summary and makes no network calls.
 * --apply reads USAGE_INGEST_TOKEN from the environment — never accepted as
 * a flag, never printed.
 *
 * Input file JSON shape:
 *   {
 *     "records": [
 *       {
 *         "externalId": "apple-receipt-2026-06-13-claude-pro",
 *         "description": "Claude Pro Monthly, Apple receipt",
 *         "amountUsd": 21.45,
 *         "occurredAt": "2026-06-13T00:00:00.000Z",
 *         "confidence": "actual",
 *         "label": "Claude Pro Monthly (prior tier, Apple)"
 *       },
 *       ...
 *     ]
 *   }
 *
 * amountUsd may be negative (a refund/credit). confidence must be "actual"
 * (a receipt-backed charge) or "estimated" (a computed proration). Each
 * record's idempotencyKey is derived deterministically from --provider-name
 * and the record's own externalId, so re-running this script never
 * double-charges: replays are no-ops at the ingest route.
 */

import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import process from "node:process";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RECORDS = 50;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIDENCES = new Set(["actual", "estimated"]);

function usage() {
  return [
    "Usage:",
    "  npm run import:subscription-adjustments -- --input <chmod-600.json> --provider-name <name>",
    "  npm run import:subscription-adjustments -- --input <file> --provider-name <name> --apply --base-url <https-url>",
    "",
    "Dry-run is the default and makes no network calls.",
    "--apply reads USAGE_INGEST_TOKEN from the environment (never a flag, never printed).",
    "--provider-id (optional) is embedded in event metadata as a provenance note only —",
    "the ingest route does not cross-check it for plain (non-receipt) events.",
    "--allow-localhost permits a localhost/127.0.0.1 --base-url for local testing.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    allowLocalhost: false,
    inputPath: null,
    providerName: null,
    providerId: null,
    baseUrl: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--allow-localhost") options.allowLocalhost = true;
    else if (["--input", "--provider-name", "--provider-id", "--base-url"].includes(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--input") options.inputPath = next;
      if (value === "--provider-name") options.providerName = next;
      if (value === "--provider-id") options.providerId = next;
      if (value === "--base-url") options.baseUrl = next;
    } else if (value === "--help" || value === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!options.inputPath) throw new Error("--input is required");
  if (!options.providerName?.trim() || options.providerName.trim().length > 80) {
    throw new Error("--provider-name must be 1-80 characters");
  }
  if (options.providerId != null && !UUID_PATTERN.test(options.providerId)) {
    throw new Error("--provider-id must be a UUID when provided");
  }
  if (options.apply && !options.baseUrl) {
    throw new Error("--apply requires --base-url");
  }
  return options;
}

// Same trust model as scripts/import-private-billing-receipts.mjs's
// readPrivateReceiptInput: open with O_NOFOLLOW so a symlink can't redirect
// the read, then verify regular-file, owner, mode 600, and a bounded size
// BEFORE any of the bytes are trusted.
export async function readManualAdjustmentInput(inputPath) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(inputPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error("Input must be a regular file, not a symlink");
    }
    throw error;
  }
  let raw;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Input must be a regular file, not a symlink");
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("Input must have mode 600 (run chmod 600 on the file)");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Input must be owned by the current user");
    }
    if (stat.size > MAX_INPUT_BYTES) throw new Error("Input is larger than 256 KiB");
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_INPUT_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_INPUT_BYTES) throw new Error("Input is larger than 256 KiB");
    raw = buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Input must be a JSON object");
  }
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    throw new Error("Input records must be a non-empty array");
  }
  if (parsed.records.length > MAX_RECORDS) {
    throw new Error(`Input supports at most ${MAX_RECORDS} records per run`);
  }
  return parsed.records;
}

function requireRecord(record, index, now) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`records[${index}] must be an object`);
  }
  const externalId = typeof record.externalId === "string" ? record.externalId.trim() : "";
  if (!externalId || externalId.length > 200) {
    throw new Error(`records[${index}].externalId must be 1-200 characters`);
  }
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!description || description.length > 500) {
    throw new Error(`records[${index}].description must be 1-500 characters`);
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || label.length > 160) {
    throw new Error(`records[${index}].label must be 1-160 characters`);
  }
  const amountUsd = record.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    // May be negative (a refund) — only non-finite values are rejected here.
    throw new Error(`records[${index}].amountUsd must be a finite number`);
  }
  if (record.confidence !== "actual" && record.confidence !== "estimated") {
    throw new Error(`records[${index}].confidence must be "actual" or "estimated"`);
  }
  const occurredAt = new Date(record.occurredAt);
  if (
    typeof record.occurredAt !== "string" ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== record.occurredAt
  ) {
    throw new Error(`records[${index}].occurredAt must be a canonical ISO timestamp`);
  }
  if (occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`records[${index}].occurredAt is too far in the future`);
  }
  const voidsSubscriptionId =
    typeof record.voidsSubscriptionId === "string"
      ? record.voidsSubscriptionId.trim()
      : "";
  if (voidsSubscriptionId && !UUID_PATTERN.test(voidsSubscriptionId)) {
    throw new Error(`records[${index}].voidsSubscriptionId must be a UUID when provided`);
  }
  return {
    externalId,
    description,
    label,
    amountUsd,
    confidence: record.confidence,
    occurredAt,
    ...(voidsSubscriptionId ? { voidsSubscriptionId } : {}),
  };
}

export const MANUAL_ADJUSTMENT_SOURCE_APP = "manual-billing-adjustment";

export function buildManualAdjustmentEvents({
  records,
  providerName,
  providerId = null,
  now = new Date(),
}) {
  const providerNameNormalized = providerName.trim();
  if (!providerNameNormalized) throw new Error("providerName is required");
  const seen = new Set();
  return records.map((raw, index) => {
    const record = requireRecord(raw, index, now);
    // Deterministic per record: same (providerName, externalId) always
    // yields the same idempotencyKey, so re-running the script (or retrying
    // a partial --apply) never double-charges. No secret material is
    // involved — unlike receipt-cash, plain subscription events carry no
    // HMAC signature, so this key only needs to be stable, not unguessable.
    const digest = crypto
      .createHash("sha256")
      .update(
        `manual-billing-adjustment:v1\0${providerNameNormalized.toLowerCase()}\0${record.externalId}`
      )
      .digest("hex");
    if (seen.has(digest)) {
      throw new Error(`records[${index}] duplicates another record's externalId`);
    }
    seen.add(digest);
    return {
      idempotencyKey: `manual-billing-adjustment:v1:${digest}`,
      sourceApp: MANUAL_ADJUSTMENT_SOURCE_APP,
      provider: providerNameNormalized,
      billingMode: "manual",
      metricType: "subscription",
      unit: "usd",
      costUsd: record.amountUsd,
      confidence: record.confidence,
      label: record.label,
      occurredAt: record.occurredAt.toISOString(),
      metadata: {
        manualAdjustment: true,
        externalId: record.externalId,
        description: record.description,
        estimate: record.confidence === "estimated",
        ...(providerId ? { providerId: providerId.toLowerCase() } : {}),
        ...(record.voidsSubscriptionId
          ? { voidsSubscriptionId: record.voidsSubscriptionId }
          : {}),
      },
    };
  });
}

export function validatedBaseUrl(value, { allowLocalhost = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("--base-url must not include credentials");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (local) {
    if (!allowLocalhost) throw new Error("localhost requires --allow-localhost");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("localhost base URL must use HTTP or HTTPS");
    }
  } else if (url.origin !== "https://usage.jays.services") {
    throw new Error("--base-url must be https://usage.jays.services");
  }
  url.pathname = "/api/ingest/usage";
  url.search = "";
  url.hash = "";
  return url;
}

async function postEvents(url, token, events) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 202) {
      const safeError =
        typeof body.error === "string" ? body.error.slice(0, 200) : "Request failed";
      throw new Error(`Ingest returned HTTP ${response.status}: ${safeError}`);
    }
    return {
      accepted: Number.isInteger(body.accepted) ? body.accepted : 0,
      ignoredPruned: Number.isInteger(body.ignoredPruned) ? body.ignoredPruned : 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const target = options.apply
    ? validatedBaseUrl(options.baseUrl, { allowLocalhost: options.allowLocalhost })
    : null;

  const records = await readManualAdjustmentInput(options.inputPath);
  const events = buildManualAdjustmentEvents({
    records,
    providerName: options.providerName,
    providerId: options.providerId,
  });
  // Round for display only — the events posted to the server carry the
  // exact input amountUsd values; this is a summary convenience so the
  // printed total doesn't show a binary-floating-point tail like
  // 23.129999999999995.
  const totalUsd =
    Math.round(events.reduce((sum, event) => sum + event.costUsd, 0) * 100) / 100;
  const safeSummary = {
    mode: options.apply ? "apply" : "dry-run",
    sourceApp: MANUAL_ADJUSTMENT_SOURCE_APP,
    providerName: options.providerName.trim(),
    providerIdNote: options.providerId
      ? "embedded in metadata only — not server-enforced for plain events"
      : undefined,
    recordCount: events.length,
    totalUsd,
    records: events.map((event) => ({
      idempotencyKey: event.idempotencyKey,
      label: event.label,
      costUsd: event.costUsd,
      confidence: event.confidence,
      occurredAt: event.occurredAt,
    })),
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(safeSummary, null, 2)}\n`);
    return;
  }
  const token = process.env.USAGE_INGEST_TOKEN?.trim();
  if (!token) {
    throw new Error("USAGE_INGEST_TOKEN is required for --apply");
  }
  const result = await postEvents(target, token, events);
  process.stdout.write(`${JSON.stringify({ ...safeSummary, ...result }, null, 2)}\n`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Import failed"}\n`);
    process.exitCode = 1;
  });
}
