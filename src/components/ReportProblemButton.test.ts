import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openFeedbackOrMailto } from "./ReportProblemButton";
import { triggerSentryFeedback } from "./Nav";

describe("subtle Sentry support trigger", () => {
  it("wires Report a Problem on the support page and error boundary", () => {
    const button = readFileSync(
      join(import.meta.dirname, "ReportProblemButton.tsx"),
      "utf8"
    );
    const support = readFileSync(
      join(import.meta.dirname, "../app/support/page.tsx"),
      "utf8"
    );
    const errorPage = readFileSync(
      join(import.meta.dirname, "../app/error.tsx"),
      "utf8"
    );
    expect(button).toMatch(/openSentryFeedback/);
    expect(button).toMatch(/opened !== false/);
    expect(button).toMatch(/mailto:mail@jays\.services/);
    expect(support).toMatch(/ReportProblemButton/);
    expect(support).toMatch(/Report a Problem with this dashboard/);
    expect(errorPage).toMatch(/ReportProblemButton/);
    expect(errorPage).toMatch(/Report a Problem/);
  });
});

describe("openFeedbackOrMailto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the actual Nav report action to the existing user-initiated mailto", () => {
    const loc = { href: "https://usage.jays.services/" };
    const open = vi.fn(() => false);
    vi.stubGlobal("window", { openSentryFeedback: open, location: loc });
    triggerSentryFeedback();
    expect(open).toHaveBeenCalledOnce();
    expect(loc.href).toBe("mailto:mail@jays.services?subject=Report%20a%20Problem");
  });

  it("leaves the page alone when Sentry Feedback actually opens", () => {
    const open = vi.fn(() => true);
    const loc = { href: "https://usage.jays.services/support" };
    vi.stubGlobal("window", { openSentryFeedback: open, location: loc });
    openFeedbackOrMailto();
    expect(open).toHaveBeenCalledOnce();
    expect(loc.href).toBe("https://usage.jays.services/support");
  });

  it("falls back to mailto when the helper reports Feedback is dark", () => {
    const open = vi.fn(() => false);
    const loc = { href: "https://usage.jays.services/support" };
    vi.stubGlobal("window", { openSentryFeedback: open, location: loc });
    openFeedbackOrMailto();
    expect(open).toHaveBeenCalledOnce();
    expect(loc.href).toBe(
      "mailto:mail@jays.services?subject=Report%20a%20Problem"
    );
  });

  it("falls back to mailto when the helper is missing", () => {
    const loc = { href: "https://usage.jays.services/support" };
    vi.stubGlobal("window", { location: loc });
    openFeedbackOrMailto();
    expect(loc.href).toBe(
      "mailto:mail@jays.services?subject=Report%20a%20Problem"
    );
  });
});
