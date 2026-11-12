import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardAttentionPanel from "@/components/DashboardAttentionPanel";

/**
 * This harness is renderToStaticMarkup only (no jsdom), and the panel's
 * "Show all" toggle lives in a useState hook. To drive both sides of the
 * toggle deterministically, useState is stubbed with a controllable cell:
 * source modules get the stub while externalized deps (react-dom/server,
 * next/link) keep the real react, so static rendering still works. The
 * toggle's onClick wiring is verified by invoking the handler from the
 * element tree and asserting the state updater it passes flips the flag.
 */
const hookState = vi.hoisted(() => ({
  showAll: false,
  setShowAll: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (() => [hookState.showAll, hookState.setShowAll]) as typeof actual.useState,
  };
});

function findButtons(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === "button") out.push(node);
  const props = node.props as { children?: unknown };
  findButtons(props.children, out);
  return out;
}

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    provider: {
      id: `provider-${i + 1}`,
      displayName: `Provider ${i + 1}`,
      label: null,
    },
    alert: {
      severity: "warning" as const,
      message: `attention-message-${i + 1}`,
    },
  }));
}

describe("DashboardAttentionPanel truncation", () => {
  beforeEach(() => {
    hookState.showAll = false;
    hookState.setShowAll.mockClear();
  });

  it("shows only the first 8 of 10 alerts plus a Show-all toggle with aria-expanded=false", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardAttentionPanel, { attentionItems: items(10) })
    );

    for (let i = 1; i <= 8; i++) {
      expect(html).toContain(`attention-message-${i}`);
    }
    expect(html).not.toContain("attention-message-9");
    expect(html).not.toContain("attention-message-10");
    expect(html).toContain("Show all 10 alerts");
    expect(html).toContain('aria-expanded="false"');
  });

  it("clicking the toggle flips the showAll state", () => {
    const tree = DashboardAttentionPanel({ attentionItems: items(10) });
    const toggle = findButtons(tree).find(
      (button) => "aria-expanded" in (button.props as Record<string, unknown>)
    );
    expect(toggle).toBeDefined();

    const onClick = (toggle!.props as { onClick?: () => void }).onClick;
    expect(typeof onClick).toBe("function");
    onClick?.();

    expect(hookState.setShowAll).toHaveBeenCalledTimes(1);
    const updater = hookState.setShowAll.mock.calls[0][0] as (prev: boolean) => boolean;
    expect(updater(false)).toBe(true);
    expect(updater(true)).toBe(false);
  });

  it("expanded state reveals all 10 alerts and offers Show fewer with aria-expanded=true", () => {
    hookState.showAll = true;
    const html = renderToStaticMarkup(
      createElement(DashboardAttentionPanel, { attentionItems: items(10) })
    );

    for (let i = 1; i <= 10; i++) {
      expect(html).toContain(`attention-message-${i}`);
    }
    expect(html).toContain("Show fewer alerts");
    expect(html).toContain('aria-expanded="true"');
  });

  it("renders 3 alerts in full with no toggle", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardAttentionPanel, { attentionItems: items(3) })
    );

    for (let i = 1; i <= 3; i++) {
      expect(html).toContain(`attention-message-${i}`);
    }
    expect(html).not.toContain("Show all");
    expect(html).not.toContain("aria-expanded");
  });
});
