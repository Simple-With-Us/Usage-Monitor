import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJsonBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import { getLoginBackstopKey, getNamedRateLimiter, type RateLimiter } from "@/lib/rate-limit";
import { FleetBudgetError, type FleetBudgetLedger } from "./ledger";
import { policySchema, requestSchema, usageSchema } from "./policy";

const clientSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  token: z.string().min(32).max(256),
}).strict()).min(1).max(100).refine((clients) => new Set(clients.map((c) => c.id)).size === clients.length
  && new Set(clients.map((c) => c.token)).size === clients.length);
const requestId = requestSchema.shape.requestId;
const commandSchema = z.discriminatedUnion("action", [
  requestSchema.extend({ action: z.literal("reserve") }),
  z.object({ action: z.literal("dispatch"), requestId }).strict(),
  z.object({ action: z.literal("cancel"), requestId }).strict(),
  z.object({ action: z.literal("reconcile"), requestId, usage: usageSchema.nullable() }).strict(),
]);

type Env = Record<string, string | undefined>;
export type BudgetHttpLedger = Pick<FleetBudgetLedger, "reserve" | "dispatch" | "cancel" | "reconcile" | "status">;
type BudgetRateLimits = { unauthenticated: RateLimiter; identity: RateLimiter };
const defaultRateLimits: BudgetRateLimits = {
  unauthenticated: getNamedRateLimiter("fleet-budget-unauthenticated", 1_000, 10),
  identity: getNamedRateLimiter("fleet-budget-identity", 1_000, 10),
};
function clientIdentity(request: NextRequest, env: Env): string | null {
  const raw = env.FLEET_BUDGET_CLIENT_TOKENS;
  if (!raw || raw.length > 40_000) return null;
  let parsed;
  try { parsed = clientSchema.safeParse(JSON.parse(raw)); } catch { return null; }
  if (!parsed.success) return null;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 263) return null;
  const actual = Buffer.from(header.slice(7));
  for (const client of parsed.data) {
    const expected = Buffer.from(client.token);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return client.id;
  }
  return null;
}
function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "cache-control": "no-store", "x-api-version": "1" } });
}
function failure(code: string, status: number) {
  return json({ ok: false, error: { code }, dispatchAllowed: false }, status);
}

/** Injected dependencies keep the contract testable without credentials or a network. */
export function budgetHandlers(ledger: BudgetHttpLedger, env: () => Env = () => process.env, limits: BudgetRateLimits = defaultRateLimits) {
  function rateLimited() {
    const response = failure("rate_limited", 429);
    response.headers.set("retry-after", "1");
    return response;
  }
  function authenticate(request: NextRequest): string | NextResponse {
    if (env().FLEET_BUDGET_ENABLED !== "true") return failure("disabled", 503);
    // Bound invalid-token work before parsing the credential map.  Successful
    // requests use stable server-owned identity, not shared proxy egress or a
    // caller-supplied key.  This is process-local load shedding, not the cap.
    const source = getLoginBackstopKey(request);
    if (!limits.unauthenticated.isAllowed(source)) return rateLimited();
    const client = clientIdentity(request, env());
    if (!client) {
      limits.unauthenticated.recordAttempt(source);
      return failure("unauthorized", 401);
    }
    if (!limits.identity.check(`fleet-client:${client}`)) return rateLimited();
    // These are trusted gateway/settlement identities, not ordinary ingest
    // producers, users or model inputs.  They can intentionally fail closed
    // for the fleet when reporting a real overrun.  Dedicated identities only: no dashboard session, legacy ingest token,
    // read token, request-supplied identity, or per-repository ledger key.
    return client;
  }
  return {
    async GET(request: NextRequest) {
      const client = authenticate(request);
      if (typeof client !== "string") return client;
      try { return json({ ok: true, ...(await ledger.status()) }); }
      catch { return failure("ledger_unavailable", 503); }
    },
    async POST(request: NextRequest) {
      const client = authenticate(request);
      if (typeof client !== "string") return client;
      try {
        const parsed = commandSchema.safeParse(await readBoundedJsonBody(request, { maxBytes: 4096, label: "Fleet budget request" }));
        if (!parsed.success) return failure("invalid_request", 400);
        const command = parsed.data;
        let result;
        if (command.action === "reserve" || command.action === "dispatch") {
          // Stop new work independently of settlement.  Turning off admission
          // never releases an outstanding reservation or erases real usage.
          if (env().FLEET_BUDGET_ADMISSION_ENABLED !== "true") return failure("admission_disabled", 503);
        }
        if (command.action === "reserve") {
          let policy;
          try { policy = policySchema.safeParse(JSON.parse(env().FLEET_BUDGET_POLICY_JSON ?? "null")); }
          catch { return failure("policy_unavailable", 503); }
          if (!policy.success) return failure("policy_unavailable", 503);
          const { action: _action, ...input } = command;
          void _action;
          result = await ledger.reserve(client, input, policy.data);
        } else if (command.action === "dispatch") {
          result = await ledger.dispatch(client, command.requestId);
        } else if (command.action === "cancel") {
          result = await ledger.cancel(client, command.requestId);
        } else {
          result = await ledger.reconcile(client, command.requestId, command.usage);
        }
        return json({ ok: true, dispatchAllowed: false, ...result });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return failure("body_too_large", 413);
        if (error instanceof SyntaxError) return failure("invalid_request", 400);
        if (error instanceof FleetBudgetError) {
          const status = error.code === "invalid_request" ? 400 : error.code === "not_found" ? 404
            : error.code === "pricing_unavailable" || error.code === "ledger_unavailable" ? 503 : 409;
          return failure(error.code, status);
        }
        // Never serialize raw Prisma errors, policy config, tokens or payloads.
        return failure("ledger_unavailable", 503);
      }
    },
  };
}
