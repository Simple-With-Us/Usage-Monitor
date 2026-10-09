/**
 * Component test for FleetQuotaMatrixCard.
 *
 * This repo has no jsdom/happy-dom and no @testing-library/react wired up
 * (see src/__tests__/platforms-page-client.test.ts's own note on this), and
 * adding either as a new test-time dependency is out of scope for this
 * change. So, following that same established repo pattern, the reviewable
 * logic here is exercised directly:
 *   - `buildProviderGroups` (the pure fetch-response -> render-model mapper)
 *     is tested against a mixed fixture covering all five providers.
 *   - The presentational pieces (`ProviderSection`, `QuotaWindowCard`, and
 *     the default-exported card itself) are rendered with
 *     `react-dom/server`'s `renderToStaticMarkup` — exactly like the
 *     existing `ProviderCard.test.ts` — so assertions run against real
 *     rendered HTML, not a re-implementation of the component's logic.
 *   - `global.fetch` is still mocked to cover the same
 *     fetch -> res.json() -> buildProviderGroups pipeline the component's
 *     `useEffect` runs, without requiring a DOM to flush that effect.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FleetQuotaMatrixCard, {
  ProviderLogo,
  ProviderSection,
  QuotaWindowCard,
  buildProviderGroups,
  defaultProviderGroups,
  formatCountdown,
  quotaTone,
} from "@/components/FleetQuotaMatrixCard";

const NBSP = " ";
const EXPECTED_LABELS = ["Claude", "Codex", "Antigravity", "Grok", "MiniMax"];
const NOW_MS = new Date("2026-09-12T00:00:00.000Z").getTime();

/** Normalize the NBSP sentence gap to a plain space for text comparisons. */
function normalizeGaps(text: string): string {
  return text.replace(new RegExp(NBSP, "g"), " ");
}

/**
 * A mixed /api/quota-windows payload: two anthropic windows with real
 * percentages, one Antigravity window carrying the legacy "Claude and GPT
 * models" label (the routing bucket this whole change exists to stop
 * rendering as the user's Claude plan, shown as "Third-Party Models"), one
 * Grok window, and Codex / MiniMax reporting nothing yet.
 */
const mixedPayload = {
  ok: true,
  generatedAt: "2026-09-12T00:00:00.000Z",
  windows: [],
  skipModelTypes: [],
  providerGroups: [
    {
      provider: "anthropic",
      providerLabel: "Claude",
      via: null,
      expected: true,
      windows: [
        {
          id: "anthropic-5h",
          provider: "anthropic",
          providerKey: "anthropic",
          providerLabel: "Claude",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "5h window",
          remainingPercent: 62.5,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T05:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.anthropic.com",
          machine: "Jay’s MacBook Pro",
        },
        {
          id: "anthropic-7d",
          provider: "anthropic",
          providerKey: "anthropic",
          providerLabel: "Claude",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "7d window",
          remainingPercent: 18.0,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-15T00:00:00.000Z",
          window: "7d",
          status: "near_cap",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.anthropic.com",
        },
      ],
    },
    {
      provider: "openai",
      providerLabel: "Codex",
      via: null,
      expected: true,
      windows: [],
    },
    {
      provider: "google-antigravity",
      providerLabel: "Antigravity",
      via: "antigravity",
      expected: true,
      windows: [
        {
          id: "antigravity-claude-gpt",
          provider: "google-antigravity",
          providerKey: "google-antigravity",
          providerLabel: "Antigravity",
          via: "antigravity",
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "Claude and GPT models",
          remainingPercent: 40,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T06:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: null,
        },
      ],
    },
    {
      provider: "xai",
      providerLabel: "Grok",
      via: null,
      expected: true,
      windows: [
        {
          id: "xai-5h",
          provider: "xai",
          providerKey: "xai",
          providerLabel: "Grok",
          via: null,
          sourceApp: null,
          modelId: null,
          modelType: null,
          label: "5h window",
          remainingPercent: 80,
          remainingUnknown: false,
          isExhausted: false,
          resetAt: "2026-09-12T04:00:00.000Z",
          window: "5h",
          status: "available",
          skip: false,
          skipReason: null,
          occurredAt: "2026-09-12T00:00:00.000Z",
          source: "api.x.ai",
        },
      ],
    },
    {
      provider: "minimax",
      providerLabel: "MiniMax",
      via: null,
      expected: true,
      windows: [],
    },
  ],
};

describe("buildProviderGroups", () => {
  it("returns exactly the five expected providers, in the order the API returned them", () => {
    const groups = buildProviderGroups(mixedPayload);
    expect(groups).toHaveLength(5);
    expect(groups.map((g) => g.provider)).toEqual([
      "anthropic",
      "openai",
      "google-antigravity",
      "xai",
      "minimax",
    ]);
    expect(groups.map((g) => g.providerLabel)).toEqual(EXPECTED_LABELS);
  });

  it("keeps both anthropic windows' remaining percentages with no via flag", () => {
    const groups = buildProviderGroups(mixedPayload);
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    expect(anthropic.windows.map((w) => w.remainingPercent)).toEqual([62.5, 18.0]);
    expect(anthropic.windows.every((w) => w.via === null)).toBe(true);
  });

  it("marks the Antigravity window via Antigravity and shows the legacy Claude and GPT label as Third-Party Models", () => {
    const groups = buildProviderGroups(mixedPayload);
    const antigravity = groups.find((g) => g.provider === "google-antigravity")!;
    expect(antigravity.windows).toHaveLength(1);
    expect(antigravity.windows[0].label).toBe("Third-Party Models");
    expect(antigravity.windows[0].via).toBe("antigravity");
  });

  it("maps every legacy Antigravity label variant and keeps the window suffix", () => {
    const variants: Array<[string, string]> = [
      ["Claude and GPT models (weekly)", "Third-Party Models (weekly)"],
      ["Claude & GPT models (5h)", "Third-Party Models (5h)"],
      ["Claude/GPT", "Third-Party Models"],
      ["Third-Party Models (5h)", "Third-Party Models (5h)"],
      ["Gemini Models (weekly)", "Gemini Models (weekly)"],
    ];
    for (const [legacy, expected] of variants) {
      const groups = buildProviderGroups({
        ok: true,
        providerGroups: [
          {
            provider: "google-antigravity",
            providerLabel: "Antigravity",
            via: "antigravity",
            expected: true,
            windows: [{ id: "w", label: legacy, remainingPercent: 50, via: "antigravity" }],
          },
        ],
      });
      const antigravity = groups.find((g) => g.provider === "google-antigravity")!;
      expect(antigravity.windows[0].label).toBe(expected);
    }
  });

  it("does not rewrite a same-named label on a non-Antigravity window", () => {
    const groups = buildProviderGroups({
      ok: true,
      providerGroups: [
        {
          provider: "anthropic",
          providerLabel: "Claude",
          via: null,
          expected: true,
          windows: [{ id: "w", label: "Claude and GPT models", remainingPercent: 50, via: null }],
        },
      ],
    });
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    expect(anthropic.windows[0].label).toBe("Claude and GPT models");
  });

  it("leaves Codex and MiniMax with zero windows for the empty-state row", () => {
    const groups = buildProviderGroups(mixedPayload);
    expect(groups.find((g) => g.provider === "openai")!.windows).toHaveLength(0);
    expect(groups.find((g) => g.provider === "minimax")!.windows).toHaveLength(0);
  });
});

describe("QuotaWindowCard rendering", () => {
  it("keeps source and collection time visible for separate same-label readings", () => {
    const groups = buildProviderGroups({
      providerGroups: [{
        provider: "anthropic",
        providerLabel: "Claude",
        windows: [
          {
            id: "claude-local",
            label: "5h window",
            remainingPercent: 70,
            occurredAt: "2026-09-12T00:00:00.000Z",
            source: "api.anthropic.com/local",
          },
          {
            id: "claude-work",
            label: "5h window",
            remainingPercent: 42,
            occurredAt: "2026-09-12T00:05:00.000Z",
            source: "api.anthropic.com/work",
            sourceApp: "subscription-quota-collector",
          },
        ],
      }],
    });
    const anthropic = groups.find((group) => group.provider === "anthropic")!;
    const html = anthropic.windows
      .map((win) => renderToStaticMarkup(createElement(QuotaWindowCard, { win, nowMs: NOW_MS })))
      .join("\n");

    expect(anthropic.windows).toHaveLength(2);
    expect(html.match(/5h Window/g)).toHaveLength(2);
    expect(html).toContain("Source: api.anthropic.com/local");
    expect(html).toContain("Source: api.anthropic.com/work");
    expect(html).toContain("Collector: subscription-quota-collector");
    expect(html).toContain(
      new Date("2026-09-12T00:00:00.000Z").toLocaleString("en-US", { hour12: true }),
    );
    expect(html).toContain(
      new Date("2026-09-12T00:05:00.000Z").toLocaleString("en-US", { hour12: true }),
    );
  });

  it("title-cases known quota headings while preserving custom model labels", () => {
    const labels = ["weekly window", "5-hour window", "weekly", "included plan", "Claude Opus 4.1"];
    const html = labels.map((label, index) => renderToStaticMarkup(createElement(QuotaWindowCard, {
      win: {
        id: `heading-${index}`,
        label,
        window: null,
        remainingPercent: 60,
        remainingUnknown: false,
        status: "available",
        resetAt: null,
        via: null,
      },
      nowMs: NOW_MS,
    }))).join("\n");

    expect(html).toContain("Weekly Window");
    expect(html).toContain("5-Hour Window");
    expect(html).toContain(">Weekly<");
    expect(html).toContain("Included Plan");
    expect(html).toContain("Claude Opus 4.1");
  });

  it("keeps the quota period visible when the label is a model name", () => {
    const html = renderToStaticMarkup(createElement(QuotaWindowCard, {
      win: {
        id: "model-window",
        label: "Claude Opus 4.1",
        window: "5h",
        remainingPercent: 50,
        remainingUnknown: false,
        status: "available",
        resetAt: null,
        via: null,
      },
      nowMs: NOW_MS,
    }));

    expect(html).toContain("Claude Opus 4.1");
    expect(html).toContain("5h Window");
  });

  it("renders the anthropic 5h and 7d windows' percentages without a via Antigravity caption", () => {
    const groups = buildProviderGroups(mixedPayload);
    const anthropic = groups.find((g) => g.provider === "anthropic")!;
    const html = anthropic.windows
      .map((win) => renderToStaticMarkup(createElement(QuotaWindowCard, { win, nowMs: NOW_MS })))
      .join("\n");

    expect(html).toContain("62.5% remaining");
    expect(html).toContain("18.0% remaining");
    expect(html).toContain("5h Window");
    expect(html).toContain("7d Window");
    expect(html).toContain("Source: api.anthropic.com");
    expect(html).toContain("Machine: Jay’s MacBook Pro");
    expect(html).toContain("Reported:");
    expect(html).not.toContain("via Antigravity");
  });

  it("renders the via Antigravity caption for the Antigravity bucket", () => {
    const groups = buildProviderGroups(mixedPayload);
    const antigravity = groups.find((g) => g.provider === "google-antigravity")!;
    const html = renderToStaticMarkup(
      createElement(QuotaWindowCard, { win: antigravity.windows[0], nowMs: NOW_MS })
    );

    expect(html).toContain("via Antigravity");
    expect(html).toContain("Third-Party Models");
    expect(html).not.toContain("Claude and GPT models");
    expect(html).toContain("40.0% remaining");
    expect(html).toContain("Source: Unknown");
    expect(html).toContain("Reported:");
  });

  it("shows Unknown for a missing source and invalid collection time", () => {
    const html = renderToStaticMarkup(createElement(QuotaWindowCard, {
      win: {
        id: "missing-provenance",
        label: "Included Plan",
        window: null,
        remainingPercent: 55,
        remainingUnknown: false,
        status: "available",
        resetAt: null,
        via: null,
        occurredAt: "not-a-date",
      },
      nowMs: NOW_MS,
    }));

    expect(html).toContain("Source: Unknown");
    expect(html).toContain("Reported: Unknown");
  });
});

describe("ProviderSection rendering", () => {
  it("renders the empty-state copy for Codex and MiniMax, tolerant of the NBSP sentence gap", () => {
    const groups = buildProviderGroups(mixedPayload);
    for (const providerKey of ["openai", "minimax"]) {
      const group = groups.find((g) => g.provider === providerKey)!;
      const html = renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS }));
      expect(normalizeGaps(html)).toContain(
        "No quota report yet.  Install the subscription quota collector on the Mac."
      );
    }
  });

  it("does not render the empty-state copy for a provider with reported windows", () => {
    const groups = buildProviderGroups(mixedPayload);
    for (const providerKey of ["anthropic", "google-antigravity", "xai"]) {
      const group = groups.find((g) => g.provider === providerKey)!;
      const html = renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS }));
      expect(html).not.toContain("No quota report yet");
    }
  });

  it("renders every provider label and no fake/demo bucket", () => {
    const groups = buildProviderGroups(mixedPayload);
    const html = groups
      .map((group) => renderToStaticMarkup(createElement(ProviderSection, { group, nowMs: NOW_MS })))
      .join("\n");

    for (const label of EXPECTED_LABELS) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/lorem ipsum|demo bucket|sample bucket|fake data/i);
  });
});

describe("FleetQuotaMatrixCard default render (before any fetch resolves)", () => {
  it("renders the honest title, all five provider labels, and never claims to be live", () => {
    const html = renderToStaticMarkup(createElement(FleetQuotaMatrixCard));
    expect(html).toContain("Subscription Quotas");
    expect(html).not.toMatch(/live/i);
    for (const label of EXPECTED_LABELS) {
      expect(html).toContain(label);
    }
  });
});

describe("formatCountdown and quotaTone branches", () => {
  it("covers rolling, past, day, hour, and minute countdown copy", () => {
    expect(formatCountdown(null, NOW_MS)).toBe("Rolling refresh");
    expect(formatCountdown("2026-09-11T00:00:00.000Z", NOW_MS)).toBe("Refreshing now");
    expect(formatCountdown("2026-09-14T06:00:00.000Z", NOW_MS)).toBe("Resets in 2d 6h");
    expect(formatCountdown("2026-09-12T03:15:00.000Z", NOW_MS)).toBe("Resets in 3h 15m");
    expect(formatCountdown("2026-09-12T00:09:00.000Z", NOW_MS)).toBe("Resets in 9m");
    expect(formatCountdown("2026-09-13T00:00:00.000Z", NOW_MS)).toBe("Resets in 1d 0h");
  });

  it("covers unknown, exhausted, available, moderate, and near-cap tones", () => {
    expect(quotaTone("unknown", null).label).toBe("Not reported");
    expect(quotaTone("exhausted", 0).label).toBe("Exhausted");
    expect(quotaTone("available", 80).label).toBe("Available");
    expect(quotaTone("available", 30).label).toBe("Moderate Quota");
    expect(quotaTone("near_cap", 10).label).toBe("Near Quota Cap");
    expect(quotaTone("available", 0).label).toBe("Exhausted");
  });
});

describe("QuotaWindowCard remainingUnknown and via without a window token", () => {
  it("omits a percent when remaining is unknown and still says via Antigravity", () => {
    const html = renderToStaticMarkup(
      createElement(QuotaWindowCard, {
        win: {
          id: "ag-unknown",
          label: "Routing bucket",
          window: null,
          remainingPercent: null,
          remainingUnknown: true,
          status: "unknown",
          resetAt: null,
          via: "antigravity",
        },
        nowMs: NOW_MS,
      }),
    );
    expect(html).toContain("via Antigravity");
    expect(html).toContain("Not reported");
    expect(html).not.toContain("% remaining");
  });
});

describe("buildProviderGroups fallbacks", () => {
  it("groups a flat windows payload and includes expected empty providers", () => {
    const groups = buildProviderGroups({
      windows: [
        {
          providerKey: "anthropic",
          provider: "anthropic",
          label: "5h window",
          remainingPercent: 70,
          remainingUnknown: false,
          status: "available",
          resetAt: "2026-09-12T05:00:00.000Z",
          window: "5h",
        },
        {
          provider: "acme",
          label: "monthly",
          remainingPercent: null,
          remainingUnknown: true,
          status: "nope",
        },
      ],
    });
    expect(groups.find((g) => g.provider === "anthropic")?.windows).toHaveLength(1);
    expect(groups.find((g) => g.provider === "openai")?.windows).toEqual([]);
    expect(groups.find((g) => g.provider === "acme")?.windows[0]?.status).toBe("unknown");
  });

  it("tolerates a non-object payload and still returns every expected group", () => {
    expect(buildProviderGroups(null).map((g) => g.provider)).toEqual(
      defaultProviderGroups().map((g) => g.provider),
    );
    expect(buildProviderGroups([]).map((g) => g.providerLabel)).toEqual(
      defaultProviderGroups().map((g) => g.providerLabel),
    );
  });
});

describe("ProviderLogo fallback", () => {
  it("renders MiniMax initials when no shipped logo exists", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderLogo, { providerKey: "minimax", providerLabel: "MiniMax" }),
    );
    expect(html).toContain("MI");
    expect(html).not.toContain("/logos/");
  });

  it("renders a question mark when the label has no letters", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderLogo, { providerKey: "unknown", providerLabel: "123" }),
    );
    expect(html).toContain("?");
  });
});

describe("mocked fetch -> buildProviderGroups pipeline", () => {
  it("produces the same grouped result the component's effect would compute", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mixedPayload,
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const res = await fetch("/api/quota-windows", { cache: "no-store" });
      const data = await res.json();
      const groups = buildProviderGroups(data);

      expect(fetchMock).toHaveBeenCalledWith("/api/quota-windows", { cache: "no-store" });
      expect(groups.map((g) => g.providerLabel)).toEqual(EXPECTED_LABELS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
