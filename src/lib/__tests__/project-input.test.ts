import { describe, expect, it } from "vitest";
import { parseProjectCreateInput, parseProjectUpdateInput } from "../project-input";

describe("project input validation", () => {
  it("normalizes a valid create payload", () => {
    expect(
      parseProjectCreateInput({
        name: "  Socratic.Trade  ",
        description: "  production  ",
        monthlyBudgetUsd: 0,
      })
    ).toEqual({
      name: "Socratic.Trade",
      nameKey: "socratic.trade",
      description: "production",
      monthlyBudgetUsd: 0,
    });
  });

  it("rejects malformed types and invalid budgets before Prisma", () => {
    expect(() => parseProjectCreateInput({ name: ["not", "a", "name"] })).toThrow(
      /Project name is required/
    );
    expect(() => parseProjectCreateInput({ name: "ok", description: 123 })).toThrow(
      /description must be a string/
    );
    expect(() => parseProjectCreateInput({ name: "ok", monthlyBudgetUsd: "10" })).toThrow(
      /non-negative finite number/
    );
    expect(() => parseProjectCreateInput({ name: "ok", monthlyBudgetUsd: -1 })).toThrow(
      /non-negative finite number/
    );
  });

  it("distinguishes omitted update fields from explicit clears", () => {
    expect(parseProjectUpdateInput({})).toEqual({});
    expect(
      parseProjectUpdateInput({ description: null, monthlyBudgetUsd: null })
    ).toEqual({ description: null, monthlyBudgetUsd: null });
  });
});
