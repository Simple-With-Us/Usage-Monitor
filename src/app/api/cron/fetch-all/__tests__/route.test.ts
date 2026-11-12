import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchAllDueProviders = vi.hoisted(() => vi.fn());
const runUsageMaintenance = vi.hoisted(() => vi.fn());

vi.mock("@/lib/usage-recorder", () => ({ fetchAllDueProviders }));
vi.mock("@/lib/usage-maintenance", () => ({ runUsageMaintenance }));

import { GET } from "../route";

const REAL_SECRET = "correct-cron-secret";

function requestWithSecret(secret: string | undefined): NextRequest {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers["x-cron-secret"] = secret;
  return new NextRequest("https://usage.jays.services/api/cron/fetch-all", {
    headers,
  });
}

describe("GET /api/cron/fetch-all", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = REAL_SECRET;
    fetchAllDueProviders.mockResolvedValue({ ok: true });
    runUsageMaintenance.mockResolvedValue({ ranAt: "now" });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    vi.clearAllMocks();
  });

  it("returns 401 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(requestWithSecret(REAL_SECRET));
    expect(res.status).toBe(401);
    expect(fetchAllDueProviders).not.toHaveBeenCalled();
  });

  it("returns 401 when no secret header is sent", async () => {
    const res = await GET(requestWithSecret(undefined));
    expect(res.status).toBe(401);
    expect(fetchAllDueProviders).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret of the same length", async () => {
    const wrongSameLength = "x".repeat(REAL_SECRET.length);
    const res = await GET(requestWithSecret(wrongSameLength));
    expect(res.status).toBe(401);
    expect(fetchAllDueProviders).not.toHaveBeenCalled();
  });

  it("returns 401 for a shorter candidate secret without throwing", async () => {
    // Regression guard: timingSafeEqual throws on mismatched buffer lengths.
    // Hashing both sides first (see route.ts) must absorb any length
    // difference instead of letting that throw escape as a 500.
    const res = await GET(requestWithSecret("short"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a longer candidate secret without throwing", async () => {
    const res = await GET(requestWithSecret(REAL_SECRET + "-extra-suffix"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for an empty candidate secret", async () => {
    const res = await GET(requestWithSecret(""));
    expect(res.status).toBe(401);
  });

  it("authorizes and runs the fetch when the secret matches exactly", async () => {
    const res = await GET(requestWithSecret(REAL_SECRET));
    expect(res.status).toBe(200);
    expect(fetchAllDueProviders).toHaveBeenCalledTimes(1);
    expect(runUsageMaintenance).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, maintenance: { ranAt: "now" } });
  });
});
