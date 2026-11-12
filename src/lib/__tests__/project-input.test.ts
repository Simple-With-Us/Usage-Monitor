import { describe, expect, it } from "vitest";
import { parseProjectCreateInput, parseProjectUpdateInput } from "../project-input";

describe("parseProjectCreateInput", () => {
  it("parses valid name, description, and monthlyBudgetUsd", () => {
    const input = parseProjectCreateInput({
      name: "  Socratic Trade  ",
      description: "  AI Trading Assistant  ",
      monthlyBudgetUsd: 250,
    });
    expect(input).toEqual({
      name: "Socratic Trade",
      description: "AI Trading Assistant",
      monthlyBudgetUsd: 250,
    });
  });

  it("handles null/omitted description and monthlyBudgetUsd", () => {
    const input = parseProjectCreateInput({
      name: "Congress Trade",
    });
    expect(input).toEqual({
      name: "Congress Trade",
      description: null,
      monthlyBudgetUsd: null,
    });
  });

  it("rejects missing or empty/whitespace project name", () => {
    expect(() => parseProjectCreateInput({})).toThrow("Project name is required");
    expect(() => parseProjectCreateInput({ name: "" })).toThrow("Project name is required");
    expect(() => parseProjectCreateInput({ name: "   " })).toThrow("Project name is required");
  });

  it("rejects non-string project name", () => {
    expect(() => parseProjectCreateInput({ name: 123 })).toThrow("Project name is required");
  });

  it("rejects negative monthlyBudgetUsd", () => {
    expect(() =>
      parseProjectCreateInput({ name: "Test", monthlyBudgetUsd: -500 })
    ).toThrow("monthlyBudgetUsd must be a positive number");
  });

  it("rejects non-finite monthlyBudgetUsd", () => {
    expect(() =>
      parseProjectCreateInput(JSON.parse('{"name":"Test","monthlyBudgetUsd":1e400}'))
    ).toThrow("monthlyBudgetUsd must be a positive number");
  });

  it("rejects non-object payload", () => {
    expect(() => parseProjectCreateInput("not an object")).toThrow("Request body must be a JSON object");
    expect(() => parseProjectCreateInput(null)).toThrow("Request body must be a JSON object");
  });
});

describe("parseProjectUpdateInput", () => {
  it("preserves absent vs present semantics", () => {
    expect(parseProjectUpdateInput({})).toEqual({});
    expect(parseProjectUpdateInput({ description: null })).toEqual({ description: null });
    expect(parseProjectUpdateInput({ monthlyBudgetUsd: null })).toEqual({ monthlyBudgetUsd: null });
  });

  it("parses valid update fields", () => {
    expect(
      parseProjectUpdateInput({
        name: "  Renamed  ",
        description: "  New Desc  ",
        monthlyBudgetUsd: 100,
      })
    ).toEqual({
      name: "Renamed",
      description: "New Desc",
      monthlyBudgetUsd: 100,
    });
  });

  it("rejects empty name string on update", () => {
    expect(() => parseProjectUpdateInput({ name: "   " })).toThrow("name cannot be empty");
  });

  it("rejects negative monthlyBudgetUsd on update", () => {
    expect(() => parseProjectUpdateInput({ monthlyBudgetUsd: -10 })).toThrow(
      "monthlyBudgetUsd must be a positive number"
    );
  });
});
