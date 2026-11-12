/**
 * BalanceBadge is rendered from ProviderCard / provider detail, which never
 * exercise a signed amount in unit tests.  Cover the null / credit / debit
 * branches so global branch coverage stays at the 70% CI gate.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import BalanceBadge from "@/components/BalanceBadge";

describe("BalanceBadge", () => {
  it("renders the shared null display when amount is missing", () => {
    const html = renderToStaticMarkup(createElement(BalanceBadge, { amount: null }));
    expect(html).toContain("--");
    expect(html).not.toContain("$");
  });

  it("renders a credit in emerald and a debit with a leading minus", () => {
    const credit = renderToStaticMarkup(createElement(BalanceBadge, { amount: 12.5 }));
    const debit = renderToStaticMarkup(
      createElement(BalanceBadge, { amount: -3, className: "extra" }),
    );
    expect(credit).toContain("text-emerald-600");
    expect(debit).toContain("text-red-600");
    expect(debit).toContain("-");
    expect(debit).toContain("extra");
  });
});
