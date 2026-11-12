/**
 * User-facing copy for the dashboard Learn More page (UM-1363).
 * Plain language only — no fleet wiring, env vars, or internal tool names.
 */

export const LEARN_MORE_SENTENCE_GAP = "\u00a0 ";

export type LearnMoreSection = {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

export const LEARN_MORE_SECTIONS: readonly LearnMoreSection[] = [
  {
    id: "what-this-is",
    title: "What Usage Monitor Does",
    paragraphs: [
      `Usage Monitor adds up API and subscription spending so you can see month-to-date totals, compare them to budgets, and spot problems before a bill surprises you.${LEARN_MORE_SENTENCE_GAP}The hosted dashboard at usage.jays.services is the full picture in a browser.${LEARN_MORE_SENTENCE_GAP}The iPhone apps are companions: Usage Monitor Client syncs with that dashboard; Usage Monitor Local keeps everything on your phone.`,
    ],
  },
  {
    id: "provider-cards",
    title: "Provider Cards",
    paragraphs: [
      `Each provider is one vendor you pay for API access, hosting, data, or a subscription.${LEARN_MORE_SENTENCE_GAP}A card is a snapshot for that vendor — not a live invoice.`,
    ],
    bullets: [
      "Month-to-date spend — usage charges plus recurring fees this calendar month (UTC on the dashboard).",
      "Budget — the monthly cap you set in Settings; pacing shows whether you are on track to stay under it.",
      "Last updated — when Usage Monitor last refreshed numbers from the provider or from your linked apps.",
      "Cost coverage chips — Complete means priced usage for the period; Known is a partial priced total; not reported means cost is unverified, not confirmed zero.",
      "Renewal or plan rows — fixed monthly fees you entered, or plan renewals the app tracks for reminders.",
    ],
  },
  {
    id: "numbers-and-windows",
    title: "Numbers and Time Windows",
    paragraphs: [
      `Overview and Money pages roll up the same underlying charges at different zoom levels.${LEARN_MORE_SENTENCE_GAP}Projects attribute spend when events carry a project name you configured.`,
    ],
    bullets: [
      "History window — on Overview, the chart range (for example 7 or 30 days) filters the trend, not your budget month.",
      "Subscription quotas — on Overview and Agents, each row is a plan capacity window (for example a five-hour or weekly pool). The percentage is what is left, not what you used. Reset time is when the window refreshes.",
      "LLM burn cards — short recent token and cost activity for analytics; they do not change budget math.",
      "Recurring fees — Subscriptions in Settings post one charge per billing period so they count in month-to-date like metered usage.",
    ],
  },
  {
    id: "where-data-comes-from",
    title: "Where Data Comes From",
    paragraphs: [
      `Usage Monitor combines a few honest sources and avoids double-counting when two channels report the same spend.`,
    ],
    bullets: [
      "Scheduled checks — for many providers, the dashboard calls the vendor billing or usage API with keys you store encrypted in Settings.",
      "Linked apps — other products you run can send metered cost and usage events to your Usage Monitor server when configured.",
      "Coding tools — Claude Code and similar tools can report usage metrics to the dashboard when your environment is set up for it.",
      "Manual entries — subscriptions, plan fees, and owner-recorded expenses you add in Settings.",
      "iPhone Client — reads the hosted dashboard; it does not replace server-side collection.",
      "Local Monitor on iPhone — polls supported providers directly from the device; it does not need the hosted dashboard to stay up.",
    ],
  },
  {
    id: "when-something-looks-wrong",
    title: "When Something Looks Wrong",
    paragraphs: [
      `Most issues are missing permissions, stale data, or a provider that does not expose dollars through an API.`,
    ],
    bullets: [
      "Stale last updated — open the provider and use Refresh, or wait for the next scheduled check (about every 15 minutes on the server).",
      "not reported cost — add a management-style API key if the vendor requires one for billing data, or track the plan as a recurring fee.",
      "Budget looks too high or low — confirm you did not set both a plan fixed fee and a Subscription for the same charge.",
      "Quota section empty — subscription quotas need a Mac that reports plan windows to your dashboard; without that, the section stays empty.",
      "iPhone cannot connect — check HTTPS, dashboard password or read token, and any network allow list on the server.",
      "Still stuck — use Report a Problem on Support or email support; never send API keys in email.",
    ],
  },
] as const;

/** Product names and URLs allowed in copy; used by tests to forbid fleet jargon. */
export const LEARN_MORE_FORBIDDEN_PATTERN =
  /\b(ingest|producer|OTLP|USAGE_[A-Z_]+|BotFleet|lane|coordinator|GB-|BF-|gr_|LaunchAgent|quota-windows|mac-host)\b/i;
