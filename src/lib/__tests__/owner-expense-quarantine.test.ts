import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The module under test is imported dynamically in beforeAll, matching the
// pattern route.test.ts uses for modules with mocked dependencies.
let parseOwnerExpenseInput: typeof import("../owner-expense").parseOwnerExpenseInput;
let recordOwnerExpense: typeof import("../owner-expense").recordOwnerExpense;
let resolveQuarantinedOwnerExpense: typeof import("../owner-expense").resolveQuarantinedOwnerExpense;

beforeAll(async () => {
  ({
    parseOwnerExpenseInput,
    recordOwnerExpense,
    resolveQuarantinedOwnerExpense,
  } = await import("../owner-expense"));
});

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  quarantineCreate: vi.fn(),
  quarantineFindUnique: vi.fn(),
  quarantineUpdate: vi.fn(),
  persistExternalUsageEvents: vi.fn(),
  bustBudgetStatusCache: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
    },
    quarantinedOwnerExpense: {
      create: mocks.quarantineCreate,
      findUnique: mocks.quarantineFindUnique,
      update: mocks.quarantineUpdate,
    },
  },
}));

vi.mock("@/lib/external-usage-events", () => ({
  persistExternalUsageEvents: mocks.persistExternalUsageEvents,
}));

vi.mock("@/lib/budget-status", () => ({
  bustBudgetStatusCache: mocks.bustBudgetStatusCache,
}));

beforeEach(() => {
  mocks.findUnique.mockReset().mockResolvedValue(null);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.quarantineCreate.mockReset().mockResolvedValue({ id: "q-1" });
  mocks.quarantineFindUnique.mockReset().mockResolvedValue(null);
  mocks.quarantineUpdate.mockReset().mockResolvedValue({});
  mocks.persistExternalUsageEvents.mockReset().mockResolvedValue({ persisted: 1 });
  mocks.bustBudgetStatusCache.mockReset();
});

function baseInput() {
  return parseOwnerExpenseInput({
    provider: "Anthropic",
    amountUsd: 213.2,
    occurredAt: "2026-10-06T12:00:00.000Z",
    kind: "subscription",
    label: "Anthropic Max 20x Oct 6",
  });
}

function postedRow(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "owner-recorded-expense:v1:already-posted",
    provider: "Anthropic",
    costUsd: 213.2,
    occurredAt: new Date("2026-10-06T12:00:00.000Z"),
    label: "Anthropic Max plan - 20x",
    metadata: { ownerRecorded: true, kind: "subscription" },
    ...overrides,
  };
}

describe("recordOwnerExpense duplicate quarantine", () => {
  it("posts a non-duplicate normally", async () => {
    const result = await recordOwnerExpense(baseInput());
    expect(result.persisted).toBe(1);
    expect(result.quarantined).toBeUndefined();
    expect(mocks.persistExternalUsageEvents).toHaveBeenCalledTimes(1);
    expect(mocks.quarantineCreate).not.toHaveBeenCalled();
  });

  it("holds an exact duplicate for review instead of posting", async () => {
    mocks.findMany.mockResolvedValue([postedRow()]);
    const result = await recordOwnerExpense(baseInput());
    expect(result.persisted).toBe(0);
    expect(result.quarantined).toBe(true);
    expect(result.quarantineId).toBe("q-1");
    expect(result.matchReason).toContain("Anthropic");
    expect(result.matchedEntries).toHaveLength(1);
    expect(result.matchedEntries?.[0].matchedOn).toBe("vendor_amount_date");
    expect(mocks.persistExternalUsageEvents).not.toHaveBeenCalled();
    expect(mocks.quarantineCreate).toHaveBeenCalledTimes(1);
    const created = mocks.quarantineCreate.mock.calls[0][0].data;
    expect(created.provider).toBe("Anthropic");
    expect(created.amountUsd).toBe(213.2);
    expect(created.matchReason).toContain("already posted");
    expect(JSON.parse(created.matchedEntries)).toHaveLength(1);
  });

  it("holds an agent-forwarded archival copy (inbox id, skewed date)", async () => {
    mocks.findMany.mockResolvedValue([postedRow()]);
    const forwarded = parseOwnerExpenseInput({
      provider: "Anthropic",
      amountUsd: 213.2,
      occurredAt: "2026-10-08T12:00:00.000Z",
      kind: "subscription",
      label: "Fwd: Receipt from Anthropic",
      receiptInboxId: "b".repeat(64),
    });
    const result = await recordOwnerExpense(forwarded);
    expect(result.quarantined).toBe(true);
    expect(result.matchedEntries?.[0].matchedOn).toBe("vendor_amount_near_date");
    expect(result.matchReason).toContain("archival copy");
    expect(mocks.persistExternalUsageEvents).not.toHaveBeenCalled();
  });

  it("does not quarantine a true idempotency-key replay", async () => {
    mocks.findUnique.mockResolvedValue({ idempotencyKey: "k" });
    const result = await recordOwnerExpense(baseInput());
    expect(result.persisted).toBe(0);
    expect(result.quarantined).toBeUndefined();
    expect(mocks.quarantineCreate).not.toHaveBeenCalled();
    expect(mocks.persistExternalUsageEvents).not.toHaveBeenCalled();
  });

  it("force:true bypasses the quarantine (owner post-anyway)", async () => {
    mocks.findMany.mockResolvedValue([postedRow()]);
    const result = await recordOwnerExpense(baseInput(), { force: true });
    expect(result.persisted).toBe(1);
    expect(result.quarantined).toBeUndefined();
    expect(mocks.quarantineCreate).not.toHaveBeenCalled();
  });

  it("scopes the duplicate scan to owner-recorded expenses in a bounded window", async () => {
    await recordOwnerExpense(baseInput());
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.sourceApp).toBe("owner-recorded-expense");
    expect(where.occurredAt.gte).toEqual(new Date("2026-09-29T00:00:00.000Z"));
    expect(where.occurredAt.lt).toEqual(new Date("2026-10-14T00:00:00.000Z"));
  });

  it("lifts the date bound when checking by receipt inbox id", async () => {
    const withInboxId = parseOwnerExpenseInput({
      provider: "Anthropic",
      amountUsd: 213.2,
      occurredAt: "2026-10-06T12:00:00.000Z",
      kind: "subscription",
      label: "Anthropic receipt",
      receiptInboxId: "c".repeat(64),
    });
    await recordOwnerExpense(withInboxId);
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.sourceApp).toBe("owner-recorded-expense");
    expect(where.occurredAt).toBeUndefined();
  });
});

describe("resolveQuarantinedOwnerExpense", () => {
  const heldRow = {
    id: "q-1",
    status: "held",
    provider: "Anthropic",
    amountUsd: 213.2,
    occurredAt: new Date("2026-10-06T12:00:00.000Z"),
    kind: "subscription",
    label: "Anthropic Max 20x Oct 6",
    notes: null,
    confidence: "actual",
    receiptInboxId: null,
    dueDate: null,
    nextDueDate: null,
    calendarSort: null,
    cancelledNoRenew: false,
  };

  it("discards without posting and marks resolved", async () => {
    mocks.quarantineFindUnique.mockResolvedValue(heldRow);
    const result = await resolveQuarantinedOwnerExpense("q-1", "discard");
    expect(result.status).toBe("discarded");
    expect(mocks.persistExternalUsageEvents).not.toHaveBeenCalled();
    expect(mocks.quarantineUpdate).toHaveBeenCalledWith({
      where: { id: "q-1" },
      data: { status: "discarded", resolvedAt: expect.any(Date) },
    });
  });

  it("posts the original input on post-anyway and marks posted", async () => {
    mocks.quarantineFindUnique.mockResolvedValue(heldRow);
    // The re-post must bypass the quarantine even though the duplicate row
    // still exists in the scan results.
    mocks.findMany.mockResolvedValue([postedRow()]);
    const result = await resolveQuarantinedOwnerExpense("q-1", "post");
    expect(result.status).toBe("posted");
    expect(mocks.persistExternalUsageEvents).toHaveBeenCalledTimes(1);
    expect(mocks.quarantineCreate).not.toHaveBeenCalled();
    expect(mocks.quarantineUpdate).toHaveBeenCalledWith({
      where: { id: "q-1" },
      data: { status: "posted", resolvedAt: expect.any(Date) },
    });
  });

  it("refuses to resolve an already-resolved item", async () => {
    mocks.quarantineFindUnique.mockResolvedValue({ ...heldRow, status: "discarded" });
    await expect(resolveQuarantinedOwnerExpense("q-1", "post")).rejects.toThrow(
      /already resolved/
    );
  });

  it("404s on an unknown id", async () => {
    mocks.quarantineFindUnique.mockResolvedValue(null);
    await expect(resolveQuarantinedOwnerExpense("q-9", "discard")).rejects.toThrow(
      /not found/
    );
  });
});
