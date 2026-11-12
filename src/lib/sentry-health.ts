// Read-only Sentry fleet-health summary for the dashboard's Sentry card.
//
// Goal split (owner-decided, see docs/rollouts and AGENTS.md): USAGE METRICS
// (tokens/cost/sessions) land in THIS app via the OTLP ingest route while
// application health & errors stay in Sentry, which this app monitors via Sentry's
// REST API to show "how many open issues does each project have".
//
// Sentry Application Metrics shipped in 2026 — the old "Sentry discontinued
// metrics ingestion" comment is stale.  Token/cost time series still stay here.
// App-health counters (`scheduler.tick`, `ingest.failed`) may emit to Sentry
// Metrics so they jump to the enclosing trace.  Do not move money/usage series
// into Sentry.
//
// Conditional by design: entirely absent (returns null, no fetch attempted)
// unless BOTH SENTRY_READ_TOKEN and SENTRY_ORG are configured. SENTRY_ORG
// defaults to "simple-with-us" per the task spec but can be overridden.
// SENTRY_READ_TOKEN is NEVER sent to the client — this module only runs
// server-side (API route handler), and the route response contains only the
// derived counts/links, never the token itself.

import {
  MAX_RETRY_AFTER_WAIT_MS,
  parseRetryAfterMs,
  sleep,
} from "./adapters/helpers";

export interface SentryProjectHealth {
  projectSlug: string;
  displayName: string;
  unresolvedCount: number;
  hasMore: boolean;
  issuesUrl: string;
  dashboardUrl?: string;
  datadogUrl?: string;
  error?: string;
}

export interface SentryHealthSummary {
  configured: true;
  org: string;
  fleetDashboardUrl?: string;
  projects: SentryProjectHealth[];
  fetchedAt: string;
}

export interface SentryHealthUnconfigured {
  configured: false;
}

const DEFAULT_ORG = "simple-with-us";

// Fallback wait before the single 429 retry when Sentry sends no
// Retry-After header. Mirrors the adapter helper first-attempt backoff.
const SENTRY_HEALTH_RETRY_BACKOFF_MS = 1_000;

const SENTRY_DASHBOARDS: Record<string, string> = {
  "fleet-overview": "https://simple-with-us.sentry.io/dashboard/9920702/",
  "congress-trade": "https://simple-with-us.sentry.io/dashboard/9920703/",
  "socratic-trade": "https://simple-with-us.sentry.io/dashboard/9920704/",
  "usage-monitor": "https://simple-with-us.sentry.io/dashboard/9920705/",
  "dealdex": "https://simple-with-us.sentry.io/dashboard/9920706/",
  "botfleet": "https://simple-with-us.sentry.io/dashboard/9920707/",
  "autorotate": "https://simple-with-us.sentry.io/dashboard/9920708/",
  "fleet-infra": "https://simple-with-us.sentry.io/dashboard/9920709/",
};

const DATADOG_SERVICES: Record<string, string> = {
  "congress-trade": "https://app.us5.datadoghq.com/apm/service/congress-trade",
  "socratic-trade": "https://app.us5.datadoghq.com/apm/service/socratic-trade",
  "usage-monitor": "https://app.us5.datadoghq.com/apm/service/usage-monitor",
  "dealdex": "https://app.us5.datadoghq.com/apm/service/dealdex",
  "botfleet": "https://app.us5.datadoghq.com/apm/service/botfleet",
  "fleet-infra": "https://app.us5.datadoghq.com/apm/service/fleet-infra",
};

// The three sibling projects named in the task spec, plus this app itself
// (review finding O4d: now that the app reports its own errors to Sentry,
// its own project belongs on the same health card). The fleet entries stay a
// small static list (not env-configurable) since this card is scoped to the
// owner's known fleet, same as how provider adapters are a fixed built-in
// list. The self-project slug IS env-configurable (SENTRY_SELF_PROJECT) so it
// can track the actual Sentry project name; default "usage-monitor".
const DEFAULT_SELF_PROJECT_SLUG = "usage-monitor";

const TRACKED_FLEET_PROJECTS = [
  { slug: "socratic-trade", displayName: "Socratic Trade" },
  { slug: "congress-trade", displayName: "Congress Trade" },
  { slug: "fleet-infra", displayName: "Fleet Infra" },
  { slug: "dealdex", displayName: "DealDex" },
  { slug: "botfleet", displayName: "BotFleet" },
  { slug: "autorotate", displayName: "Autorotate" },
  { slug: "contactlogo", displayName: "ContactLogo" },
];

function trackedProjects(): Array<{ slug: string; displayName: string }> {
  const selfSlug =
    process.env.SENTRY_SELF_PROJECT?.trim() || DEFAULT_SELF_PROJECT_SLUG;
  const projects = [
    { slug: selfSlug, displayName: "Usage Monitor (this app)" },
    ...TRACKED_FLEET_PROJECTS,
  ];
  // Defensive dedupe: if SENTRY_SELF_PROJECT is ever set to a slug already in
  // the fleet list, fetch it once rather than showing the same project twice.
  return projects.filter(
    (project, index) =>
      projects.findIndex((other) => other.slug === project.slug) === index
  );
}

function sentryConfig(): { token: string; org: string } | undefined {
  const token = (
    process.env.SENTRY_READ_TOKEN ||
    process.env.SENTRY_AUTH_TOKEN_FULLSCOPE ||
    process.env.SENTRY_ADMIN ||
    process.env.SENTRY_AUTH_TOKEN
  )?.trim();
  if (!token) return undefined;
  const org = process.env.SENTRY_ORG?.trim() || DEFAULT_ORG;
  return { token, org };
}

export function isSentryHealthConfigured(): boolean {
  return sentryConfig() !== undefined;
}

/**
 * Parses Sentry's RFC 5988 Link header (used for cursor pagination) to see
 * if a "next" page exists — this is how we report `hasMore` without
 * assuming Sentry returns a total-count header (it doesn't, reliably).
 */
function linkHeaderHasNext(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /rel="next";\s*results="true"/.test(linkHeader) || /results="true"/.test(linkHeader);
}

async function fetchProjectHealth(
  org: string,
  token: string,
  project: { slug: string; displayName: string }
): Promise<SentryProjectHealth> {
  const issuesUrl = `https://sentry.io/organizations/${org}/issues/?project=${project.slug}&query=is%3Aunresolved`;
  const dashboardUrl = SENTRY_DASHBOARDS[project.slug];
  const datadogUrl = DATADOG_SERVICES[project.slug];

  try {
    const res = await fetch(
      `https://sentry.io/api/0/projects/${org}/${project.slug}/issues/?query=is%3Aunresolved&statsPeriod=14d&limit=100`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // Sentry health is a dashboard nicety, not something budgets/alerts
        // depend on — fail fast rather than hang the page load.
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!res.ok) {
      // Status reported when every attempt fails. Updated by the retry below
      // so a retry that fails with a different status reports the retry
      // status instead of masking it behind the original 429 (sentry[bot]
      // review on #1507).
      let finalStatus = res.status;
      if (res.status === 429) {
        // Paced retry on burst rate limit: honor the Retry-After header
        // when present (capped like the adapter retry helper), otherwise fall
        // back to a short fixed backoff (sentry[bot] review on #1507).
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const withinCap =
          retryAfterMs == null || retryAfterMs <= MAX_RETRY_AFTER_WAIT_MS;
        if (withinCap) {
          await sleep(
            retryAfterMs != null && retryAfterMs > 0
              ? retryAfterMs
              : SENTRY_HEALTH_RETRY_BACKOFF_MS
          );
          const retryRes = await fetch(
            `https://sentry.io/api/0/projects/${org}/${project.slug}/issues/?query=is%3Aunresolved&statsPeriod=14d&limit=100`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(8_000),
            }
          );
          finalStatus = retryRes.status;
          if (retryRes.ok) {
            const retryData = (await retryRes.json()) as unknown;
            const retryCount = Array.isArray(retryData) ? retryData.length : 0;
            return {
              projectSlug: project.slug,
              displayName: project.displayName,
              unresolvedCount: retryCount,
              hasMore: linkHeaderHasNext(retryRes.headers.get("link")),
              issuesUrl,
              dashboardUrl,
              datadogUrl,
            };
            }
        }
      }

      return {
        projectSlug: project.slug,
        displayName: project.displayName,
        unresolvedCount: 0,
        hasMore: false,
        issuesUrl,
        dashboardUrl,
        datadogUrl,
        error: `HTTP ${finalStatus}`,
      };
    }

    const data = (await res.json()) as unknown;
    const count = Array.isArray(data) ? data.length : 0;
    return {
      projectSlug: project.slug,
      displayName: project.displayName,
      unresolvedCount: count,
      hasMore: linkHeaderHasNext(res.headers.get("link")),
      issuesUrl,
      dashboardUrl,
      datadogUrl,
    };
  } catch (error) {
    return {
      projectSlug: project.slug,
      displayName: project.displayName,
      unresolvedCount: 0,
      hasMore: false,
      issuesUrl,
      dashboardUrl,
      datadogUrl,
      error: error instanceof Error ? error.message : "Failed to reach Sentry",
    };
  }
}

/**
 * Returns `{ configured: false }` when SENTRY_READ_TOKEN/SENTRY_ORG aren't
 * set (the card should render nothing in that case), otherwise fetches
 * per-project unresolved-issue counts. Never throws — a per-project fetch
 * failure is captured in that project's `error` field so one bad project
 * doesn't blank the whole card.
 */
export async function fetchSentryHealth(): Promise<SentryHealthSummary | SentryHealthUnconfigured> {
  const config = sentryConfig();
  if (!config) return { configured: false };

  const projects: SentryProjectHealth[] = [];
  for (const project of trackedProjects()) {
    projects.push(await fetchProjectHealth(config.org, config.token, project));
    await new Promise((r) => setTimeout(r, 60));
  }

  return {
    configured: true,
    org: config.org,
    fleetDashboardUrl: SENTRY_DASHBOARDS["fleet-overview"],
    projects,
    fetchedAt: new Date().toISOString(),
  };
}
