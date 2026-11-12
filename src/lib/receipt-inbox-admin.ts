const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_INBOX_ORIGIN = "https://receipt-inbox.jays.services";

export function receiptInboxEvidenceConfigured(): boolean {
  const token = process.env.RECEIPT_INBOX_EVIDENCE_TOKEN?.trim();
  return Boolean(token && token.length >= 32);
}

export function parseReceiptInboxId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!RECEIPT_ID_PATTERN.test(id)) {
    throw new Error("Receipt id must be 64 hex characters");
  }
  return id;
}

function inboxOrigin(): string {
  const configured = process.env.RECEIPT_INBOX_BASE_URL?.trim();
  if (!configured) return DEFAULT_INBOX_ORIGIN;
  const url = new URL(configured);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("RECEIPT_INBOX_BASE_URL must be https");
  }
  return url.origin;
}

function evidenceToken(): string {
  const token = process.env.RECEIPT_INBOX_EVIDENCE_TOKEN?.trim();
  if (!token || token.length < 32) {
    throw new Error("Receipt evidence token is not configured on this host");
  }
  return token;
}

export async function fetchReceiptEvidence(id: string): Promise<Response> {
  const receiptId = parseReceiptInboxId(id);
  const response = await fetch(
    `${inboxOrigin()}/v1/receipts/${receiptId}/evidence`,
    {
      headers: { Authorization: `Bearer ${evidenceToken()}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }
  );
  return response;
}

export async function patchReceiptInboxStatus(
  id: string,
  status: "reviewed" | "ignored"
): Promise<Response> {
  const receiptId = parseReceiptInboxId(id);
  return fetch(`${inboxOrigin()}/v1/receipts/${receiptId}/status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${evidenceToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}
