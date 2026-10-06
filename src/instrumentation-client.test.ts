import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Sentry max-features client", () => {
  it("ships Feedback with a kill switch and keeps Replay off", () => {
    const src = readFileSync(
      join(import.meta.dirname, "instrumentation-client.ts"),
      "utf8"
    );
    expect(src).toMatch(/feedbackIntegration\(/);
    expect(src).toMatch(/autoInject:\s*false/);
    expect(src).toMatch(/formTitle:\s*"Report a Problem"/);
    expect(src).toMatch(/NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED/);
    expect(src).toMatch(/replaysSessionSampleRate:\s*0/);
    expect(src).toMatch(/replaysOnErrorSampleRate:\s*0/);
    expect(src).not.toContain("Sentry.replayIntegration(");
    expect(src).toMatch(/export function openSentryFeedback\(\): boolean/);
    expect(src).toMatch(/return true;/);
    expect(src).toMatch(/return false;/);
  });
});
