import { describe, expect, it } from "vitest";
import { parseProviderCreateInput } from "../provider-input";

describe("provider allocation input", () => {
  const base = { name: "openai", displayName: "OpenAI" };

  it("rejects duplicate project allocations before the database unique constraint", () => {
    expect(() =>
      parseProviderCreateInput({
        ...base,
        allocations: [
          { projectId: "project-1", percentage: 25 },
          { projectId: "project-1", percentage: 25 },
        ],
      })
    ).toThrowError(/duplicate projectId project-1/);
  });

  it("accepts distinct allocations whose total is at most 100 percent", () => {
    expect(
      parseProviderCreateInput({
        ...base,
        allocations: [
          { projectId: "project-1", percentage: 25 },
          { projectId: "project-2", percentage: 75 },
        ],
      }).allocations
    ).toHaveLength(2);
  });
});
