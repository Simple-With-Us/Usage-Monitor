import { validateReceiptLifecycleRules } from "../workers/receipt-lifecycle.mjs";

async function readBoundedText(response, maxBytes = 64 * 1024) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response_too_large");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.RECEIPT_LIFECYCLE_AUDIT_TOKEN?.trim();
if (!accountId || !/^[0-9a-f]{32}$/i.test(accountId) || !token || token.length < 32) {
  process.stderr.write(
    "Receipt deployment refused: CLOUDFLARE_ACCOUNT_ID and RECEIPT_LIFECYCLE_AUDIT_TOKEN are required.\n",
  );
  process.exit(1);
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/usage-monitor-receipts/lifecycle`,
  {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  },
);
if (!response.ok) {
  process.stderr.write(`Receipt deployment refused: lifecycle API returned HTTP ${response.status}.\n`);
  process.exit(1);
}
let body;
try {
  body = JSON.parse(await readBoundedText(response));
} catch {
  process.stderr.write("Receipt deployment refused: lifecycle response was invalid or exceeded 64 KiB.\n");
  process.exit(1);
}
if (body?.success !== true || !validateReceiptLifecycleRules(body?.result?.rules)) {
  process.stderr.write(
    "Receipt deployment refused: expected one non-conflicting enabled receipt-retention rule on evidence/ with exact 180-day expiry.\n",
  );
  process.exit(1);
}

process.stdout.write("Receipt evidence lifecycle verified: evidence/ expires after exactly 180 days.\n");
