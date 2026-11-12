import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isPublicPath } from "@/middleware";
import { BUDGET_VIEW } from "@/lib/fleet-budget/__tests__/view-fixture";
const mock = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/fleet-budget/ledger", () => ({ FleetBudgetLedger: class { status = mock.status; } }));
import { GET } from "../route";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T20:00:00.000Z"));
  vi.stubEnv("SESSION_SECRET", "synthetic-budget-status-session-secret");
  vi.stubEnv("FLEET_BUDGET_ENABLED", "false");
  vi.stubEnv("FLEET_BUDGET_ADMISSION_ENABLED", "false");
  mock.status.mockReset().mockResolvedValue(BUDGET_VIEW.snapshot);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const request = (headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/fleet-budget-status", { headers });
const session = () => request({ cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` });
describe("session-only fleet budget monitor", () => {
  it("stays behind middleware and rejects missing/invalid sessions before DB reads", async () => {
    expect(isPublicPath("/api/fleet-budget-status")).toBe(false);
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({ cookie: `${SESSION_COOKIE_NAME}=invalid` }))).status).toBe(401);
    expect(mock.status).not.toHaveBeenCalled();
  });
  it("does not accept existing or dedicated bearer tokens", async () => {
    vi.stubEnv("USAGE_READ_TOKEN", "synthetic-read");
    vi.stubEnv("USAGE_INGEST_TOKEN", "synthetic-ingest");
    vi.stubEnv("FLEET_BUDGET_CLIENT_TOKENS", JSON.stringify([{ id: "test", token: "synthetic-dedicated-budget-client-token" }]));
    for (const token of ["synthetic-read", "synthetic-ingest", "synthetic-dedicated-budget-client-token"]) {
      expect((await GET(request({ authorization: `Bearer ${token}` }))).status).toBe(401);
    }
    expect(mock.status).not.toHaveBeenCalled();
  });
  it("reads outstanding costs with the service off and exposes no secret config", async () => {
    const response = await GET(session());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(BUDGET_VIEW);
    expect(mock.status).toHaveBeenCalledTimes(1);
  });
  it("reports enabled admission only when both existing flags are on", async () => {
    vi.stubEnv("FLEET_BUDGET_ADMISSION_ENABLED", "true");
    expect((await (await GET(session())).json()).admissionEnabled).toBe(false);
    vi.stubEnv("FLEET_BUDGET_ENABLED", "true");
    expect((await (await GET(session())).json()).admissionEnabled).toBe(true);
  });
  it("fails without exposing raw errors or fabricated zero values", async () => {
    mock.status.mockRejectedValue(new Error("private database/config details"));
    const response = await GET(session());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Fleet budget status unavailable" });
  });
});
