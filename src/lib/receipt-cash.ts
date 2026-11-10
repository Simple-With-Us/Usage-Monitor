import crypto from "node:crypto";

const PROVIDER_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECEIPT_DIGEST_PATTERN = "[0-9a-f]{64}";
const RECEIPT_KEY_REF = new RegExp(
  `^provider:(${PROVIDER_ID_PATTERN}):billing-receipt:(${RECEIPT_DIGEST_PATTERN})$`,
  "i"
);
const SIGNATURE_PATTERN = /^hmac-sha256:([0-9a-f]{64})$/i;

export const BILLING_RECEIPT_SOURCE_APP = "billing-receipt-import";
export const API_PREPAID_FUNDING_SERVICE = "api-prepaid-funding";
export const RECEIPT_CASH_LABEL = "receipt_cash_paid";
export const RECEIPT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

/**
 * Owner-facing policy (receipt inbox + import):
 * - Inbox stores **evidence only** until explicit review/import.
 * - Prepaid API funding imports use durable receipt identity (provider + digest)
 *   so replaying the same receipt never double-counts cash.
 * - Subscription charges are modeled via Subscription / ProviderPlan rows —
 *   if a receipt **matches existing cash**, keep it as evidence and do **not**
 *   import the same amount again as receipt cash.
 */

export interface ReceiptCashEventLike {
  idempotencyKey?: string | null;
  sourceApp: string;
  provider?: string | null;
  service?: string | null;
  label?: string | null;
  keyRef?: string | null;
  billingMode: string;
  metricType: string;
  unit?: string | null;
  confidence?: string | null;
  costUsd?: number | null;
  occurredAt?: Date | string | null;
  metadata?: unknown;
}

export interface ReceiptCashIdentity {
  providerId: string;
  digest: string;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function receiptCashIdentity(
  input: ReceiptCashEventLike
): ReceiptCashIdentity | null {
  if (
    input.sourceApp !== BILLING_RECEIPT_SOURCE_APP ||
    input.service !== API_PREPAID_FUNDING_SERVICE ||
    input.label !== RECEIPT_CASH_LABEL ||
    input.billingMode !== "actual" ||
    input.metricType !== "cost" ||
    input.unit?.toLowerCase() !== "usd" ||
    input.confidence !== "actual"
  ) {
    return null;
  }
  const match = RECEIPT_KEY_REF.exec(input.keyRef ?? "");
  if (!match) return null;
  const providerId = match[1].toLowerCase();
  const digest = match[2].toLowerCase();
  if (input.idempotencyKey != null && input.idempotencyKey !== `billing-receipt:v1:${digest}`) {
    return null;
  }
  const metadata = metadataRecord(input.metadata);
  if (
    metadata &&
    metadata.evidenceRef !== undefined &&
    metadata.evidenceRef !== `hmac-sha256:${digest}`
  ) {
    return null;
  }
  return { providerId, digest };
}

export function receiptCashProviderId(input: ReceiptCashEventLike): string | null {
  return receiptCashIdentity(input)?.providerId ?? null;
}

export function isReceiptCashEvent(input: ReceiptCashEventLike): boolean {
  return receiptCashIdentity(input) != null;
}

export function looksLikeReceiptCashEvent(input: ReceiptCashEventLike): boolean {
  return (
    input.sourceApp === BILLING_RECEIPT_SOURCE_APP ||
    input.service === API_PREPAID_FUNDING_SERVICE ||
    input.label === RECEIPT_CASH_LABEL
  );
}

export function stripReceiptTransportSignature(
  metadata: Record<string, string | number | boolean | null> | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const sanitized = { ...metadata };
  delete sanitized.receiptSignature;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function receiptCashSignatureBasis(input: {
  providerId: string;
  providerName: string;
  digest: string;
  amountUsd: number;
  occurredAt: Date | string;
  creditsPurchased?: number;
}): string {
  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : new Date(input.occurredAt).toISOString();
  return [
    "billing-receipt-signature-v1",
    input.providerId.toLowerCase(),
    input.providerName.trim().toLowerCase(),
    input.digest.toLowerCase(),
    String(input.amountUsd),
    occurredAt,
    input.creditsPurchased === undefined ? "" : String(input.creditsPurchased),
  ]
    .map(encodeField)
    .join("");
}

export function signReceiptCashEvent(
  input: Parameters<typeof receiptCashSignatureBasis>[0],
  hmacKey: string
): string {
  return crypto
    .createHmac("sha256", hmacKey)
    .update(receiptCashSignatureBasis(input))
    .digest("hex");
}

export function verifyReceiptCashEvent(
  input: ReceiptCashEventLike,
  hmacKey: string,
  now: Date = new Date()
): boolean {
  if (hmacKey.length < 32) return false;
  const identity = receiptCashIdentity(input);
  const metadata = metadataRecord(input.metadata);
  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt
      : typeof input.occurredAt === "string"
        ? new Date(input.occurredAt)
        : null;
  if (
    !identity ||
    !metadata ||
    metadata.schemaVersion !== 1 ||
    metadata.costSemantics !== RECEIPT_CASH_LABEL ||
    metadata.receiptKind !== "api_prepaid_funding" ||
    metadata.evidenceRef !== `hmac-sha256:${identity.digest}` ||
    typeof input.provider !== "string" ||
    typeof input.costUsd !== "number" ||
    !Number.isFinite(input.costUsd) ||
    input.costUsd <= 0 ||
    !occurredAt ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() > now.getTime() + RECEIPT_MAX_FUTURE_SKEW_MS
  ) {
    return false;
  }
  const creditsPurchased = metadata.creditsPurchased;
  if (
    creditsPurchased !== undefined &&
    (typeof creditsPurchased !== "number" ||
      !Number.isFinite(creditsPurchased) ||
      creditsPurchased < 0)
  ) {
    return false;
  }
  const signatureMatch =
    typeof metadata.receiptSignature === "string"
      ? SIGNATURE_PATTERN.exec(metadata.receiptSignature)
      : null;
  if (!signatureMatch) return false;
  const expected = signReceiptCashEvent(
    {
      providerId: identity.providerId,
      providerName: input.provider,
      digest: identity.digest,
      amountUsd: input.costUsd,
      occurredAt,
      ...(creditsPurchased === undefined ? {} : { creditsPurchased }),
    },
    hmacKey
  );
  const actualBuffer = Buffer.from(signatureMatch[1].toLowerCase(), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
