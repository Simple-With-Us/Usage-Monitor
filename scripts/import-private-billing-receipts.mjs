#!/usr/bin/env node

import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import process from "node:process";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 100;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  return [
    "Usage:",
    "  npm run import:billing-receipts -- --input <chmod-600.json> --provider-id <uuid> --provider-name <name>",
    "  npm run import:billing-receipts -- --input <file> --provider-id <uuid> --provider-name <name> --apply --backup-acknowledged --base-url <https-url>",
    "",
    "Dry-run is the default. Apply reads BILLING_RECEIPT_INGEST_TOKEN from the environment.",
    "BILLING_RECEIPT_IDENTITY_KEY (stable) and BILLING_RECEIPT_HMAC_KEY (rotatable signing key) must each be 32+ characters and are never printed.",
    "Local apply additionally requires --allow-localhost plus the three BILLING_RECEIPT_LOCAL_* credentials.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    backupAcknowledged: false,
    allowLocalhost: false,
    inputPath: null,
    providerId: null,
    providerName: null,
    baseUrl: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--backup-acknowledged") options.backupAcknowledged = true;
    else if (value === "--allow-localhost") options.allowLocalhost = true;
    else if (["--input", "--provider-id", "--provider-name", "--base-url"].includes(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--input") options.inputPath = next;
      if (value === "--provider-id") options.providerId = next;
      if (value === "--provider-name") options.providerName = next;
      if (value === "--base-url") options.baseUrl = next;
    } else if (value === "--help" || value === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!options.inputPath) throw new Error("--input is required");
  if (!options.providerId || !UUID_PATTERN.test(options.providerId)) {
    throw new Error("--provider-id must be an explicit UUID");
  }
  if (!options.providerName?.trim() || options.providerName.trim().length > 80) {
    throw new Error("--provider-name must be 1-80 characters");
  }
  if (options.apply && !options.backupAcknowledged) {
    throw new Error("--apply requires --backup-acknowledged");
  }
  if (options.apply && !options.baseUrl) {
    throw new Error("--apply requires --base-url");
  }
  return options;
}

export async function readPrivateReceiptInput(inputPath) {
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
    if (stat.size > MAX_INPUT_BYTES) throw new Error("Input is larger than 1 MiB");
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
    if (offset > MAX_INPUT_BYTES) throw new Error("Input is larger than 1 MiB");
    raw = buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Input must be a JSON object");
  }
  if (!Array.isArray(parsed.receipts) || parsed.receipts.length === 0) {
    throw new Error("Input receipts must be a non-empty array");
  }
  if (parsed.receipts.length > MAX_RECEIPTS) {
    throw new Error(`Input supports at most ${MAX_RECEIPTS} receipts per run`);
  }
  return parsed.receipts;
}

function requireReceipt(record, index, now) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`receipts[${index}] must be an object`);
  }
  const receiptId = typeof record.receiptId === "string" ? record.receiptId.trim() : "";
  if (!receiptId || receiptId.length > 500) {
    throw new Error(`receipts[${index}].receiptId must be 1-500 characters`);
  }
  const amountUsd = record.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`receipts[${index}].amountUsd must be a positive finite number`);
  }
  if (record.kind !== "api_prepaid_funding") {
    throw new Error(`receipts[${index}].kind must be api_prepaid_funding`);
  }
  if (record.currency !== undefined && record.currency !== "USD") {
    throw new Error(`receipts[${index}].currency must be USD`);
  }
  const occurredAt = new Date(record.occurredAt);
  if (
    typeof record.occurredAt !== "string" ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== record.occurredAt
  ) {
    throw new Error(`receipts[${index}].occurredAt must be a canonical ISO timestamp`);
  }
  if (occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`receipts[${index}].occurredAt is too far in the future`);
  }
  const creditsPurchased = record.creditsPurchased;
  if (
    creditsPurchased !== undefined &&
    (typeof creditsPurchased !== "number" ||
      !Number.isFinite(creditsPurchased) ||
      creditsPurchased < 0)
  ) {
    throw new Error(`receipts[${index}].creditsPurchased must be non-negative`);
  }
  return { receiptId, amountUsd, occurredAt, creditsPurchased };
}

export function buildReceiptEvents({
  receipts,
  providerId,
  providerName,
  identityKey,
  signingKey,
  now = new Date(),
}) {
  if (!UUID_PATTERN.test(providerId)) throw new Error("providerId must be a UUID");
  if (typeof identityKey !== "string" || identityKey.length < 32) {
    throw new Error("BILLING_RECEIPT_IDENTITY_KEY must be at least 32 characters");
  }
  if (typeof signingKey !== "string" || signingKey.length < 32) {
    throw new Error("BILLING_RECEIPT_HMAC_KEY must be at least 32 characters");
  }
  const seen = new Set();
  return receipts.map((record, index) => {
    const receipt = requireReceipt(record, index, now);
    const digest = crypto
      .createHmac("sha256", identityKey)
      .update(`billing-receipt-import:v1\0${providerId.toLowerCase()}\0${receipt.receiptId}`)
      .digest("hex");
    if (seen.has(digest)) throw new Error(`receipts[${index}] duplicates another receipt ID`);
    seen.add(digest);
    const providerIdLower = providerId.toLowerCase();
    const providerNameNormalized = providerName.trim();
    const occurredAt = receipt.occurredAt.toISOString();
    const signatureBasis = [
      "billing-receipt-signature-v1",
      providerIdLower,
      providerNameNormalized.toLowerCase(),
      digest,
      String(receipt.amountUsd),
      occurredAt,
      receipt.creditsPurchased === undefined ? "" : String(receipt.creditsPurchased),
    ]
      .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
      .join("");
    const receiptSignature = crypto
      .createHmac("sha256", signingKey)
      .update(signatureBasis)
      .digest("hex");
    return {
      idempotencyKey: `billing-receipt:v1:${digest}`,
      sourceApp: "billing-receipt-import",
      provider: providerNameNormalized,
      service: "api-prepaid-funding",
      label: "receipt_cash_paid",
      keyRef: `provider:${providerIdLower}:billing-receipt:${digest}`,
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      costUsd: receipt.amountUsd,
      confidence: "actual",
      occurredAt,
      metadata: {
        schemaVersion: 1,
        costSemantics: "receipt_cash_paid",
        receiptKind: "api_prepaid_funding",
        evidenceRef: `hmac-sha256:${digest}`,
        receiptSignature: `hmac-sha256:${receiptSignature}`,
        ...(receipt.creditsPurchased === undefined
          ? {}
          : { creditsPurchased: receipt.creditsPurchased }),
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

export function receiptSecretsForTarget(target, env = process.env) {
  const localTarget = ["localhost", "127.0.0.1"].includes(target.hostname);
  return localTarget
    ? {
        identityKey: env.BILLING_RECEIPT_LOCAL_IDENTITY_KEY?.trim(),
        signingKey: env.BILLING_RECEIPT_LOCAL_HMAC_KEY?.trim(),
        token: env.BILLING_RECEIPT_LOCAL_INGEST_TOKEN?.trim(),
        localTarget: true,
      }
    : {
        identityKey: env.BILLING_RECEIPT_IDENTITY_KEY?.trim(),
        signingKey: env.BILLING_RECEIPT_HMAC_KEY?.trim(),
        token: env.BILLING_RECEIPT_INGEST_TOKEN?.trim(),
        localTarget: false,
      };
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
  const secrets = target
    ? receiptSecretsForTarget(target)
    : {
        identityKey: process.env.BILLING_RECEIPT_IDENTITY_KEY?.trim(),
        signingKey: process.env.BILLING_RECEIPT_HMAC_KEY?.trim(),
        token: undefined,
        localTarget: false,
      };
  const identityKeyName = secrets.localTarget
    ? "BILLING_RECEIPT_LOCAL_IDENTITY_KEY"
    : "BILLING_RECEIPT_IDENTITY_KEY";
  const signingKeyName = secrets.localTarget
    ? "BILLING_RECEIPT_LOCAL_HMAC_KEY"
    : "BILLING_RECEIPT_HMAC_KEY";
  if (typeof secrets.identityKey !== "string" || secrets.identityKey.length < 32) {
    throw new Error(`${identityKeyName} must be at least 32 characters`);
  }
  if (typeof secrets.signingKey !== "string" || secrets.signingKey.length < 32) {
    throw new Error(`${signingKeyName} must be at least 32 characters`);
  }
  const receipts = await readPrivateReceiptInput(options.inputPath);
  const events = buildReceiptEvents({
    receipts,
    providerId: options.providerId,
    providerName: options.providerName,
    identityKey: secrets.identityKey,
    signingKey: secrets.signingKey,
  });
  const totalUsd = events.reduce((sum, event) => sum + event.costUsd, 0);
  const safeSummary = {
    mode: options.apply ? "apply" : "dry-run",
    providerId: options.providerId.toLowerCase(),
    providerName: options.providerName.trim(),
    receiptCount: events.length,
    totalUsd,
    evidenceRefs: events.map((event) => `${event.metadata.evidenceRef.slice(0, 20)}...`),
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(safeSummary, null, 2)}\n`);
    return;
  }
  if (!secrets.token) {
    throw new Error(
      secrets.localTarget
        ? "BILLING_RECEIPT_LOCAL_INGEST_TOKEN is required for local --apply"
        : "BILLING_RECEIPT_INGEST_TOKEN is required for --apply"
    );
  }
  const result = await postEvents(target, secrets.token, events);
  process.stdout.write(`${JSON.stringify({ ...safeSummary, ...result }, null, 2)}\n`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Import failed"}\n`);
    process.exitCode = 1;
  });
}
