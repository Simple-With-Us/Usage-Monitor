/**
 * Source-scan guard for the contrast-tokens a11y finding (Monet audit
 * 2026-08-01, remediated 2026-08-02).
 *
 * Bans exactly the class combinations that were removed because they fail
 * WCAG 2.x AA (4.5:1 for normal-size text) on this app's standard surfaces
 * (bg-white / bg-gray-50 in light mode, dark:bg-gray-800 / dark:bg-gray-900
 * in dark mode):
 *
 *   - `text-gray-400 dark:text-gray-500` — 2.54:1 on white, 3.04:1 on
 *     gray-800. The house muted-text pair is the inverse,
 *     `text-gray-500 dark:text-gray-400` (4.83:1 / 5.78:1).
 *   - the old status-vocab GRAY badge string
 *     `bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400`
 *     (4.39:1 / 4.06:1) — replaced by text-gray-700 / dark:text-gray-200.
 *
 * Deliberately conservative: only these exact strings are banned, so
 * legitimate single-class uses (e.g. `text-gray-400` on a dark-only surface,
 * or an aria-hidden decorative icon) do not trip it. If a line genuinely
 * needs a banned pair (decorative, aria-hidden, non-text), add an inline
 * `contrast-exempt` comment on that line and it is skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
// lib is included because the shared status-vocab badge strings (the old GRAY
// offender) live in src/lib, not in a .tsx file.
const SCAN_DIRS = [join(ROOT, "components"), join(ROOT, "app"), join(ROOT, "lib")];

const BANNED_PAIRS: { pattern: string; reason: string }[] = [
  {
    pattern: "text-gray-400 dark:text-gray-500",
    reason:
      "fails AA in both themes (2.54:1 light / 3.04:1 dark); use text-gray-500 dark:text-gray-400",
  },
  {
    pattern: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    reason:
      "old status-vocab GRAY badge (4.39:1 / 4.06:1); use bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  },
];

const EXEMPT_MARKER = "contrast-exempt";

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...collectTsxFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("text contrast source guard", () => {
  const files = SCAN_DIRS.flatMap((dir) => collectTsxFiles(dir));

  it("scans a plausible number of component/app files", () => {
    // Sanity check so a path refactor cannot silently turn this guard into a
    // no-op scanning zero files.
    expect(files.length).toBeGreaterThan(20);
  });

  it("contains no banned low-contrast class pairs", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(EXEMPT_MARKER)) return;
        for (const { pattern, reason } of BANNED_PAIRS) {
          if (line.includes(pattern)) {
            violations.push(
              `${relative(ROOT, file)}:${idx + 1} uses "${pattern}" (${reason})`
            );
          }
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
