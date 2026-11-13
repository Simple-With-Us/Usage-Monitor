import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, checkFleetTarget, FLEET_TARGETS } from "../route";

describe("GET /api/health/fleet", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defines all critical fleet targets", () => {
    expect(FLEET_TARGETS.length).toBeGreaterThan(5);
    const names = FLEET_TARGETS.map((t) => t.name);
    expect(names).toContain("Socratic.Trade");
    expect(names).toContain("Congress.Trade");
    expect(names).toContain("BotFleet Web");
    expect(names).toContain("DealDex");
  });

  it("returns 200 healthy when all targets succeed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    }) as any;

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
    expect(body.passingCount).toBe(FLEET_TARGETS.length);
    expect(body.failedCount).toBe(0);
  });

  it("returns 503 unhealthy when a critical target fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("socratictrade")) {
        return Promise.reject(new Error("Connection refused"));
      }
      return Promise.resolve({
        status: 200,
        ok: true,
      });
    }) as any;

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("unhealthy");
    expect(body.criticalFailedCount).toBe(1);
    expect(body.failures[0].name).toBe("Socratic.Trade");
  });

  it("handles non-critical target degradation gracefully", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("polling")) {
        return Promise.resolve({
          status: 503,
          ok: false,
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
      });
    }) as any;

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("degraded");
    expect(body.failedCount).toBe(1);
    expect(body.criticalFailedCount).toBe(0);
  });
});
