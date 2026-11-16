export type NavLink = { href: string; label: string };

export type NavViewportTier = "md" | "lg" | "xl";

/** How many primary links stay inline before More takes the rest (+ all secondary). */
export function splitNavLinks(
  primary: readonly NavLink[],
  secondary: readonly NavLink[],
  tier: NavViewportTier
): { main: NavLink[]; overflow: NavLink[] } {
  if (tier === "xl") {
    return { main: [...primary, ...secondary], overflow: [] };
  }
  const inlinePrimaryCount = tier === "lg" ? 5 : 4;
  return {
    main: primary.slice(0, inlinePrimaryCount),
    overflow: [...primary.slice(inlinePrimaryCount), ...secondary],
  };
}

/** Tailwind-aligned tiers for the desktop nav (md+ only). */
export function resolveNavViewportTier(widthPx: number): NavViewportTier {
  if (widthPx >= 1280) return "xl";
  if (widthPx >= 1024) return "lg";
  return "md";
}
