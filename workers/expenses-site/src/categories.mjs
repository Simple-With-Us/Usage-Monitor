/**
 * Expense categorization for the expenses dashboard.
 *
 * Two top-level sides: Personal and Tech.  Everything business goes under
 * Tech, keeping the subcategories below.  Personal is empty for now — no
 * personal transaction source is wired up yet.
 *
 * Maps a vendor/label pair to a stable category slug.  The slug is stored in
 * D1 at sync time so a future edit UI can override it without a migration.
 * Keep slugs stable: the dashboard filter bar and the JSON API both expose
 * them.
 *
 * A rule entry is either a RegExp (tested as-is) or a plain string (matched
 * as a case-insensitive substring — used for dotted names like "fly.io"
 * where regex word-boundary anchoring reads as a URL-host pattern).
 */

export const SIDES = {
  personal: "Personal",
  tech: "Tech",
};

export const CATEGORIES = {
  personal: "Personal",
  "tech-ai": "AI",
  "cloud-hosting": "Cloud / Hosting",
  "domains": "Domains",
  "software": "Software",
  "services": "Services",
  "other": "Other",
};

/** The top-level side a category belongs to.  Everything except Personal is Tech. */
export function sideForCategory(slug) {
  return slug === "personal" ? "personal" : "tech";
}

/** Human label for a side slug (Title Case for headings). */
export function sideLabel(slug) {
  return SIDES[slug] ?? SIDES.tech;
}

// [slug, regexes] — first match wins.  Tested against vendor + label joined.
const RULES = [
  [
    "tech-ai",
    [
      /\bopenai\b/i,
      /\banthropic\b/i,
      /\bclaude\b/i,
      /\bdeepseek\b/i,
      /\bxai\b/i,
      /\bgrok\b/i,
      /\bopenrouter\b/i,
      /\bminimax\b/i,
      /\bgemini\b/i,
      /\bcopilot\b/i,
      /\bcursor\b/i,
      /\bperplexity\b/i,
      /\bmistral\b/i,
      /\bcohere\b/i,
      /\bnvidia\b/i,
      /\bbase\s?ten\b/i,
      /\bmodal\b/i,
      /\breplicate\b/i,
      /\btogether\.?ai\b/i,
      /\bfireworks\.?ai\b/i,
      /\bhugging\s?face\b/i,
      /\bgroq\b/i,
      /\bcerebras\b/i,
      /\belevenlabs\b/i,
      /\bmidjourney\b/i,
      /\brunway\b/i,
      /\bantigravity\b/i,
      /\bchatgpt\b/i,
      /\bai\s+pro\b/i,
      /\bai\s+studio\b/i,
      /\bmachine learning\b/i,
    ],
  ],
  [
    "cloud-hosting",
    [
      /\bhetzner\b/i,
      /\bvercel\b/i,
      /\baws\b/i,
      /\bamazon web services\b/i,
      /\bdigitalocean\b/i,
      /\blinode\b/i,
      /\bakamai\b/i,
      "fly.io",
      "render.com",
      /\brailway\b/i,
      /\bnetlify\b/i,
      /\bvultr\b/i,
      /\bovh\b/i,
      /\boracle cloud\b/i,
    ],
  ],
  [
    "domains",
    [
      /\bporkbun\b/i,
      /\bnamecheap\b/i,
      /\bdnsimple\b/i,
      "hover.com",
      /\bgandi\b/i,
      /\bregistrar\b/i,
      /\bdomain renewal\b/i,
    ],
  ],
  [
    "software",
    [
      /\badobe\b/i,
      /\brogue amoeba\b/i,
      /\b1password\b/i,
      /\bjetbrains\b/i,
      /\bgithub\b/i,
      /\bfigma\b/i,
      /\bnotion\b/i,
      /\bslack\b/i,
      /\bzoom\b/i,
      /\bsetapp\b/i,
    ],
  ],
  [
    "services",
    [
      /\bapple\b/i,
      /\bicloud\b/i,
      /\bgoogle\b/i,
      /\bcloudflare\b/i,
      /\btailscale\b/i,
      /\bcontrol\s?d\b/i,
      /\bstripe\b/i,
    ],
  ],
];

/**
 * @param {string} vendor
 * @param {string | null | undefined} label
 * @returns {keyof typeof CATEGORIES}
 */
export function categorizeExpense(vendor, label) {
  const haystack = `${vendor ?? ""} ${label ?? ""}`;
  const lower = haystack.toLowerCase();
  for (const [slug, rules] of RULES) {
    if (
      rules.some((rule) =>
        typeof rule === "string" ? lower.includes(rule) : rule.test(haystack)
      )
    ) {
      return slug;
    }
  }
  return "other";
}

/** Human label for a category slug (Title Case for headings). */
export function categoryLabel(slug) {
  return CATEGORIES[slug] ?? CATEGORIES.other;
}
