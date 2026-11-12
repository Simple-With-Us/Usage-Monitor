/**
 * Regression cover for the three PR #1099 review findings on the Platforms
 * page client (src/components/PlatformsPageClient.tsx).
 *
 * This repo has no React component test harness — no jsdom/happy-dom, no
 * @testing-library — and adding one is out of scope here, so the fixes were
 * shaped so the reviewable logic lives in exported pure functions and copy
 * constants that a plain node-environment vitest file can exercise directly.
 * That is the same style as the rest of src/__tests__.
 *
 * All timing assertions run on vi.useFakeTimers() with a frozen clock: nothing
 * here may depend on the wall clock or on a calendar-pinned fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_ENV_LEAD_IN,
  REQUIRED_ENV_SEPARATOR,
  startVisiblePolling,
  usageBarTone,
  withSentenceGaps,
  type VisibilityTarget,
} from "@/components/PlatformsPageClient";

const NBSP = "\u00a0";
const INTERVAL_MS = 60_000;

/**
 * A stand-in for `document` that records its listeners, so the tests can flip
 * visibility and assert the loop cleaned up after itself.
 */
function makeTarget(initial: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  const target = {
    visibilityState: initial as string,
    addEventListener(_type: "visibilitychange", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "visibilitychange", listener: () => void) {
      listeners.delete(listener);
    },
  };
  return {
    target: target satisfies VisibilityTarget,
    listenerCount: () => listeners.size,
    /** Change visibility and fire the event, exactly as a browser would. */
    set(state: "visible" | "hidden") {
      target.visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("withSentenceGaps — finding 1, HTML sentence gap", () => {
  it("replaces a server headline's double space with NBSP + space", () => {
    expect(withSentenceGaps("All six apps are up.  Last sweep was clean.")).toBe(
      `All six apps are up.${NBSP} Last sweep was clean.`,
    );
  });

  it("leaves single spaces between words alone", () => {
    expect(withSentenceGaps("3 of 4 workers healthy")).toBe("3 of 4 workers healthy");
  });

  it("is idempotent — an already-gapped string is unchanged", () => {
    const gapped = `One.${NBSP} Two.`;
    expect(withSentenceGaps(gapped)).toBe(gapped);
    expect(withSentenceGaps(withSentenceGaps(gapped))).toBe(gapped);
  });

  it("collapses a longer run of spaces to a single gap", () => {
    expect(withSentenceGaps("One.    Two.")).toBe(`One.${NBSP} Two.`);
  });

  it("handles three sentences, gapping every boundary", () => {
    expect(withSentenceGaps("One.  Two.  Three.")).toBe(`One.${NBSP} Two.${NBSP} Three.`);
  });

  it("never emits a bare double space, which HTML would collapse", () => {
    expect(withSentenceGaps("Backups ran.  Restore was verified.")).not.toContain("  ");
  });
});

describe("usageBarTone — R2 fill color by closeness to 10 GB", () => {
  it("is green under 50%, amber from 50, red at the 90% guard", () => {
    expect(usageBarTone(20)).toBe("ok");
    expect(usageBarTone(49.9)).toBe("ok");
    expect(usageBarTone(50)).toBe("watch");
    expect(usageBarTone(70)).toBe("watch");
    expect(usageBarTone(85)).toBe("watch");
    expect(usageBarTone(89.9)).toBe("watch");
    expect(usageBarTone(90)).toBe("over");
    expect(usageBarTone(100)).toBe("over");
  });
});

describe("required-env copy — finding 3, no invented AND/OR relationship", () => {
  it("does not claim the listed variables are alternatives or all mandatory", () => {
    const sentence = `${REQUIRED_ENV_LEAD_IN}${REQUIRED_ENV_SEPARATOR}`;
    expect(sentence).not.toMatch(/\bor\b/i);
    expect(sentence).not.toMatch(/\band\b/i);
    expect(sentence).not.toMatch(/\bany of\b/i);
    expect(sentence).not.toMatch(/\ball of\b/i);
    expect(sentence).not.toMatch(/\beither\b/i);
  });

  it("separates names with a plain comma", () => {
    expect(REQUIRED_ENV_SEPARATOR).toBe(", ");
  });

  it("still tells the owner what to do and reads as sentence-case prose", () => {
    expect(REQUIRED_ENV_LEAD_IN).toMatch(/^Set /);
    expect(REQUIRED_ENV_LEAD_IN.endsWith(":")).toBe(true);
  });

  it("reads correctly for an all-required platform such as App Store Connect", () => {
    const names = ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"];
    const rendered = `${REQUIRED_ENV_LEAD_IN} ${names.join(REQUIRED_ENV_SEPARATOR)}.`;
    expect(rendered).toBe(
      "Set the environment variables this card uses: ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY.",
    );
  });
});

describe("startVisiblePolling — finding 2, pause while hidden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Frozen instant: no assertion here depends on the date, and pinning it
    // keeps the suite immune to wall-clock drift.
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on the interval while the page is visible", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    vi.advanceTimersByTime(INTERVAL_MS * 3);
    expect(onTick).toHaveBeenCalledTimes(3);

    stop();
  });

  it("skips every tick while the page is hidden", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    doc.set("hidden");
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(onTick).not.toHaveBeenCalled();

    stop();
  });

  it("refreshes once when the page becomes visible again", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    doc.set("hidden");
    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(onTick).not.toHaveBeenCalled();

    doc.set("visible");
    expect(onTick).toHaveBeenCalledTimes(1);

    stop();
  });

  it("does not re-fire on a visibility event that was already visible", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    doc.set("visible");
    doc.set("visible");
    expect(onTick).not.toHaveBeenCalled();

    stop();
  });

  it("resumes interval ticks after the page comes back", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    doc.set("hidden");
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    doc.set("visible");
    onTick.mockClear();

    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);

    stop();
  });

  it("starts paused when mounted into an already-hidden tab", () => {
    const onTick = vi.fn();
    const doc = makeTarget("hidden");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);

    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(onTick).not.toHaveBeenCalled();

    // It was hidden at mount, so the first return to visible still refreshes.
    doc.set("visible");
    expect(onTick).toHaveBeenCalledTimes(1);

    stop();
  });

  it("cleanup stops the timer and removes the listener", () => {
    const onTick = vi.fn();
    const doc = makeTarget("visible");
    const stop = startVisiblePolling(onTick, INTERVAL_MS, doc.target);
    expect(doc.listenerCount()).toBe(1);

    stop();
    expect(doc.listenerCount()).toBe(0);

    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(onTick).not.toHaveBeenCalled();

    // A post-unmount visibility change must not resurrect the fetch either.
    doc.set("hidden");
    doc.set("visible");
    expect(onTick).not.toHaveBeenCalled();
  });

  it("polls unconditionally when there is no document to consult", () => {
    const onTick = vi.fn();
    const stop = startVisiblePolling(onTick, INTERVAL_MS, null);

    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});
