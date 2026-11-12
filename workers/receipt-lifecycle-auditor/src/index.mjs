import { validateReceiptLifecycleRules } from "../../receipt-lifecycle.mjs";
import { guardOff, guardOffResponse } from "./budget-guard.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const AUDIT_TIMEOUT_MS = 8_000;
const AUDIT_STATE_NAME = "receipt-lifecycle-audit-v1";
const AUDIT_STATE_PATH = "/status";

function genericAuditFailure() {
  return { ok: false, checkedAt: Date.now() };
}

function isAudit(value) {
  return value
    && typeof value.ok === "boolean"
    && Number.isFinite(value.checkedAt)
    && value.checkedAt >= 0;
}

export async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("response_too_large");
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

export async function auditReceiptLifecycle(env) {
  const checkedAt = Date.now();
  try {
    if (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || "")) throw new Error("invalid_account");
    if (typeof env.RECEIPT_LIFECYCLE_AUDIT_TOKEN !== "string" || env.RECEIPT_LIFECYCLE_AUDIT_TOKEN.length < 32) {
      throw new Error("invalid_token");
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/usage-monitor-receipts/lifecycle`,
      {
        headers: {
          Authorization: `Bearer ${env.RECEIPT_LIFECYCLE_AUDIT_TOKEN}`,
          Accept: "application/json",
        },
        // Workers fetch does not implement redirect:"error"; use manual and fail on 3xx.
        redirect: "manual",
        signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
      },
    );
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`lifecycle_api_redirect:${response.status}`);
    }
    if (!response.ok) throw new Error(`lifecycle_api_failure:${response.status}`);

    const body = await readBoundedJson(response);
    return {
      ok: body?.success === true && validateReceiptLifecycleRules(body?.result?.rules),
      checkedAt,
    };
  } catch {
    return { ok: false, checkedAt };
  }
}

function auditStateStub(env) {
  return env.AUDIT_STATE.get(env.AUDIT_STATE.idFromName(AUDIT_STATE_NAME));
}

export async function persistAudit(env, audit) {
  if (!isAudit(audit)) throw new Error("invalid_audit");
  const response = await auditStateStub(env).fetch(`https://receipt-lifecycle-auditor.internal${AUDIT_STATE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(audit),
  });
  if (!response.ok) throw new Error("audit_state_failure");
}

export async function auditAndPersist(env) {
  const audit = await auditReceiptLifecycle(env);
  try {
    await persistAudit(env, audit);
    return audit;
  } catch {
    return genericAuditFailure();
  }
}

export class LifecycleAuditState {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === AUDIT_STATE_PATH) {
      const audit = await this.state.storage.get("audit");
      return Response.json(isAudit(audit) ? audit : genericAuditFailure());
    }

    if (request.method === "POST" && url.pathname === AUDIT_STATE_PATH) {
      let audit;
      try {
        audit = await request.json();
      } catch {
        return Response.json({ error: "Invalid audit state" }, { status: 400 });
      }
      if (!isAudit(audit)) return Response.json({ error: "Invalid audit state" }, { status: 400 });
      await this.state.storage.put("audit", audit);
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

async function handleFetch(request, env) {
  if (guardOff(env)) return guardOffResponse();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/status") {
    const response = await auditStateStub(env).fetch(`https://receipt-lifecycle-auditor.internal${AUDIT_STATE_PATH}`);
    if (!response.ok) return Response.json(genericAuditFailure(), { status: 503 });
    return new Response(response.body, {
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (request.method !== "POST" || url.pathname !== "/audit") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const audit = await auditAndPersist(env);
  return Response.json(audit, {
    status: audit.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function handleScheduled(_controller, env, context) {
  if (guardOff(env)) return;
  context.waitUntil(auditAndPersist(env));
}

export default { fetch: handleFetch, scheduled: handleScheduled };
