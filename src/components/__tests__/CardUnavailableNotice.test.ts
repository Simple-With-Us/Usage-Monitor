import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";

/**
 * Depth-first search over a React element tree for host elements of a given
 * tag. This harness is renderToStaticMarkup only (no jsdom), so click wiring
 * is verified by locating the element in the tree and invoking its handler
 * prop directly — CardUnavailableNotice has no hooks, so calling it as a
 * plain function is safe.
 */
function findByTag(node: unknown, tag: string, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findByTag(child, tag, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === tag) out.push(node);
  const props = node.props as { children?: unknown };
  findByTag(props.children, tag, out);
  return out;
}

describe("CardUnavailableNotice", () => {
  it("renders an explicit role=status notice with the title and detail", () => {
    const html = renderToStaticMarkup(
      createElement(CardUnavailableNotice, {
        title: "Claude Code cost cross-check unavailable.",
        detail: "The check will retry automatically.",
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Claude Code cost cross-check unavailable.");
    expect(html).toContain("The check will retry automatically.");
    // No onRetry prop means no Retry affordance.
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<button");
  });

  it("renders a Retry button when onRetry is provided", () => {
    const html = renderToStaticMarkup(
      createElement(CardUnavailableNotice, {
        title: "Sentry health unavailable.",
        onRetry: () => undefined,
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Retry");
  });

  it("fires the onRetry callback when the Retry button is clicked", () => {
    const onRetry = vi.fn();
    const tree = CardUnavailableNotice({
      title: "Card unavailable.",
      onRetry,
    });

    const buttons = findByTag(tree, "button");
    expect(buttons).toHaveLength(1);
    const onClick = (buttons[0].props as { onClick?: () => void }).onClick;
    expect(typeof onClick).toBe("function");
    onClick?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
