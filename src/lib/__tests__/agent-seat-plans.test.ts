import { describe, expect, it } from "vitest";
import {
  chatgptSkuForPlanType,
  resolveAgentSeat,
  type AgentSeatSubscriptionInput,
} from "../agent-seat-plans";

function sub(
  partial: Partial<AgentSeatSubscriptionInput> & Pick<AgentSeatSubscriptionInput, "name">
): AgentSeatSubscriptionInput {
  return {
    status: "active",
    costUsd: 20,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    providerName: "anthropic",
    providerDisplayName: "Anthropic",
    ...partial,
  };
}

describe("chatgptSkuForPlanType", () => {
  it("maps Codex login plus to ChatGPT Plus $20, not Pro $200", () => {
    expect(chatgptSkuForPlanType("plus")).toEqual({
      planName: "ChatGPT Plus",
      listMonthlyUsd: 20,
    });
    expect(chatgptSkuForPlanType("pro")?.listMonthlyUsd).toBe(200);
  });
});

describe("resolveAgentSeat", () => {
  it("uses an observed Codex Plus login instead of guessing Pro $200", () => {
    const seat = resolveAgentSeat("openai-codex", [], { planType: "plus" });
    expect(seat.planName).toBe("ChatGPT Plus");
    expect(seat.listMonthlyUsd).toBe(20);
    expect(seat.billedMonthlyUsd).toBe(20);
    expect(seat.source).toBe("observed");
    expect(seat.note).toMatch(/receipt/i);
  });

  it("lets a Plus $20 receipt win for Codex", () => {
    const seat = resolveAgentSeat(
      "openai-codex",
      [
        sub({
          name: "ChatGPT Plus",
          costUsd: 20,
          providerName: "openai",
          providerDisplayName: "ChatGPT",
        }),
      ],
      { planType: "pro" }
    );
    expect(seat.source).toBe("receipt");
    expect(seat.billedMonthlyUsd).toBe(20);
    expect(seat.planName).toBe("ChatGPT Plus");
  });

  it("does not invent a Codex plan when login has not been observed", () => {
    const seat = resolveAgentSeat("openai-codex", []);
    expect(seat.billedMonthlyUsd).toBe(0);
    expect(seat.source).toBe("unknown");
  });

  it("marks Copilot as not billed", () => {
    const seat = resolveAgentSeat("github-copilot", []);
    expect(seat.billedMonthlyUsd).toBe(0);
    expect(seat.planName).toBe("Not billed");
  });

  it("treats Cursor Ultra as included with SuperGrok Heavy, not a $20 or $200 cash seat", () => {
    const seat = resolveAgentSeat("cursor-agent", []);
    expect(seat.source).toBe("included");
    expect(seat.billedMonthlyUsd).toBe(0);
    expect(seat.listMonthlyUsd).toBe(200);
    expect(seat.planName).toBe("Cursor Ultra");
    expect(seat.note).toMatch(/SuperGrok Heavy/);
  });

  it("leaves MiniMax at $0 until a receipt lands", () => {
    const unknown = resolveAgentSeat("minimax-code", []);
    expect(unknown.billedMonthlyUsd).toBe(0);
    expect(unknown.source).toBe("unknown");
    const receipt = resolveAgentSeat("minimax-code", [
      sub({
        name: "MiniMax Code Medium",
        costUsd: 58,
        providerName: "minimax",
        providerDisplayName: "MiniMax",
      }),
    ]);
    expect(receipt.source).toBe("receipt");
    expect(receipt.billedMonthlyUsd).toBe(58);
  });

  it("keeps Claude Max 20x catalog until a receipt says otherwise", () => {
    const seat = resolveAgentSeat("claude-code", []);
    expect(seat.planName).toBe("Claude Max 20x");
    expect(seat.listMonthlyUsd).toBe(200);
    expect(seat.source).toBe("catalog");
  });

  it("adopts an active Claude Max $200 receipt", () => {
    const seat = resolveAgentSeat("claude-code", [
      sub({ name: "Claude Max 20x", costUsd: 200 }),
    ]);
    expect(seat.source).toBe("receipt");
    expect(seat.billedMonthlyUsd).toBe(200);
  });

  it("uses SuperGrok Heavy $300 list and $100 promo billed by default", () => {
    const seat = resolveAgentSeat("grok-build", []);
    expect(seat.planName).toBe("SuperGrok Heavy");
    expect(seat.listMonthlyUsd).toBe(300);
    expect(seat.billedMonthlyUsd).toBe(100);
    expect(seat.note).toMatch(/\$100/);
  });
});
