import { describe, expect, it } from "vitest";
import { esc, formatAmount, formatDate, renderDashboard } from "../render.mjs";

const rows = [
  {
    idempotency_key: "k1",
    vendor: "Anthropic",
    amount_usd: 213.2,
    occurred_at: "2026-09-30T12:00:00.000Z",
    kind: "usage",
    label: "API usage",
    category: "tech-ai",
  },
  {
    idempotency_key: "k2",
    vendor: "Hetzner",
    amount_usd: 27.09,
    occurred_at: "2026-09-28T12:00:00.000Z",
    kind: "subscription",
    label: "Server",
    category: "cloud-hosting",
  },
];

describe("renderDashboard", () => {
  it("renders a Title Case heading and the 6-month window note", () => {
    const html = renderDashboard(rows, "2026-10-05T00:00:00Z", 42);
    expect(html).toContain("<h1>Business Expenses</h1>");
    expect(html).toContain("Last 6 months, rolling.");
    expect(html).toContain("Showing 2 of 42 recorded expenses.");
  });

  it("shows All and Tech / AI filters prominently, plus present categories", () => {
    const html = renderDashboard(rows, "2026-10-05T00:00:00Z", 2);
    expect(html).toContain('data-filter="all"');
    expect(html).toContain("Tech / AI");
    expect(html).toContain("Cloud / Hosting");
  });

  it("renders vendor, formatted amount, and category pill per row", () => {
    const html = renderDashboard(rows, "2026-10-05T00:00:00Z", 2);
    expect(html).toContain("Anthropic");
    expect(html).toContain("$213.20");
    expect(html).toContain("Sep 30, 2026");
    expect(html).toContain("Tech / AI");
  });

  it("escapes hostile vendor text", () => {
    const evil = [
      { ...rows[0], vendor: "<script>alert(1)</script>", label: null },
    ];
    const html = renderDashboard(evil, "2026-10-05T00:00:00Z", 1);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders an empty state with no rows", () => {
    const html = renderDashboard([], "never", 0);
    expect(html).toContain("No expenses in the last 6 months yet.");
  });
});

describe("formatters", () => {
  it("formats USD amounts", () => {
    expect(formatAmount(213.2)).toBe("$213.20");
    expect(formatAmount(1000)).toBe("$1,000.00");
  });

  it("formats dates in Central time", () => {
    expect(formatDate("2026-10-05T12:00:00.000Z")).toBe("Oct 5, 2026");
  });

  it("escapes HTML", () => {
    expect(esc('<b>"&"</b>')).toBe("&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;");
  });
});
