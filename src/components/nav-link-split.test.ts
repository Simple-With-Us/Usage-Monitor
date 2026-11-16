import { describe, expect, it } from "vitest";
import { resolveNavViewportTier, splitNavLinks, type NavLink } from "./nav-link-split";

const PRIMARY: NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/providers", label: "Providers" },
  { href: "/money", label: "Money" },
  { href: "/projects", label: "Projects" },
  { href: "/alerts", label: "Alerts" },
  { href: "/platforms", label: "Platforms" },
  { href: "/ops", label: "Ops" },
  { href: "/settings", label: "Settings" },
];

const SECONDARY: NavLink[] = [
  { href: "/attribution", label: "Keys & Apps" },
  { href: "/cost-by-session", label: "Cost by Session" },
];

describe("splitNavLinks", () => {
  it("shows all links inline at xl with no overflow", () => {
    const { main, overflow } = splitNavLinks(PRIMARY, SECONDARY, "xl");
    expect(main).toHaveLength(PRIMARY.length + SECONDARY.length);
    expect(overflow).toHaveLength(0);
  });

  it("keeps five primary links at lg", () => {
    const { main, overflow } = splitNavLinks(PRIMARY, SECONDARY, "lg");
    expect(main.map((l) => l.href)).toEqual(PRIMARY.slice(0, 5).map((l) => l.href));
    expect(overflow.map((l) => l.href)).toEqual([
      ...PRIMARY.slice(5).map((l) => l.href),
      ...SECONDARY.map((l) => l.href),
    ]);
  });

  it("keeps four primary links at md", () => {
    const { main, overflow } = splitNavLinks(PRIMARY, SECONDARY, "md");
    expect(main).toHaveLength(4);
    expect(overflow).toHaveLength(PRIMARY.length - 4 + SECONDARY.length);
  });
});

describe("resolveNavViewportTier", () => {
  it("maps Tailwind breakpoints", () => {
    expect(resolveNavViewportTier(767)).toBe("md");
    expect(resolveNavViewportTier(768)).toBe("md");
    expect(resolveNavViewportTier(1023)).toBe("md");
    expect(resolveNavViewportTier(1024)).toBe("lg");
    expect(resolveNavViewportTier(1279)).toBe("lg");
    expect(resolveNavViewportTier(1280)).toBe("xl");
  });
});
