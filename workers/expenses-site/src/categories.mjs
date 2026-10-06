/**
 * Expense categorization for the expenses dashboard.
 *
 * Maps a vendor/label pair to a stable category slug.  The slug is stored in
 * D1 at sync time so a future edit UI can override it without a migration.
 * Keep slugs stable: the dashboard filter bar and the JSON API both expose
 * them.
 */

export const CATEGORIES = {
  "tech-ai": "Tech / AI",
  "cloud-hosting": "Cloud / Hosting",
  "domains": "Domains",
  "software": "Software",
  "services": "Services",
  "other": "Other",
};

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
      /\bfly\.io\b/i,
      /\brender\.com\b/i,
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
      /\bhover\.com\b/i,
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
  for (const [slug, regexes] of RULES) {
    if (regexes.some((re) => re.test(haystack))) return slug;
  }
  return "other";
}

/** Human label for a category slug (Title Case for headings). */
export function categoryLabel(slug) {
  return CATEGORIES[slug] ?? CATEGORIES.other;
}
