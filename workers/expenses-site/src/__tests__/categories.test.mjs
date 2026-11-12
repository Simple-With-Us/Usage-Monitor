import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  SIDES,
  categorizeExpense,
  categoryLabel,
  sideForCategory,
  sideLabel,
} from "../categories.mjs";

describe("categorizeExpense", () => {
  it("maps AI vendors to tech-ai", () => {
    expect(categorizeExpense("Anthropic", "API usage")).toBe("tech-ai");
    expect(categorizeExpense("OpenRouter", "credits")).toBe("tech-ai");
    expect(categorizeExpense("xAI", "SuperGrok")).toBe("tech-ai");
    expect(categorizeExpense("DeepSeek", null)).toBe("tech-ai");
    expect(categorizeExpense("Google", "Google AI Pro")).toBe("tech-ai");
    expect(categorizeExpense("MiniMax", "API")).toBe("tech-ai");
  });

  it("maps infra vendors to their buckets", () => {
    expect(categorizeExpense("Hetzner", "server")).toBe("cloud-hosting");
    expect(categorizeExpense("Vercel", "hosting")).toBe("cloud-hosting");
    expect(categorizeExpense("Adobe", "Creative Cloud")).toBe("software");
    expect(categorizeExpense("Rogue Amoeba", "Audio Hijack")).toBe("software");
    expect(categorizeExpense("Apple", "AppleCare One")).toBe("services");
    expect(categorizeExpense("Control D", "Full Control")).toBe("services");
    expect(categorizeExpense("Porkbun", "domain renewal")).toBe("domains");
  });

  it("matches dotted names as substrings", () => {
    expect(categorizeExpense("Fly.io", "hosting")).toBe("cloud-hosting");
    expect(categorizeExpense("Hover.com", "domain")).toBe("domains");
  });

  it("falls back to other for unknown vendors", () => {
    expect(categorizeExpense("Allegro", "card grading")).toBe("other");
    expect(categorizeExpense("", "")).toBe("other");
  });

  it("does not match 'ai' inside unrelated words", () => {
    expect(categorizeExpense("Airbnb", "stay")).toBe("other");
  });

  it("exposes stable Title Case labels", () => {
    expect(categoryLabel("tech-ai")).toBe("AI");
    expect(categoryLabel("bogus")).toBe("Other");
    expect(Object.keys(CATEGORIES)).toContain("tech-ai");
  });

  it("puts everything business under the Tech side", () => {
    expect(sideForCategory("tech-ai")).toBe("tech");
    expect(sideForCategory("cloud-hosting")).toBe("tech");
    expect(sideForCategory("domains")).toBe("tech");
    expect(sideForCategory("software")).toBe("tech");
    expect(sideForCategory("services")).toBe("tech");
    expect(sideForCategory("other")).toBe("tech");
    expect(sideForCategory("personal")).toBe("personal");
    expect(sideLabel("personal")).toBe("Personal");
    expect(sideLabel("tech")).toBe("Tech");
    expect(Object.keys(SIDES)).toEqual(["personal", "tech"]);
  });
});
