import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findUnique = vi.fn();
const recordProviderUsage = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { provider: { findUnique: (args: unknown) => findUnique(args) } },
}));

vi.mock("@/lib/usage-recorder", () => ({
  recordProviderUsage: (provider: unknown) => recordProviderUsage(provider),
}));

describe("POST /api/providers/:id/fetch", () => {
  beforeEach(() => {
    findUnique.mockReset();
    recordProviderUsage.mockReset();
  });

  it("returns a successful no-op for generic manual providers", async () => {
    findUnique.mockResolvedValue({
      id: "manual-1",
      name: "bookkeeping-only",
      type: "generic",
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("https://usage.jays.services/api/providers/manual-1/fetch", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "manual-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: true,
      reason: "manual_provider",
    });
    expect(recordProviderUsage).not.toHaveBeenCalled();
  });

  it("returns a successful no-op for push/manual built-ins", async () => {
    findUnique.mockResolvedValue({
      id: "fmp-1",
      name: "fmp",
      type: "builtin",
    });
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("https://usage.jays.services/api/providers/fmp-1/fetch", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "fmp-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: true,
      reason: "manual_provider",
    });
    expect(recordProviderUsage).not.toHaveBeenCalled();
  });
});
