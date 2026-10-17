import { describe, expect, it } from "vitest";
import {
  duplicateMatchReason,
  isDuplicateOwnerExpense,
  ownerExpenseIdempotencyKey,
  parseOwnerExpenseInput,
} from "../owner-expense";
import type { OwnerExpenseInput } from "../owner-expense";

function input(overrides: Partial<OwnerExpenseInput> = {}): OwnerExpenseInput {
  return {
    provider: "Anthropic",
    amountUsd: 213.2,
    occurredAt: new Date("2026-10-06T12:00:00.000Z"),
    kind: "subscription",
    label: "Anthropic Max 20x Oct 6",
    confidence: "actual",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "owner-recorded-expense:v1:posted-row",
    provider: "Anthropic",
    costUsd: 213.2,
    occurredAt: new Date("2026-10-06T12:00:00.000Z"),
    label: "Anthropic Max plan - 20x",
    metadata: { ownerRecorded: true },
    ...overrides,
  };
}

describe("parseOwnerExpenseInput", () => {
  it("accepts an owner-recorded subscription charge", () => {
    const input = parseOwnerExpenseInput({
      provider: "namecheap",
      amountUsd: 1.18,
      occurredAt: "2026-08-13T00:00:00.000Z",
      kind: "one_time",
      label: "Namecheap order",
      notes: "Gmail receipt",
    });
    expect(input.confidence).toBe("actual");
    expect(input.kind).toBe("one_time");
    expect(ownerExpenseIdempotencyKey(input)).toMatch(
      /^owner-recorded-expense:v1:[0-9a-f]{64}$/
    );
  });

  it("accepts a postdated usage invoice with a due date note", () => {
    const input = parseOwnerExpenseInput({
      provider: "GitHub",
      amountUsd: 200.01,
      occurredAt: "2026-08-21T12:00:00.000Z",
      kind: "usage",
      label: "GitHub Actions usage July 2026",
      notes: "Received 2026-08-21.  Period Jul 1-31 2026.",
      dueDate: "2026-08-28",
      calendarSort: "usage",
    });
    expect(input.kind).toBe("usage");
    expect(input.dueDate).toBe("2026-08-28");
    expect(input.calendarSort).toBe("usage");
  });

  it("rejects a zero amount", () => {
    expect(() =>
      parseOwnerExpenseInput({
        provider: "fmp",
        amountUsd: 0,
        occurredAt: "2026-08-13T00:00:00.000Z",
        kind: "subscription",
        label: "FMP",
      })
    ).toThrow(/non-zero/);
  });

  it("rejects a malformed inbox id", () => {
    expect(() =>
      parseOwnerExpenseInput({
        provider: "fmp",
        amountUsd: 31.9,
        occurredAt: "2026-06-22T18:01:08.000Z",
        kind: "subscription",
        label: "FMP Starter",
        receiptInboxId: "not-hex",
      })
    ).toThrow(/64-hex/);
  });
});

describe("isDuplicateOwnerExpense", () => {
  it("matches an exact duplicate with a different label (the Oct 6 doubles pattern)", () => {
    const match = isDuplicateOwnerExpense(
      input({ label: "Claude Max 20x October" }),
      row({ label: "Anthropic Max plan - 20x (iCloud scan)" })
    );
    expect(match?.matchedOn).toBe("vendor_amount_date");
  });

  it("matches case-insensitively on vendor and exactly on cents", () => {
    const match = isDuplicateOwnerExpense(
      input({ provider: "anthropic", amountUsd: 213.2 }),
      row({ provider: "Anthropic", costUsd: 213.2 })
    );
    expect(match?.matchedOn).toBe("vendor_amount_date");
  });

  it("does not match when the amount differs", () => {
    expect(isDuplicateOwnerExpense(input({ amountUsd: 200 }), row())).toBeNull();
  });

  it("does not match when the vendor differs", () => {
    expect(isDuplicateOwnerExpense(input({ provider: "OpenAI" }), row())).toBeNull();
  });

  it("does not match when the charge date differs (plain post, no inbox id)", () => {
    expect(
      isDuplicateOwnerExpense(
        input({ occurredAt: new Date("2026-10-08T12:00:00.000Z") }),
        row()
      )
    ).toBeNull();
  });

  it("never matches a true idempotency-key replay (replays are not quarantine)", () => {
    const replay = input();
    expect(
      isDuplicateOwnerExpense(
        replay,
        row({ idempotencyKey: ownerExpenseIdempotencyKey(replay) })
      )
    ).toBeNull();
  });

  it("matches on the same receipt inbox id even when other fields differ", () => {
    const inboxId = "a".repeat(64);
    const match = isDuplicateOwnerExpense(
      input({ receiptInboxId: inboxId, amountUsd: 999, provider: "Other" }),
      row({ metadata: { receiptInboxId: inboxId } })
    );
    expect(match?.matchedOn).toBe("receipt_inbox_id");
  });

  it("catches an agent-forwarded archival copy: inbox post, skewed date within tolerance", () => {
    const match = isDuplicateOwnerExpense(
      input({
        receiptInboxId: "b".repeat(64),
        label: "Fwd: Receipt from Anthropic",
        // Recorded two days later from the inbox review form (date defaulted).
        occurredAt: new Date("2026-10-08T12:00:00.000Z"),
      }),
      row({ metadata: { ownerRecorded: true } })
    );
    expect(match?.matchedOn).toBe("vendor_amount_near_date");
  });

  it("does not hold a genuine monthly renewal (30 days apart, inbox-sourced)", () => {
    expect(
      isDuplicateOwnerExpense(
        input({
          receiptInboxId: "c".repeat(64),
          occurredAt: new Date("2026-11-06T12:00:00.000Z"),
        }),
        row()
      )
    ).toBeNull();
  });

  it("does not apply the near-date tolerance to non-inbox posts", () => {
    expect(
      isDuplicateOwnerExpense(
        input({ occurredAt: new Date("2026-10-08T12:00:00.000Z") }),
        row()
      )
    ).toBeNull();
  });

  it("describes why an entry was held", () => {
    const match = isDuplicateOwnerExpense(input(), row());
    expect(match).not.toBeNull();
    if (match) {
      const reason = duplicateMatchReason(input(), match);
      expect(reason).toContain("Anthropic");
      expect(reason).toContain("$213.20");
      expect(reason).toContain("2026-10-06");
    }
  });
});
