import PostalMime from "postal-mime";
import {
  RECEIPT_RETENTION_DAYS,
  validateReceiptLifecycleRules,
} from "../../receipt-lifecycle.mjs";
import {
  boundedSubject,
  calendarTitle,
  classifyReceipt,
  enrichClassification,
} from "./classify.mjs";

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_DAILY_MESSAGES = 100;
const MAX_DAILY_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_SUPPORTED_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_SUMMARY_ITEMS = 50;
const RETENTION_MS = RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_CLEANUP_ITEMS = 100;
const LIFECYCLE_AUDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LIFECYCLE_AUDIT_RETRY_MS = 15 * 60 * 1000;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const RETENTION_ACK = "receipt-evidence-lifecycle-configured-v1";
const VALID_STATUSES = new Set(["needs_review", "reviewed", "ignored"]);

const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

function utf8(value) {
  return new TextEncoder().encode(value);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromAttachment(content) {
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  return utf8(typeof content === "string" ? content : "");
}

function hasMagicBytes(mediaType, bytes) {
  if (mediaType === "application/pdf") {
    return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
  }
  if (mediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => bytes[index] === value);
  }
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

function supportedAttachmentBytes(attachment) {
  const bytes = bytesFromAttachment(attachment.content);
  const mediaType = String(attachment.mimeType || "").toLowerCase();
  return SUPPORTED_ATTACHMENT_TYPES.has(mediaType)
    && bytes.byteLength <= MAX_ATTACHMENT_BYTES
    && hasMagicBytes(mediaType, bytes)
    ? bytes
    : null;
}

export function inspectAttachments(attachments = []) {
  let supportedBytes = 0;
  let supportedCount = 0;
  let rejectedCount = 0;
  for (const attachment of attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
    const bytes = supportedAttachmentBytes(attachment);
    if (bytes && supportedBytes + bytes.byteLength <= MAX_SUPPORTED_ATTACHMENT_BYTES) {
      supportedCount += 1;
      supportedBytes += bytes.byteLength;
    } else {
      rejectedCount += 1;
    }
  }
  if (attachments.length > MAX_ATTACHMENT_COUNT) rejectedCount += attachments.length - MAX_ATTACHMENT_COUNT;
  return {
    attachmentCount: attachments.length,
    supportedAttachmentCount: supportedCount,
    rejectedAttachmentCount: rejectedCount,
  };
}

export function senderDomain(value) {
  if (typeof value !== "string") return "unknown";
  const at = value.lastIndexOf("@");
  if (at < 0 || at === value.length - 1) return "unknown";
  const domain = value.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : "unknown";
}

// Authentication-Results is an ordinary message header at this boundary and
// can be injected upstream. Never represent it as trusted review evidence.
export function senderAuthentication() {
  return "unknown";
}

async function hmacHex(value, identityKey) {
  if (typeof identityKey !== "string" || identityKey.length < 32) {
    throw new Error("RECEIPT_INBOX_IDENTITY_KEY must be at least 32 characters");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(identityKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, value));
}

async function receiptId(raw, identityKey) {
  return hmacHex(await crypto.subtle.digest("SHA-256", raw), identityKey);
}

async function attachmentGroupId(attachments, identityKey) {
  const digests = [];
  let total = 0;
  for (const attachment of attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
    // Images are frequently reusable inline branding assets. Grouping on them
    // could collapse unrelated receipts that happen to share the same logo.
    if (String(attachment.mimeType || "").toLowerCase() !== "application/pdf") continue;
    const bytes = supportedAttachmentBytes(attachment);
    if (!bytes || total + bytes.byteLength > MAX_SUPPORTED_ATTACHMENT_BYTES) continue;
    total += bytes.byteLength;
    digests.push(hex(await crypto.subtle.digest("SHA-256", bytes)));
  }
  if (digests.length === 0) return null;
  digests.sort();
  return hmacHex(utf8(`receipt-attachment-group-v1\0${digests.join("\0")}`), identityKey);
}

/** Fixed receipt intake subdomain. Apex jays.services MX stays on iCloud. */
export const RECEIPT_INBOX_DOMAIN = "receipts.jays.services";

/**
 * Any local-part on receipts.jays.services is accepted for intake, including
 * short addresses (receipts@…) and high-entropy rcpt-… mailboxes. Apex and
 * other subdomains remain rejected so personal mail is never co-mingled.
 */
export function isReceiptInboxAddress(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  // Local-part: leading alnum, then up to 63 more RFC-ish mailbox chars.
  return /^[a-z0-9][a-z0-9._+-]{0,63}@receipts\.jays\.services$/i.test(trimmed);
}

/**
 * @deprecated Prefer {@link isReceiptInboxAddress}. Kept as an alias so older
 * tests and call sites keep working while the intake rule is domain-wide.
 */
export function isDedicatedReceiptAddress(value) {
  return isReceiptInboxAddress(value);
}

// Optional no-forward intake: when the recipient's local-part matches the
// configured RECEIPT_NO_FORWARD_LOCAL_PART (a Worker secret, never logged),
// the message is filed without fallback forwarding. This is the path for
// agent-forwarded originals, where the forwarder already holds a copy and a
// forwarded duplicate would only add noise to the owner's mailbox. The value
// is env-configured so the reserved local-part never appears in the repo.
export function isNoForwardRecipient(value, noForwardLocalPart) {
  if (typeof value !== "string" || typeof noForwardLocalPart !== "string") return false;
  const configured = noForwardLocalPart.trim().toLowerCase();
  if (!configured) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  return value.slice(0, at).trim().toLowerCase() === configured;
}

function evidenceKey(id) {
  return `evidence/${id}.eml`;
}

async function safeTokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", utf8(left)),
    crypto.subtle.digest("SHA-256", utf8(right)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual !== "function") {
    throw new Error("The Workers timing-safe comparison API is unavailable");
  }
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function indexStub(env) {
  return env.RECEIPT_INDEX.get(env.RECEIPT_INDEX.idFromName("receipt-inbox-v1"));
}

async function indexRequest(env, path, init) {
  const response = await indexStub(env).fetch(`https://receipt-index.internal${path}`, init);
  if (!response.ok) throw new Error(`Receipt index returned HTTP ${response.status}`);
  return response;
}

export async function handleEmail(message, env, _ctx) {
  // Accept any *@receipts.jays.services recipient (short or high-entropy).
  // RECEIPT_INBOX_ADDRESS remains a configured identity on that domain used
  // for readiness/health; it is no longer the sole accepted To: address.
  if (
    !isReceiptInboxAddress(env.RECEIPT_INBOX_ADDRESS)
    || typeof message.to !== "string"
    || !isReceiptInboxAddress(message.to)
  ) {
    message.setReject("Unknown receipt mailbox");
    return;
  }
  if (env.RECEIPT_INBOX_RETENTION_ACK !== RETENTION_ACK) {
    message.setReject("Receipt evidence retention is not configured");
    return;
  }
  // No-forward intake (agent-forwarded originals) files without fallback
  // forwarding, so it never needs the fallback destination configured.
  const noForward = isNoForwardRecipient(message.to, env.RECEIPT_NO_FORWARD_LOCAL_PART);
  if (
    !noForward
    && (typeof env.RECEIPT_FALLBACK_ADDRESS !== "string"
      || !/^[^@\s]+@[^@\s]+$/.test(env.RECEIPT_FALLBACK_ADDRESS)
      || typeof message.forward !== "function")
  ) {
    message.setReject("Receipt fallback is not configured");
    return;
  }
  if (!Number.isSafeInteger(message.rawSize) || message.rawSize <= 0) {
    message.setReject("Receipt message size was unavailable");
    return;
  }
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject(`Receipt message exceeds the ${MAX_MESSAGE_BYTES}-byte limit`);
    return;
  }

  // Admission is serialized in the Durable Object before raw buffering or
  // MIME parsing, so rejected deliveries consume negligible Worker memory/CPU.
  const admission = await indexRequest(env, "/admit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytes: message.rawSize }),
  }).then((response) => response.json());
  if (admission.result === "quota_exceeded") {
    message.setReject("Receipt inbox daily intake limit reached");
    return;
  }
  if (admission.result !== "admitted") {
    throw new Error("Receipt inbox admission returned an invalid result");
  }

  // Cloudflare does not promise automatic retries for Email Worker exceptions.
  // Preserve every admitted original at a verified private destination before
  // parsing, R2, or lifecycle checks can fail. No-forward intake skips this:
  // the forwarder already holds the original and is the backstop if storage
  // fails below.
  if (!noForward) {
    await message.forward(env.RECEIPT_FALLBACK_ADDRESS);
  }

  const ready = await readiness(env, { requireFallback: !noForward });
  if (!ready.ready) {
    throw new Error(noForward
      ? "Receipt inbox storage or lifecycle readiness is unavailable"
      : "Receipt inbox storage or lifecycle readiness is unavailable; original forwarded to fallback");
  }

  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    message.setReject(`Receipt message exceeds the ${MAX_MESSAGE_BYTES}-byte limit`);
    return;
  }

  const id = await receiptId(raw, env.RECEIPT_INBOX_IDENTITY_KEY);
  let parsed;
  let parseState = "parsed";
  try {
    parsed = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 10,
      maxHeadersSize: 256 * 1024,
    });
  } catch {
    parsed = { attachments: [] };
    parseState = "failed";
  }

  const attachments = inspectAttachments(parsed.attachments);
  const groupId = await attachmentGroupId(parsed.attachments, env.RECEIPT_INBOX_IDENTITY_KEY);
  const bodyEvidence = Boolean(parsed.text?.trim() || parsed.html?.trim());
  const quarantineReason =
    parseState === "failed"
      ? "mime_parse_failed"
      : attachments.rejectedAttachmentCount > 0
        ? "unsupported_attachment"
        : attachments.supportedAttachmentCount === 0 && !bodyEvidence
          ? "no_supported_evidence"
          : "awaiting_review";
  const receivedAt = new Date().toISOString();
  const rulesReview = classifyReceipt({
    subject: parsed.subject,
    text: typeof parsed.text === "string" ? parsed.text : "",
    senderDomain: senderDomain(message.from),
    receivedAt,
  });
  const { review, classificationSource } = await enrichClassification(rulesReview, env);
  const metadata = {
    id,
    groupId,
    receivedAt,
    senderDomain: senderDomain(message.from),
    senderAuthentication: senderAuthentication(),
    forwardedToFallback: !noForward,
    rawSizeBytes: raw.byteLength,
    attachmentCount: attachments.attachmentCount,
    supportedAttachmentCount: attachments.supportedAttachmentCount,
    bodyEvidence,
    parseState,
    quarantineReason,
    subject: boundedSubject(parsed.subject),
    amountUsd: review.amountUsd,
    service: review.service,
    kind: review.kind,
    calendarSort: review.calendarSort,
    expenseDate: review.expenseDate,
    dueDate: review.dueDate,
    nextDueDate: review.nextDueDate,
    cancelledNoRenew: review.cancelledNoRenew,
    classificationSource,
    classificationAction: review.action,
    label: review.label,
    notes: review.notes,
    calendarTitle: calendarTitle({
      amountUsd: review.amountUsd,
      service: review.service,
      sort: review.calendarSort,
    }),
  };
  const reservation = await indexRequest(env, "/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  }).then((response) => response.json());
  if (reservation.result === "duplicate") return;
  if (reservation.result === "busy") {
    throw new Error("A matching receipt attachment is still being stored; retry later");
  }
  const targetId = reservation.id;
  if (typeof targetId !== "string" || !RECEIPT_ID_PATTERN.test(targetId)) {
    throw new Error("Receipt index returned an invalid reservation ID");
  }
  await storeAndCommitEvidence(env, targetId, raw);
  // Classification is review metadata only.  *@receipts.jays.services accepts
  // any local-part on a public MX, Ignore only flips Durable Object status,
  // and the dashboard form still records cash.  Auto-POSTing
  // confidence:"actual" owner expenses here wrote live spentUsd from
  // unauthenticated mail and double-counted when the owner recorded again.
  return { id: targetId };
}

export async function storeAndCommitEvidence(env, id, raw) {
  await env.RECEIPTS_BUCKET.put(evidenceKey(id), raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
  await indexRequest(env, `/commit/${id}`, { method: "POST" });
}

async function hasValidConfiguration(env, { requireFallback = true } = {}) {
  const structurallyValid = isReceiptInboxAddress(env.RECEIPT_INBOX_ADDRESS)
    && typeof env.RECEIPT_INBOX_IDENTITY_KEY === "string"
    && env.RECEIPT_INBOX_IDENTITY_KEY.length >= 32
    && typeof env.RECEIPT_INBOX_READ_TOKEN === "string"
    && env.RECEIPT_INBOX_READ_TOKEN.length >= 32
    && typeof env.RECEIPT_INBOX_EVIDENCE_TOKEN === "string"
    && env.RECEIPT_INBOX_EVIDENCE_TOKEN.length >= 32
    && (!requireFallback
      || (typeof env.RECEIPT_FALLBACK_ADDRESS === "string"
        && /^[^@\s]+@[^@\s]+$/.test(env.RECEIPT_FALLBACK_ADDRESS)))
    && typeof env.LIFECYCLE_AUDITOR?.fetch === "function"
    && env.RECEIPT_INBOX_RETENTION_ACK === RETENTION_ACK;
  if (!structurallyValid) return false;
  // Operator secret-reuse guard: the read token (exposed via GET /evidence + PATCH
  // /status) must not double as the evidence token, or reusing one secret would grant
  // an unintended combination of read + evidence + status-mutation access. Fail
  // configuration closed rather than silently widening the read token's scope.
  const tokensDistinct = !(await safeTokenEqual(
    env.RECEIPT_INBOX_READ_TOKEN,
    env.RECEIPT_INBOX_EVIDENCE_TOKEN
  ));
  return tokensDistinct;
}

async function readiness(env, { requireFallback = true } = {}) {
  if (!(await hasValidConfiguration(env, { requireFallback }))) return { ready: false, reason: "invalid_configuration" };
  try {
    const lifecycle = await ensureLifecycleAudit(env);
    if (!lifecycle.ok) return { ready: false, reason: "lifecycle_unverified" };
    await Promise.all([
      env.RECEIPTS_BUCKET.list({ prefix: "evidence/", limit: 1 }),
      indexRequest(env, "/ready", { method: "GET" }),
    ]);
    return { ready: true };
  } catch {
    return { ready: false, reason: "storage_unavailable" };
  }
}

export const validateLifecycleRules = validateReceiptLifecycleRules;

async function fetchBoundedJson(response, maxBytes = 64 * 1024) {
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
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function auditLifecycle(env) {
  try {
    const response = await env.LIFECYCLE_AUDITOR.fetch("https://receipt-lifecycle-auditor.internal/audit", {
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await fetchBoundedJson(response);
    return { ok: body?.ok === true, checkedAt: Number(body?.checkedAt) || Date.now() };
  } catch {
    return { ok: false, checkedAt: Date.now() };
  }
}

async function readAuditorStatus(env) {
  const response = await env.LIFECYCLE_AUDITOR.fetch("https://receipt-lifecycle-auditor.internal/status", {
    method: "GET",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await fetchBoundedJson(response);
  if (typeof body?.ok !== "boolean" || !Number.isFinite(body?.checkedAt)) throw new Error("invalid_audit");
  return { ok: body.ok, checkedAt: body.checkedAt };
}

async function ensureLifecycleAudit(env, force = false) {
  let status = await indexRequest(env, "/lifecycle-audit", { method: "GET" }).then((response) => response.json());
  try {
    const scheduled = await readAuditorStatus(env);
    if (scheduled.checkedAt > Number(status.checkedAt || 0)) {
      status = scheduled;
      await indexRequest(env, "/lifecycle-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(status),
      });
    }
  } catch {
    // A still-fresh locally persisted audit remains usable during a transient
    // service-binding failure; stale state below triggers an on-demand audit.
  }
  const age = Date.now() - Number(status.checkedAt || 0);
  const maxAge = status.ok ? LIFECYCLE_AUDIT_MAX_AGE_MS : LIFECYCLE_AUDIT_RETRY_MS;
  if (!force && age >= 0 && age < maxAge) return status;
  const audited = await auditLifecycle(env);
  await indexRequest(env, "/lifecycle-audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(audited),
  });
  return audited;
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    if (
      typeof env.RECEIPT_INBOX_READ_TOKEN !== "string"
      || env.RECEIPT_INBOX_READ_TOKEN.length < 32
      || !await safeTokenEqual(bearerToken(request), env.RECEIPT_INBOX_READ_TOKEN)
    ) return json({ error: "Unauthorized" }, 401);
    const result = await readiness(env);
    return json({ ok: result.ready, status: result.ready ? "ready" : "unavailable", ...(result.reason ? { reason: result.reason } : {}) }, result.ready ? 200 : 503);
  }

  const evidenceMatch = /^\/v1\/receipts\/([0-9a-f]{64})\/evidence$/.exec(url.pathname);
  if (request.method === "GET" && evidenceMatch) {
    if (
      typeof env.RECEIPT_INBOX_EVIDENCE_TOKEN !== "string"
      || env.RECEIPT_INBOX_EVIDENCE_TOKEN.length < 32
      || !await safeTokenEqual(bearerToken(request), env.RECEIPT_INBOX_EVIDENCE_TOKEN)
    ) return json({ error: "Unauthorized" }, 401);
    const id = evidenceMatch[1];
    const availability = await indexStub(env).fetch(`https://receipt-index.internal/evidence/${id}`);
    if (!availability.ok) return json({ error: "Not found" }, 404);
    const object = await env.RECEIPTS_BUCKET.get(evidenceKey(id));
    if (!object) return json({ error: "Not found" }, 404);
    return new Response(object.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="receipt-${id}.eml"`,
        "Content-Type": "message/rfc822",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const statusMatch = /^\/v1\/receipts\/([0-9a-f]{64})\/status$/.exec(url.pathname);
  if (request.method === "PATCH" && statusMatch) {
    if (
      typeof env.RECEIPT_INBOX_EVIDENCE_TOKEN !== "string"
      || env.RECEIPT_INBOX_EVIDENCE_TOKEN.length < 32
      || !await safeTokenEqual(bearerToken(request), env.RECEIPT_INBOX_EVIDENCE_TOKEN)
    ) return json({ error: "Unauthorized" }, 401);
    const body = await request.json().catch(() => null);
    if (!body || !VALID_STATUSES.has(body.status) || body.status === "needs_review") {
      return json({ error: "status must be reviewed or ignored" }, 400);
    }
    const response = await indexRequest(env, `/status/${statusMatch[1]}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: body.status }),
    });
    return json(await response.json());
  }

  if (request.method !== "GET" || url.pathname !== "/v1/receipts/summary") return json({ error: "Not found" }, 404);
  if (
    typeof env.RECEIPT_INBOX_READ_TOKEN !== "string"
    || env.RECEIPT_INBOX_READ_TOKEN.length < 32
    || !await safeTokenEqual(bearerToken(request), env.RECEIPT_INBOX_READ_TOKEN)
  ) return json({ error: "Unauthorized" }, 401);
  const ready = await readiness(env);
  if (!ready.ready) return json({ configured: false, status: "unavailable", error: ready.reason }, 503);
  const response = await indexRequest(env, "/summary", { method: "GET" });
  return json(await response.json());
}

function reverseTimestamp(value) {
  return String(9_999_999_999_999 - Date.parse(value)).padStart(13, "0");
}

function timestampKey(value) {
  return String(Math.max(0, Math.floor(value))).padStart(13, "0");
}

export class ReceiptInboxIndex {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const cleanupBacklog = await this.cleanupExpired(Date.now());
    await this.scheduleNextAlarm(cleanupBacklog);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ready") {
      if (cleanupBacklog) return json({ ready: false, reason: "cleanup_backlog" }, 503);
      await this.state.storage.get("counter:needs_review");
      return json({ ready: true });
    }
    if (url.pathname === "/lifecycle-audit") {
      if (request.method === "GET") {
        return json((await this.state.storage.get("lifecycle:audit")) || { ok: false, checkedAt: 0 });
      }
      if (request.method === "POST") {
        const status = await request.json();
        if (typeof status?.ok !== "boolean" || !Number.isFinite(status?.checkedAt)) {
          return json({ error: "invalid audit" }, 400);
        }
        await this.state.storage.put("lifecycle:audit", { ok: status.ok, checkedAt: status.checkedAt });
        return json({ stored: true });
      }
    }

    if (request.method === "POST" && url.pathname === "/admit") {
      const body = await request.json().catch(() => null);
      const bytes = body?.bytes;
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_MESSAGE_BYTES) {
        return json({ error: "invalid admission" }, 400);
      }
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const dailyKey = `daily:${day}`;
      const result = await this.state.storage.transaction(async (storage) => {
        const daily = await storage.get(dailyKey) || { count: 0, bytes: 0 };
        if (daily.count >= MAX_DAILY_MESSAGES || daily.bytes + bytes > MAX_DAILY_BYTES) {
          return { result: "quota_exceeded" };
        }
        const dailyExpiresAt = Date.parse(`${day}T00:00:00.000Z`) + 2 * 24 * 60 * 60 * 1000;
        await storage.put({
          [dailyKey]: { count: daily.count + 1, bytes: daily.bytes + bytes },
          [`daily-expire:${timestampKey(dailyExpiresAt)}:${day}`]: day,
        });
        return { result: "admitted" };
      });
      await this.scheduleNextAlarm(false);
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/reserve") {
      const metadata = await request.json();
      const result = await this.state.storage.transaction(async (storage) => {
        const exactKey = `dedupe:${metadata.id}`;
        const exact = await storage.get(exactKey);
        if (exact?.status === "committed") return { result: "duplicate", id: exact.id };
        if (exact?.status === "pending") return { result: "reserved", id: exact.id, resumed: true };
        const groupKey = metadata.groupId ? `group:${metadata.groupId}` : null;
        const group = groupKey ? await storage.get(groupKey) : null;
        if (group?.status === "committed") return { result: "duplicate", id: group.id };
        if (group?.status === "pending") return { result: "busy" };
        const pendingKey = `pending:${metadata.id}`;
        const pendingExpiresAt = Date.parse(metadata.receivedAt) + PENDING_RETENTION_MS;
        await storage.put({
          [pendingKey]: { ...metadata, status: "pending" },
          [exactKey]: { id: metadata.id, status: "pending" },
          [`pending-expire:${timestampKey(pendingExpiresAt)}:${metadata.id}`]: metadata.id,
          ...(groupKey ? { [groupKey]: { id: metadata.id, status: "pending" } } : {}),
        });
        return { result: "reserved", id: metadata.id, resumed: false };
      });
      await this.scheduleNextAlarm(false);
      return json(result);
    }

    const commitMatch = /^\/commit\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === "POST" && commitMatch) {
      const id = commitMatch[1];
      const result = await this.state.storage.transaction(async (storage) => {
        const exactKey = `dedupe:${id}`;
        const exact = await storage.get(exactKey);
        if (exact?.status === "committed") return "already_committed";
        const pendingKey = `pending:${id}`;
        const metadata = await storage.get(pendingKey);
        if (!metadata) return "not_found";
        const inboxKey = `inbox:needs_review:${reverseTimestamp(metadata.receivedAt)}:${id}`;
        const expiresAt = Date.parse(metadata.receivedAt) + RETENTION_MS;
        await storage.put({
          [inboxKey]: { ...metadata, status: "needs_review" },
          [exactKey]: { id, status: "committed", key: inboxKey },
          [`expire:${timestampKey(expiresAt)}:${id}`]: id,
          "counter:needs_review": ((await storage.get("counter:needs_review")) || 0) + 1,
          ...(metadata.groupId ? { [`group:${metadata.groupId}`]: { id, status: "committed" } } : {}),
        });
        await storage.delete([
          pendingKey,
          `pending-expire:${timestampKey(Date.parse(metadata.receivedAt) + PENDING_RETENTION_MS)}:${id}`,
        ]);
        return "committed";
      });
      await this.scheduleNextAlarm(false);
      return json({ result }, result === "not_found" ? 404 : 200);
    }

    const evidenceMatch = /^\/evidence\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === "GET" && evidenceMatch) {
      const exact = await this.state.storage.get(`dedupe:${evidenceMatch[1]}`);
      if (exact?.status !== "committed" || typeof exact.key !== "string") {
        return json({ error: "Not found" }, 404);
      }
      const metadata = await this.state.storage.get(exact.key);
      if (!metadata || Date.parse(metadata.receivedAt) + RETENTION_MS <= Date.now()) {
        return json({ error: "Not found" }, 404);
      }
      return json({ available: true });
    }

    const statusMatch = /^\/status\/([0-9a-f]{64})$/.exec(url.pathname);
    if (request.method === "PATCH" && statusMatch) {
      const { status } = await request.json();
      if (!VALID_STATUSES.has(status) || status === "needs_review") return json({ error: "invalid status" }, 400);
      const result = await this.state.storage.transaction(async (storage) => {
        const exactKey = `dedupe:${statusMatch[1]}`;
        const exact = await storage.get(exactKey);
        if (exact?.status !== "committed" || typeof exact.key !== "string") return "not_found";
        const oldKey = exact.key;
        const metadata = await storage.get(oldKey);
        if (!metadata) return "not_found";
        if (metadata.status !== "needs_review") return "already_resolved";
        const newKey = `inbox:${status}:${reverseTimestamp(metadata.receivedAt)}:${metadata.id}`;
        await storage.put({
          [newKey]: { ...metadata, status },
          [exactKey]: { id: metadata.id, status: "committed", key: newKey },
          "counter:needs_review": Math.max(0, ((await storage.get("counter:needs_review")) || 1) - 1),
        });
        await storage.delete(oldKey);
        return "updated";
      });
      return json({ result });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      if (cleanupBacklog) return json({ error: "cleanup_backlog" }, 503);
      const listed = await this.state.storage.list({ prefix: "inbox:needs_review:", limit: MAX_SUMMARY_ITEMS });
      const items = [...listed.values()]
        .filter((item) => Date.parse(item.receivedAt) + RETENTION_MS > Date.now())
        .map((item) => ({
        id: item.id,
        receivedAt: item.receivedAt,
        senderDomain: item.senderDomain,
        senderAuthentication: "unknown",
        rawSizeBytes: item.rawSizeBytes,
        attachmentCount: item.attachmentCount,
        supportedAttachmentCount: item.supportedAttachmentCount,
        bodyEvidence: item.bodyEvidence,
        parseState: item.parseState,
        status: item.status,
        quarantineReason: item.quarantineReason,
        subject: item.subject || "",
        service: item.service || "",
        kind: item.kind || "",
        calendarSort: item.calendarSort || "",
        amountUsd: item.amountUsd ?? null,
        expenseDate: item.expenseDate || null,
        dueDate: item.dueDate || null,
        classificationAction: item.classificationAction || null,
        forwardedToFallback: item.forwardedToFallback !== false,
        }));
      return json({
        configured: true,
        status: "receiving",
        needsReviewCount: (await this.state.storage.get("counter:needs_review")) || 0,
        countIsLowerBound: false,
        latestReceivedAt: items[0]?.receivedAt || null,
        items,
        fetchedAt: new Date().toISOString(),
      });
    }
    return json({ error: "Not found" }, 404);
  }

  async cleanupExpired(now) {
    await this.cleanupPending(now);
    await this.cleanupCommitted(now);
    const dailyExpiries = await this.state.storage.list({
      prefix: "daily-expire:",
      end: `daily-expire:${timestampKey(now)}:\uffff`,
      limit: MAX_EXPIRY_CLEANUP_ITEMS,
    });
    for (const [expiryKey, day] of dailyExpiries) {
      await this.state.storage.delete([expiryKey, `daily:${day}`]);
    }
    const [pending, committed, daily] = await Promise.all([
      this.hasExpired("pending-expire:", now),
      this.hasExpired("expire:", now),
      this.hasExpired("daily-expire:", now),
    ]);
    return pending || committed || daily;
  }

  async hasExpired(prefix, now) {
    const listed = await this.state.storage.list({
      prefix,
      end: `${prefix}${timestampKey(now)}:\uffff`,
      limit: 1,
    });
    return listed.size > 0;
  }

  async scheduleNextAlarm(cleanupBacklog) {
    if (cleanupBacklog) {
      await this.state.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    const candidates = [];
    for (const prefix of ["pending-expire:", "expire:", "daily-expire:"]) {
      const listed = await this.state.storage.list({ prefix, limit: 1 });
      const key = listed.keys().next().value;
      const timestamp = typeof key === "string" ? Number(key.slice(prefix.length, prefix.length + 13)) : NaN;
      if (Number.isFinite(timestamp)) candidates.push(timestamp);
    }
    if (candidates.length > 0) await this.state.storage.setAlarm(Math.max(Date.now(), Math.min(...candidates)));
    else await this.state.storage.deleteAlarm();
  }

  async alarm() {
    const backlog = await this.cleanupExpired(Date.now());
    await this.scheduleNextAlarm(backlog);
  }

  async cleanupPending(now) {
    const expiries = await this.state.storage.list({
      prefix: "pending-expire:",
      end: `pending-expire:${timestampKey(now)}:\uffff`,
      limit: MAX_EXPIRY_CLEANUP_ITEMS,
    });
    for (const [expiryKey, id] of expiries) {
      await this.state.storage.transaction(async (storage) => {
        const pendingKey = `pending:${id}`;
        const metadata = await storage.get(pendingKey);
        if (!metadata) {
          await storage.delete(expiryKey);
          return;
        }
        const exactKey = `dedupe:${id}`;
        const exact = await storage.get(exactKey);
        const groupKey = metadata.groupId ? `group:${metadata.groupId}` : null;
        const group = groupKey ? await storage.get(groupKey) : null;
        await storage.delete([
          expiryKey,
          pendingKey,
          ...(exact?.status === "pending" && exact.id === id ? [exactKey] : []),
          ...(groupKey && group?.status === "pending" && group.id === id ? [groupKey] : []),
        ]);
      });
    }
  }

  async cleanupCommitted(now) {
    const expiries = await this.state.storage.list({
      prefix: "expire:",
      end: `expire:${timestampKey(now)}:\uffff`,
      limit: MAX_EXPIRY_CLEANUP_ITEMS,
    });
    for (const [expiryKey, id] of expiries) {
      await this.state.storage.transaction(async (storage) => {
        const exactKey = `dedupe:${id}`;
        const exact = await storage.get(exactKey);
        if (exact?.status !== "committed" || typeof exact.key !== "string") {
          await storage.delete(expiryKey);
          return;
        }
        const metadata = await storage.get(exact.key);
        const groupKey = metadata?.groupId ? `group:${metadata.groupId}` : null;
        const group = groupKey ? await storage.get(groupKey) : null;
        await storage.delete([
          expiryKey,
          exact.key,
          exactKey,
          ...(groupKey && group?.id === id ? [groupKey] : []),
        ]);
        if (metadata?.status === "needs_review") {
          await storage.put(
            "counter:needs_review",
            Math.max(0, ((await storage.get("counter:needs_review")) || 1) - 1),
          );
        }
      });
    }
  }
}

const worker = { email: handleEmail, fetch: handleFetch };
export default worker;
