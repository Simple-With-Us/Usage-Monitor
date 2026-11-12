import { describe, expect, it } from "vitest";
import {
  LEARN_MORE_FORBIDDEN_PATTERN,
  LEARN_MORE_SECTIONS,
  LEARN_MORE_SENTENCE_GAP,
} from "@/lib/learn-more-content";

describe("learn-more-content", () => {
  it("uses NBSP plus space between sentences in prose paragraphs", () => {
    const paragraphs = LEARN_MORE_SECTIONS.flatMap((s) => s.paragraphs);
    const multiSentence = paragraphs.filter((p) => /\.\s+\S/.test(p));
    expect(multiSentence.length).toBeGreaterThan(0);
    for (const paragraph of multiSentence) {
      expect(paragraph).toContain(LEARN_MORE_SENTENCE_GAP);
    }
  });

  it("does not include fleet or developer jargon", () => {
    const allText = LEARN_MORE_SECTIONS.flatMap((s) => [
      ...s.paragraphs,
      ...(s.bullets ?? []),
    ]).join("\n");
    expect(allText).not.toMatch(LEARN_MORE_FORBIDDEN_PATTERN);
  });

  it("covers provider cards, windows, data sources, and troubleshooting", () => {
    const ids = LEARN_MORE_SECTIONS.map((s) => s.id);
    expect(ids).toContain("provider-cards");
    expect(ids).toContain("numbers-and-windows");
    expect(ids).toContain("where-data-comes-from");
    expect(ids).toContain("when-something-looks-wrong");
  });
});
