import { describe, expect, it } from "vitest";
import {
  formatWizardProgress,
  hasFixedMonthlyCostSet,
  nextWizardStep,
  prevWizardStep,
  validateTypeStep,
  FIXED_FEE_SUBSCRIPTION_WARNING,
} from "@/lib/provider-wizard";

describe("provider-wizard", () => {
  it("navigates steps", () => {
    expect(nextWizardStep("type")).toBe("credentials");
    expect(prevWizardStep("budget")).toBe("credentials");
    expect(formatWizardProgress("review")).toBe("4/4");
  });
  it("validates type step", () => {
    expect(validateTypeStep({ tab: "builtin", selectedBuiltin: "", builtinDisplayName: "x", customName: "", customDisplayName: "" })).toMatch(/select/i);
    expect(validateTypeStep({ tab: "builtin", selectedBuiltin: "openai", builtinDisplayName: "OpenAI", customName: "", customDisplayName: "" })).toBeNull();
  });
  it("flags fixed monthly cost for exclusivity warning", () => {
    expect(hasFixedMonthlyCostSet("10")).toBe(true);
    expect(hasFixedMonthlyCostSet("")).toBe(false);
    expect(FIXED_FEE_SUBSCRIPTION_WARNING).toMatch(/double-count/i);
  });
});
