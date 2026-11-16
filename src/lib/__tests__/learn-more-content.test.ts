import { describe, expect, it } from "vitest";
import {
  LEARN_MORE_FORBIDDEN_PATTERN,
  LEARN_MORE_SECTIONS,
  LEARN_MORE_SENTENCE_GAP,
} from "@/lib/learn-more-content";

function asciiSentenceBreaks(text: string): string[] {
  return [...text.matchAll(/[.!?][ \t]+(?=\S)/g)].map((match) => {
    const index = match.index ?? 0;
    return text.slice(Math.max(0, index - 24), index + 24);
  });
}

describe("learn-more-content", () => {
  it("uses NBSP plus space between sentences in paragraphs and bullets", () => {
    const texts = LEARN_MORE_SECTIONS.flatMap((section) => [
      ...section.paragraphs,
      ...(section.bullets ?? []),
    ]);
    const multiSentence = texts.filter((text) => /[.!?]\s+\S/.test(text));
    expect(multiSentence.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(asciiSentenceBreaks(text), text).toEqual([]);
      if (/[.!?]\s+\S/.test(text)) {
        expect(text).toContain(LEARN_MORE_SENTENCE_GAP);
      }
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
