import { describe, expect, it } from "vitest";
import {
  providerFinancialSemantics,
  sumProviderFunds,
} from "@/lib/provider-financial-semantics";

describe("providerFinancialSemantics", () => {
  it("separates brokerage equity from provider funds and labels its API quota", () => {
    expect(providerFinancialSemantics("tradier")).toEqual({
      balanceLabel: "brokerage equity",
      creditsLabel: "API requests remaining",
      includeBalanceInPortfolio: false,
    });
  });

  it("labels OpenRouter's account-wide prepaid values without calling both balances", () => {
    expect(providerFinancialSemantics("openrouter")).toEqual({
      balanceLabel: "prepaid remaining",
      creditsLabel: "purchased credits",
      includeBalanceInPortfolio: true,
    });
  });

  it("does not classify OpenAI spend-limit headroom as provider funds", () => {
    expect(providerFinancialSemantics("openai").includeBalanceInPortfolio).toBe(false);
  });

  it("uses neutral account semantics for unknown providers", () => {
    expect(providerFinancialSemantics("custom-provider")).toEqual({
      balanceLabel: "account balance",
      creditsLabel: "credits",
      includeBalanceInPortfolio: false,
    });
  });

  it("includes one known grouped balance while excluding brokerage and merchant assets", () => {
    expect(
      sumProviderFunds([
        { name: "openrouter", groupId: "openrouter", latestSnapshot: { balance: 23 } },
        { name: "openrouter", groupId: "openrouter", latestSnapshot: { balance: null } },
        { name: "deepseek", groupId: "deepseek", latestSnapshot: { balance: 23 } },
        { name: "xai", groupId: null, latestSnapshot: { balance: 7 } },
        { name: "tradier", groupId: "tradier", latestSnapshot: { balance: 5 } },
        { name: "stripe", groupId: "stripe", latestSnapshot: { balance: 90 } },
      ])
    ).toBe(53);
  });

  it("excludes a group with multiple reported balances because identity is unproven", () => {
    expect(
      sumProviderFunds([
        { name: "openrouter", groupId: "openrouter", latestSnapshot: { balance: 23 } },
        { name: "openrouter", groupId: "openrouter", latestSnapshot: { balance: 40 } },
      ])
    ).toBe(0);
  });
});
