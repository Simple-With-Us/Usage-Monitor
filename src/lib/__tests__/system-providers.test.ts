import { describe, expect, it } from "vitest";
import {
  excludeInternalSystemProvidersWhere,
  filterOutInternalSystemProviders,
  isInternalSystemProviderName,
  PROJECT_BUDGETS_PROVIDER_NAME,
} from "../system-providers";

describe("system-providers", () => {
  it("recognizes project-budgets under common casings/aliases", () => {
    expect(isInternalSystemProviderName("project-budgets")).toBe(true);
    expect(isInternalSystemProviderName("Project-Budgets")).toBe(true);
    expect(isInternalSystemProviderName("project_budgets")).toBe(true);
    expect(isInternalSystemProviderName("openai")).toBe(false);
    expect(isInternalSystemProviderName("ag***-s**c-relay")).toBe(false);
    expect(isInternalSystemProviderName("")).toBe(false);
    expect(isInternalSystemProviderName(null)).toBe(false);
  });

  it("builds a Prisma exclusion for the sentinel name", () => {
    expect(excludeInternalSystemProvidersWhere()).toEqual({
      name: { notIn: [PROJECT_BUDGETS_PROVIDER_NAME] },
    });
  });

  it("filters operator lists without dropping real providers", () => {
    const rows = [
      { name: "openai", id: "1" },
      { name: "project-budgets", id: "2" },
      { name: "hetzner", id: "3" },
    ];
    expect(filterOutInternalSystemProviders(rows).map((r) => r.name)).toEqual([
      "openai",
      "hetzner",
    ]);
  });
});
