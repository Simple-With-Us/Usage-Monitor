// @vitest-environment jsdom
/**
 * Component test for the B2 app-usage card's Daily stacked-bar view.
 *
 * Follows the repo's jsdom + @testing-library/react pattern (see
 * `FleetBudgetCard.test.tsx`): the card fetches `/api/b2-app-usage` in a
 * `useEffect`, so `fetch` is mocked and the rendered markup is asserted
 * against the real component.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import B2AppUsageBreakdownCard from "../B2AppUsageBreakdownCard";
import type { B2AppUsageBreakdownPayload } from "@/lib/b2-app-usage-types";

const fetchMock = vi.fn();

function payload(
  overrides: Partial<B2AppUsageBreakdownPayload> = {}
): B2AppUsageBreakdownPayload {
  return {
    configured: true,
    asOf: "2026-10-22T00:00:00.000Z",
    cacheAgeSeconds: 0,
    reportDate: "2026-10-21",
    storageSource: "external_billing",
    reportSource: "usage_csv",
    warnings: [],
    caps: { classCDailyFree: 2500, downloadGbDailyFree: 1 },
    alerts: { classCNearCap: false, downloadNearCap: false, classCSpike: false },
    apps: [
      {
        id: "socratic-trade",
        label: "Socratic Trade",
        bucketNames: ["jays-socratic-trade-eu"],
        storageGb: 150,
        latestDay: {
          date: "2026-10-21",
          storedGb: 150,
          downloadedGb: 0.6,
          classCTransactions: 900,
          classBTransactions: 40,
        },
      },
      {
        id: "usage-monitor",
        label: "Usage Monitor",
        bucketNames: ["jays-usage-monitor-eu"],
        storageGb: 12,
        latestDay: {
          date: "2026-10-21",
          storedGb: 12,
          downloadedGb: 0.4,
          classCTransactions: 300,
          classBTransactions: 10,
        },
      },
    ],
    dailySeries: [
      {
        date: "2026-10-21",
        accountDownloadedGb: 1,
        accountClassCTotal: 1200,
        byApp: {
          "socratic-trade": { downloadedGb: 0.6, classCTransactions: 900 },
          "usage-monitor": { downloadedGb: 0.4, classCTransactions: 300 },
        },
      },
      {
        date: "2026-10-20",
        accountDownloadedGb: 0.5,
        accountClassCTotal: 800,
        byApp: {
          "socratic-trade": { downloadedGb: 0.5, classCTransactions: 800 },
        },
      },
      {
        date: "2026-10-19",
        accountDownloadedGb: 1.4,
        accountClassCTotal: 2000,
        byApp: {
          "socratic-trade": { downloadedGb: 0.9, classCTransactions: 1200 },
          "usage-monitor": { downloadedGb: 0.5, classCTransactions: 800 },
        },
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function dailyBars(): HTMLElement[] {
  return screen.queryAllByRole("img").filter((el) =>
    (el.getAttribute("aria-label") ?? "").match(/^\d{4}-\d{2}-\d{2}:/),
  );
}

describe("B2AppUsageBreakdownCard daily view", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders one stacked bar per day, newest first, with an accessible label", async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));

    render(<B2AppUsageBreakdownCard />);

    await screen.findByRole("img", { name: /^2026-10-21:/ });

    const bars = dailyBars();
    expect(bars.length).toBe(3);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "2026-10-21: Socratic Trade 0.6 GB, Usage Monitor 0.4 GB, 0 GB left of 1 GB free cap",
      "2026-10-20: Socratic Trade 0.5 GB, 0.5 GB left of 1 GB free cap",
      "2026-10-19: Socratic Trade 0.9 GB, Usage Monitor 0.5 GB, 0.4 GB over the 1 GB free cap",
    ]);

    // The Daily view is the default, so the donut/bar chart is not rendered.
    expect((screen.getByLabelText("Chart view") as HTMLSelectElement).value).toBe("daily");
  });

  it("flags a day over the daily free cap and fills the bar without headroom", async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));

    render(<B2AppUsageBreakdownCard />);

    const overCapBar = await screen.findByRole("img", { name: /^2026-10-19:/ });
    expect(screen.getByText("Over Cap")).toBeTruthy();
    expect(overCapBar.getAttribute("aria-label")).toBe(
      "2026-10-19: Socratic Trade 0.9 GB, Usage Monitor 0.5 GB, 0.4 GB over the 1 GB free cap",
    );

    // Over-cap bar: no emerald headroom segment, used segments fill the track.
    expect(overCapBar.querySelector(".bg-emerald-600")).toBeNull();
    const overCapUsed = Array.from(overCapBar.querySelectorAll("div")).filter((el) =>
      (el.className ?? "").includes("bg-red-"),
    );
    expect(overCapUsed.length).toBeGreaterThan(0);

    // A day under the cap keeps the emerald headroom.
    const underCapBar = screen.getByRole("img", { name: /^2026-10-20:/ });
    expect(underCapBar.querySelector(".bg-emerald-600")).not.toBeNull();
  });

  it("renders an empty state when the daily series is empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload({ dailySeries: [] })));

    render(<B2AppUsageBreakdownCard />);

    expect(await screen.findByText("No daily usage data yet.")).toBeTruthy();
    expect(dailyBars().length).toBe(0);
  });

  it("switches the daily metric between download GB and Class C transactions", async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));

    render(<B2AppUsageBreakdownCard />);

    await screen.findByRole("img", { name: /^2026-10-21:/ });

    fireEvent.change(screen.getByLabelText("B2 metric"), { target: { value: "classC" } });

    const classCBars = await screen.findAllByRole("img");
    const labels = classCBars
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("2026-"));
    expect(labels[0]).toBe(
      "2026-10-21: Socratic Trade 900 Class C txns, Usage Monitor 300 Class C txns, 1,300 Class C txns left of 2,500 Class C txns free cap",
    );
  });

  it("counts account-level usage above the bucket sum as unattributed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        payload({
          dailySeries: [
            {
              date: "2026-10-21",
              // Account row exceeds the bucket rows (deleted buckets,
              // unattributed operations): the bar must reflect the account
              // total, not just the 0.6 GB of attributed buckets.
              accountDownloadedGb: 1.2,
              accountClassCTotal: 900,
              byApp: {
                "socratic-trade": { downloadedGb: 0.6, classCTransactions: 900 },
              },
            },
          ],
        }),
      ),
    );

    render(<B2AppUsageBreakdownCard />);

    const bar = await screen.findByRole("img", { name: /^2026-10-21:/ });
    expect(bar.getAttribute("aria-label")).toBe(
      "2026-10-21: Socratic Trade 0.6 GB, Unattributed 0.6 GB, 0.2 GB over the 1 GB free cap",
    );
    expect(screen.getByText("Over Cap")).toBeTruthy();
    // The unattributed slice renders in gray, not as emerald headroom.
    expect(bar.querySelector(".bg-gray-400")).not.toBeNull();
    expect(bar.querySelector(".bg-emerald-600")).toBeNull();
  });

  it("keeps the donut and bar views reachable and leaves storage on the old view", async () => {
    fetchMock.mockResolvedValue(jsonResponse(payload()));

    render(<B2AppUsageBreakdownCard />);

    await screen.findByRole("img", { name: /^2026-10-21:/ });

    fireEvent.change(screen.getByLabelText("B2 metric"), { target: { value: "storage" } });

    const viewSelect = screen.getByLabelText("Chart view") as HTMLSelectElement;
    expect(viewSelect.value).toBe("donut");
    expect(
      Array.from(viewSelect.options).map((option) => option.value),
    ).toEqual(["donut", "bar"]);
    expect(dailyBars().length).toBe(0);
  });
});
