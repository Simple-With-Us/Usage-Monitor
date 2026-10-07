import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetHandlers, type BudgetHttpLedger } from "../http";
import { FleetBudgetError } from "../ledger";
import { POLICY } from "./fixture";

vi.mock("server-only", () => ({}));

const TOKEN = "synthetic-test-only-budget-client-value";
let env: Record<string, string | undefined>;
const methods = {
  reserve: vi.fn<BudgetHttpLedger["reserve"]>(), dispatch: vi.fn<BudgetHttpLedger["dispatch"]>(),
  cancel: vi.fn<BudgetHttpLedger["cancel"]>(), reconcile: vi.fn<BudgetHttpLedger["reconcile"]>(), status: vi.fn<BudgetHttpLedger["status"]>(),
} satisfies BudgetHttpLedger;
const handlers = budgetHandlers(methods, () => env);
const RESERVED: Awaited<ReturnType<BudgetHttpLedger["reserve"]>> = {
  reservationId: "synthetic-id", requestId: "one", day: "2026-10-06", provider: "deepseek", model: "synthetic",
  reason: "below_soft_limit", status: "reserved", maximumCostMicros: "1000", reservedPolicyMicros: "1000",
  estimatedCostMicros: null, providerReportedCostMicros: null, costBasis: "server_priced_producer_usage",
  providerReportedCostVerified: false, dispatchBefore: "2026-10-06T20:01:00Z",
};
const STATUS: Awaited<ReturnType<BudgetHttpLedger["status"]>> = {
  day: "2026-10-06", timeZone: "America/Chicago", configured: false, settledPolicyMicros: "0", reservedPolicyMicros: "0",
  estimatedDeepSeekMicros: "0", estimatedMiniMaxMicros: "0", softLimitMicros: null, hardLimitMicros: null,
  blocked: false, globalBlockedAt: null, estimatesAreCash: false, providerCosts: [],
};
function request(body: unknown, token = TOKEN) {
  return new NextRequest("http://localhost/api/ingest/fleet-budget", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const reserve = { action: "reserve", requestId: "one", maxInputTokens: 100, maxOutputTokens: 10 };
beforeEach(() => {
  vi.resetAllMocks();
  env = { FLEET_BUDGET_ENABLED: "true", FLEET_BUDGET_ADMISSION_ENABLED: "true",
    FLEET_BUDGET_POLICY_JSON: JSON.stringify(POLICY),
    FLEET_BUDGET_CLIENT_TOKENS: JSON.stringify([{ id: "repo-a", token: TOKEN }]),
  };
  methods.reserve.mockResolvedValue(RESERVED);
  methods.dispatch.mockResolvedValue({ ...RESERVED, status: "dispatched", dispatchAllowed: true });
  methods.cancel.mockResolvedValue({ ...RESERVED, status: "cancelled" });
  methods.reconcile.mockResolvedValue({ ...RESERVED, status: "settled" });
  methods.status.mockResolvedValue(STATUS);
});

describe("default-disabled dedicated fleet budget API", () => {
  it("is default off and performs no ledger operations", async () => {
    env = {};
    const response = await handlers.POST(request(reserve));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "disabled" }, dispatchAllowed: false });
    expect(methods.reserve).not.toHaveBeenCalled();
    expect((await handlers.GET(request(reserve))).status).toBe(503);
    expect(methods.status).not.toHaveBeenCalled();
  });
  it("accepts only dedicated server-bound identity, never caller identity", async () => {
    const response = await handlers.POST(request(reserve));
    expect(response.status).toBe(200);
    expect(methods.reserve).toHaveBeenCalledWith("repo-a", { requestId: "one", maxInputTokens: 100, maxOutputTokens: 10, route: "primary" }, POLICY);
    expect((await handlers.POST(request({ ...reserve, clientId: "other-repo" }))).status).toBe(400);
  });
  it("never turns a reservation replay into dispatch permission", async () => {
    expect(await (await handlers.POST(request(reserve))).json()).toMatchObject({ dispatchAllowed: false });
    expect(await (await handlers.POST(request({ action: "dispatch", requestId: "one" }))).json()).toMatchObject({ dispatchAllowed: true });
    expect(methods.dispatch).toHaveBeenCalledWith("repo-a", "one");
  });
  it("rejects invalid auth before reading malformed input", async () => {
    const response = await handlers.POST(new NextRequest("http://localhost/api/ingest/fleet-budget", { method: "POST", body: "not-json" }));
    expect(response.status).toBe(401);
    expect(methods.reserve).not.toHaveBeenCalled();
  });
  it("does not inherit read tokens, ingest tokens, sessions or malformed token maps", async () => {
    delete env.FLEET_BUDGET_CLIENT_TOKENS;
    env.USAGE_INGEST_TOKEN = TOKEN; env.USAGE_READ_TOKEN = TOKEN;
    expect((await handlers.POST(request(reserve))).status).toBe(401);
    for (const raw of ["not-json", JSON.stringify([{ id: "a", token: TOKEN }, { id: "b", token: TOKEN }]), JSON.stringify([{ id: "a", token: TOKEN }, { id: "a", token: TOKEN + "x" }])]) {
      env.FLEET_BUDGET_CLIENT_TOKENS = raw;
      expect((await handlers.POST(request(reserve))).status).toBe(401);
    }
  });
  it("allows settlement/cancellation while the admission kill switch is off", async () => {
    env.FLEET_BUDGET_ADMISSION_ENABLED = "false";
    expect((await handlers.POST(request(reserve))).status).toBe(503);
    expect((await handlers.POST(request({ action: "dispatch", requestId: "one" }))).status).toBe(503);
    expect((await handlers.POST(request({ action: "reconcile", requestId: "one", usage: null }))).status).toBe(200);
    expect((await handlers.POST(request({ action: "cancel", requestId: "one" }))).status).toBe(200);
    expect(methods.reserve).not.toHaveBeenCalled();
    expect(methods.dispatch).not.toHaveBeenCalled();
  });
  it("requires explicit pricing and refuses oversized, invalid or extra payloads", async () => {
    delete env.FLEET_BUDGET_POLICY_JSON;
    expect((await handlers.POST(request(reserve))).status).toBe(503);
    expect((await handlers.POST(request({ ...reserve, prompt: "private" }))).status).toBe(400);
    expect((await handlers.POST(request({ ...reserve, maxInputTokens: -1 }))).status).toBe(400);
    expect((await handlers.POST(request({ ...reserve, extra: "x".repeat(5000) }))).status).toBe(413);
    expect((await handlers.POST(request({ action: "reconcile", requestId: "one", usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 } }))).status).toBe(400);
  });
  it("returns typed failures with no raw database/config/token disclosure", async () => {
    methods.reserve.mockRejectedValue(new Error("sensitive raw query or connection details"));
    const response = await handlers.POST(request(reserve));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: { code: "ledger_unavailable" }, dispatchAllowed: false });
    methods.reserve.mockRejectedValue(new FleetBudgetError("conflict"));
    expect((await handlers.POST(request(reserve))).status).toBe(409);
    methods.reserve.mockRejectedValue(new FleetBudgetError("not_found"));
    expect((await handlers.POST(request(reserve))).status).toBe(404);
  });
  it("marks status as uncached and cannot leak another request's data", async () => {
    const response = await handlers.GET(request(reserve));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-api-version")).toBe("1");
    expect(await response.json()).toEqual({ ok: true, ...STATUS });
  });
});
