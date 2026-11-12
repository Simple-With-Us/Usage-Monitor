import { describe, expect, it } from "vitest";
import { snapshotVariableCostUsd } from "@/lib/provider-usage-reconciliation";

describe("snapshotVariableCostUsd (E12)", () => {
  it("subtracts positive plan fixed fees from snapshot total", () => {
    expect(snapshotVariableCostUsd(120, 20)).toBe(100);
  });

  it("never goes negative when fixed exceeds snapshot", () => {
    expect(snapshotVariableCostUsd(10, 50)).toBe(0);
  });

  it("treats null/zero/invalid fixed as zero", () => {
    expect(snapshotVariableCostUsd(42, null)).toBe(42);
    expect(snapshotVariableCostUsd(42, 0)).toBe(42);
    expect(snapshotVariableCostUsd(42, undefined)).toBe(42);
  });
});
