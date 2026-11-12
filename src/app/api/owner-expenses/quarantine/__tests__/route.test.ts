import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  resolve: vi.fn(),
  hasValidDashboardSession: vi.fn(),
  isCsrfSafeRequest: vi.fn(),
  shouldEnforceDashboardSession: vi.fn(),
  isUsageReadAuthorized: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    quarantinedOwnerExpense: { findMany: mocks.findMany },
  },
}));

vi.mock("@/lib/auth", () => ({
  hasValidDashboardSession: mocks.hasValidDashboardSession,
  isCsrfSafeRequest: mocks.isCsrfSafeRequest,
  shouldEnforceDashboardSession: mocks.shouldEnforceDashboardSession,
}));

vi.mock("@/lib/ingest-auth", () => ({
  isUsageReadAuthorized: mocks.isUsageReadAuthorized,
}));

vi.mock("@/lib/owner-expense", () => ({
  resolveQuarantinedOwnerExpense: mocks.resolve,
}));

let GET: typeof import("../route").GET;
let POST: typeof import("../route").POST;

beforeEach(async () => {
  if (!GET) ({ GET, POST } = await import("../route"));
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.resolve.mockReset().mockResolvedValue({ status: "posted" });
  mocks.hasValidDashboardSession.mockReset().mockReturnValue(false);
  mocks.isCsrfSafeRequest.mockReset().mockReturnValue(true);
  mocks.shouldEnforceDashboardSession.mockReset().mockReturnValue(true);
  mocks.isUsageReadAuthorized.mockReset().mockReturnValue(false);
});

function getRequest(): NextRequest {
  return new NextRequest("https://usage.jays.services/api/owner-expenses/quarantine", {
    method: "GET",
  });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://usage.jays.services/api/owner-expenses/quarantine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const heldRow = {
  id: "11111111-2222-3333-4444-555555555555",
  quarantinedAt: new Date("2026-10-16T08:00:00.000Z"),
  provider: "Anthropic",
  amountUsd: 213.2,
  occurredAt: new Date("2026-10-06T12:00:00.000Z"),
  kind: "subscription",
  label: "Fwd: Receipt from Anthropic",
  notes: null,
  confidence: "actual",
  receiptInboxId: "b".repeat(64),
  matchedEntries: JSON.stringify([
    {
      idempotencyKey: "owner-recorded-expense:v1:abc",
      provider: "Anthropic",
      amountUsd: 213.2,
      occurredAt: "2026-10-06T12:00:00.000Z",
      label: "Anthropic Max plan - 20x",
      matchedOn: "vendor_amount_near_date",
    },
  ]),
  matchReason: "Same vendor and amount posted within 3 days of the charge date.",
};

describe("GET /api/owner-expenses/quarantine", () => {
  it("401s with no session and no read token", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("lists held items for a dashboard session", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    mocks.findMany.mockResolvedValue([heldRow]);
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quarantined).toHaveLength(1);
    expect(body.quarantined[0]).toMatchObject({
      id: heldRow.id,
      provider: "Anthropic",
      amountUsd: 213.2,
      matchReason: expect.stringContaining("within 3 days"),
    });
    expect(body.quarantined[0].matchedEntries).toHaveLength(1);
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("held");
  });
});

describe("POST /api/owner-expenses/quarantine", () => {
  const body = { id: heldRow.id, action: "post" as const };

  it("401s without a dashboard session", async () => {
    const response = await POST(postRequest(body));
    expect(response.status).toBe(401);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("403s a cross-site cookie request (CSRF guard)", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    mocks.isCsrfSafeRequest.mockReturnValue(false);
    const response = await POST(postRequest(body));
    expect(response.status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    const response = await POST(postRequest({ id: "nope", action: "post" }));
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("400s on an unknown action", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    const response = await POST(postRequest({ id: heldRow.id, action: "merge" }));
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("400s on unexpected extra keys (strict schema)", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    const response = await POST(
      postRequest({ id: heldRow.id, action: "post", force: true })
    );
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("posts a held item on post-anyway", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ status: "posted", record: { persisted: 1 } });
    const response = await POST(postRequest(body));
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(heldRow.id, "post");
    const responseBody = await response.json();
    expect(responseBody.status).toBe("posted");
  });

  it("discards a held item without posting", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ status: "discarded" });
    const response = await POST(
      postRequest({ id: heldRow.id, action: "discard" })
    );
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(heldRow.id, "discard");
  });

  it("404s when the item is already resolved", async () => {
    mocks.hasValidDashboardSession.mockReturnValue(true);
    mocks.resolve.mockRejectedValue(new Error("Quarantined expense not found or already resolved"));
    const response = await POST(postRequest(body));
    expect(response.status).toBe(404);
  });
});
