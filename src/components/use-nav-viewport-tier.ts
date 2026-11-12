"use client";

import { useEffect, useState } from "react";
import { resolveNavViewportTier, type NavViewportTier } from "@/components/nav-link-split";

const QUERIES = [
  { tier: "xl" as const, query: "(min-width: 1280px)" },
  { tier: "lg" as const, query: "(min-width: 1024px)" },
] as const;

/**
 * Desktop nav tier (md / lg / xl). Null until mounted so SSR and the first paint
 * do not assume a width.
 */
export function useNavViewportTier(): NavViewportTier | null {
  const [tier, setTier] = useState<NavViewportTier | null>(null);

  useEffect(() => {
    const read = () => setTier(resolveNavViewportTier(window.innerWidth));

    read();

    const cleanups: (() => void)[] = [];
    for (const { query } of QUERIES) {
      const mql = window.matchMedia(query);
      const onChange = () => read();
      mql.addEventListener("change", onChange);
      cleanups.push(() => mql.removeEventListener("change", onChange));
    }
    window.addEventListener("resize", read);
    cleanups.push(() => window.removeEventListener("resize", read));

    return () => {
      for (const fn of cleanups) fn();
    };
  }, []);

  return tier;
}
