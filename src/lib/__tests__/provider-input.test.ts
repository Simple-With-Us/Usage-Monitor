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

describe("provider type input", () => {
  const base = { name: "private-service", displayName: "Private service" };

  it("normalizes supported provider types before persistence", () => {
    expect(parseProviderCreateInput({ ...base, type: " Custom " }).type).toBe("custom");
    expect(parseProviderCreateInput({ ...base, type: "GENERIC" }).type).toBe("generic");
  });

  it("rejects unknown provider types instead of creating an unroutable row", () => {
    expect(() => parseProviderCreateInput({ ...base, type: "proxy" })).toThrowError(
      /type must be one of/
    );
  });
});
