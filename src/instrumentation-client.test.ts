import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Sentry private client", () => {
  it("keeps feedback and Replay off with existing mailto fallback", () => {
    const src = readFileSync(
      join(import.meta.dirname, "instrumentation-client.ts"),
      "utf8"
    );
    expect(src).not.toContain("feedbackIntegration(");
    expect(src).toMatch(/replaysSessionSampleRate:\s*0/);
    expect(src).toMatch(/replaysOnErrorSampleRate:\s*0/);
    expect(src).not.toContain("Sentry.replayIntegration(");
    expect(src).toMatch(/export function openSentryFeedback\(\): boolean/);
    expect(src).not.toMatch(/return true;/);
    expect(src).toMatch(/return false;/);
  });
});
