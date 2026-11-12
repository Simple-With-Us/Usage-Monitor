import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INFISICAL_ENVIRONMENT,
  _resetInfisicalEnvironmentWarningsForTests,
  resolveProdInfisicalEnvironment,
} from "@/lib/infisical-environment";

describe("resolveProdInfisicalEnvironment", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetInfisicalEnvironmentWarningsForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("is prod, and prod is returned with no warning when nothing or prod is requested", () => {
    expect(INFISICAL_ENVIRONMENT).toBe("prod");
    expect(resolveProdInfisicalEnvironment(undefined, "INFISICAL_ENV")).toBe("prod");
    expect(resolveProdInfisicalEnvironment("", "INFISICAL_ENV")).toBe("prod");
    expect(resolveProdInfisicalEnvironment("  ", "INFISICAL_ENV")).toBe("prod");
    expect(resolveProdInfisicalEnvironment("prod", "INFISICAL_ENV")).toBe("prod");
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses dev, staging and anything else: returns prod and warns once per variable", () => {
    expect(resolveProdInfisicalEnvironment("dev", "INFISICAL_ENV")).toBe("prod");
    expect(resolveProdInfisicalEnvironment("staging", "INFISICAL_ENV")).toBe("prod");
    expect(resolveProdInfisicalEnvironment("production", "INFISICAL_ENV")).toBe("prod");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(resolveProdInfisicalEnvironment("dev", "UM_INFISICAL_ENV")).toBe("prod");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("names the variable but never echoes the requested value", () => {
    resolveProdInfisicalEnvironment("super-secret-looking-value", "INFISICAL_ENV");
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("INFISICAL_ENV");
    expect(line).not.toContain("super-secret-looking-value");
  });
});
