/**
 * Observability probes — "is anything screaming at us right now".
 *
 * Four platforms answer four different questions:
 *  - Sentry: are there unresolved errors in any fleet project?
 *  - UptimeRobot: is every public endpoint answering?
 *  - PagerDuty: is anyone being paged right now?
 *  - Datadog: are we still inside Infrastructure Free (hosts / logs / APM)?
 *
 * Sentry reuses `@/lib/sentry-health`, which already fetches per-project
 * unresolved counts for the dashboard's Sentry card — this probe renders that
 * same summary as a platform card rather than issuing its own requests.  The
 * other two are new read-only integrations and go through `requestJson`, which
 * carries the adapter stack's HTTPS-only, size-bounded, timeout-bounded rules.
 *
 * Related context: `src/app/api/openrouter-credits/route.ts` is the public
 * keyword endpoint UptimeRobot polls for OpenRouter credit exhaustion, so a
 * down monitor here can mean "the money probe went dark", not just "a page is
 * slow".
 *
 * Nothing credential-shaped is rendered.  UptimeRobot in particular echoes the
 * offending value back in its `error.passed_value` field on a bad key — that
 * field is never read into a metric or headline.
 *
 * UptimeRobot and PagerDuty both paginate their lists, so both probes walk the
 * pages under an explicit page cap and time budget — see "Bounded pagination"
 * below.  The rule those bounds exist to protect: a count drawn from a partial
 * list is never reported as an authoritative "healthy".
 */

import { fetchSentryHealth, isSentryHealthConfigured } from "@/lib/sentry-health";
import {
  DATADOG_HOST_CAP,
  fetchDatadogUsage,
  isDatadogUsageConfigured,
} from "@/lib/datadog-usage";
import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  finiteNumber,
  formatAge,
  formatCount,
  formatPercent,
  hasEnv,
  metric,
  PROBE_TIMEOUT_MS,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import {
  MAX_PLATFORM_METRICS,
  type PlatformMetric,
  type PlatformProbe,
  type PlatformProbeResult,
} from "../types";

// ---------------------------------------------------------------------------
// Bounded pagination
// ---------------------------------------------------------------------------

/**
 * UptimeRobot and PagerDuty both answer "is anything wrong" by listing rows,
 * and both truncate that list.  A single page is not evidence: a fleet whose
 * first 50 monitors are all up can still have a down monitor on page two, and
 * a first page of purely acknowledged incidents can still hide a triggered one
 * behind `more: true`.  So both probes paginate — but a probe runs inside a
 * fleet-wide sweep that `registry.collect` awaits with no overall deadline, so
 * a huge account must not be able to hold the whole page open.
 *
 * Two bounds apply.  A hard page cap stops the row count from growing without
 * limit, and a wall-clock budget stops a slow upstream even when few pages are
 * involved: each additional request is given only the time left in the budget,
 * so total probe latency stays near `PAGINATION_BUDGET_MS` rather than
 * multiplying `PROBE_TIMEOUT_MS` by the page cap.
 *
 * Whichever bound trips first, coverage is then *partial*, and a partial list
 * may never be reported as an authoritative "healthy" — see the `stale`
 * branches below.
 */
const PAGINATION_BUDGET_MS = 12_000;

/** Not worth starting another page with less than this left in the budget. */
const MIN_PAGE_TIMEOUT_MS = 1_000;

/**
 * Timeout to give the next page, or `null` when the budget is spent and the
 * caller should stop with whatever it has.
 */
function nextPageTimeout(deadline: number): number | null {
  const remaining = deadline - Date.now();
  return remaining >= MIN_PAGE_TIMEOUT_MS ? Math.min(PROBE_TIMEOUT_MS, remaining) : null;
}

/**
 * One honest sentence about what a truncated sweep did *not* look at.  Falls
 * back to a count-free phrasing when the upstream never reported a total, so
 * the card never implies a precision it does not have.
 */
function uncheckedSentence(inspected: number, reportedTotal: number | null): string {
  const unchecked =
    reportedTotal !== null && reportedTotal > inspected ? reportedTotal - inspected : null;
  return unchecked === null
    ? `Only the first ${inspected.toLocaleString("en-US")} were checked.`
    : `${unchecked.toLocaleString("en-US")} more were not checked.`;
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

async function probeSentry(): Promise<PlatformProbeResult> {
  try {
    const health = await fetchSentryHealth();
    if (!health.configured) {
      // Only reachable if the token disappeared between isConfigured() and here.
      return {
        state: "unavailable",
        headline: "Sentry credentials are no longer readable.",
        metrics: [],
        error: "not_configured",
      };
    }

    const projects = health.projects;
    const readable = projects.filter((project) => !project.error);
    const failed = projects.length - readable.length;
    const total = readable.reduce((sum, project) => sum + project.unresolvedCount, 0);
    const affected = readable.filter((project) => project.unresolvedCount > 0).length;
    const anyMore = readable.some((project) => project.hasMore);

    const metrics: PlatformMetric[] = [
      metric(
        "Unresolved Issues",
        anyMore ? `${total.toLocaleString("en-US")}+ issues` : formatCount(total, "issue"),
        "last 14 days"
      ),
      ...projects.map((project) =>
        project.error
          ? metric(project.displayName, "Unavailable", "read failed")
          : metric(
              project.displayName,
              project.hasMore
                ? `${project.unresolvedCount.toLocaleString("en-US")}+ issues`
                : formatCount(project.unresolvedCount, "issue")
            )
      ),
    ].slice(0, MAX_PLATFORM_METRICS);

    if (failed > 0 && readable.length === 0) {
      return {
        state: "unavailable",
        headline: "Sentry issue counts could not be read.  Check the read token.",
        metrics: [],
        error: "read_failed",
      };
    }

    const readFailureSentence =
      failed > 0 ? `  ${failed} project ${failed === 1 ? "read" : "reads"} failed.` : "";

    if (total > 0) {
      return {
        state: "degraded",
        headline:
          `${formatCount(total, "unresolved issue")} across ${affected} of ` +
          `${readable.length} ${readable.length === 1 ? "project" : "projects"}.` +
          readFailureSentence,
        metrics,
        ...(failed > 0 ? { error: "partial_read" } : {}),
      };
    }

    if (failed > 0) {
      return {
        state: "degraded",
        headline: `No unresolved issues in the projects that answered.${readFailureSentence}`,
        metrics,
        error: "partial_read",
      };
    }

    return {
      state: "healthy",
      headline: `No unresolved issues across ${readable.length} tracked ${
        readable.length === 1 ? "project" : "projects"
      }.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Sentry could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// UptimeRobot
// ---------------------------------------------------------------------------

const UPTIMEROBOT_MONITORS_URL = "https://api.uptimerobot.com/v2/getMonitors";
/** Uptime window requested from UptimeRobot, in days. */
const UPTIMEROBOT_RATIO_DAYS = 30;
/** UptimeRobot caps `limit` at 50 per page. */
const UPTIMEROBOT_PAGE_LIMIT = 50;
/** Page cap: 300 monitors is far past this fleet, and bounds a huge account. */
const UPTIMEROBOT_MAX_PAGES = 6;

/** v2 monitor status codes.  Anything else is treated as "not checked yet". */
const UPTIMEROBOT_PAUSED = 0;
const UPTIMEROBOT_UP = 2;
const UPTIMEROBOT_SEEMS_DOWN = 8;
const UPTIMEROBOT_DOWN = 9;

/** First uptime ratio in UptimeRobot's comma-separated `custom_uptime_ratio`. */
function firstRatio(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const head = raw.split(",")[0]?.trim();
  if (!head) return null;
  const parsed = Number(head);
  return Number.isFinite(parsed) ? parsed : null;
}

type UptimeRobotPage =
  | { kind: "failure"; result: PlatformProbeResult }
  | {
      kind: "page";
      monitors: (Record<string, unknown> | undefined)[];
      /** `pagination.total` when the API reported one. */
      total: number | null;
    };

/** Fetch one page of monitors, mapping every upstream refusal onto a card. */
async function fetchUptimeRobotPage(
  apiKey: string,
  offset: number,
  timeoutMs: number
): Promise<UptimeRobotPage> {
  const body = new URLSearchParams({
    api_key: apiKey,
    format: "json",
    custom_uptime_ratios: String(UPTIMEROBOT_RATIO_DAYS),
    limit: String(UPTIMEROBOT_PAGE_LIMIT),
    offset: String(offset),
  });

  const response = await requestJson(
    UPTIMEROBOT_MONITORS_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    },
    { timeoutMs }
  );

  if (!response.ok) {
    return {
      kind: "failure",
      result: upstreamFailure(response.status, "UptimeRobot did not return monitor status."),
    };
  }

  const payload = asRecord(response.data);
  if (!payload) {
    return {
      kind: "failure",
      result: {
        state: "degraded",
        headline: "UptimeRobot returned an unexpected response.",
        metrics: [],
        error: "invalid_response",
      },
    };
  }

  // UptimeRobot answers HTTP 200 with `stat: "fail"` for a rejected key.  Its
  // error object echoes the submitted value, so only the parameter name is
  // ever inspected and none of it is rendered.
  if (payload.stat !== "ok") {
    const failure = asRecord(payload.error);
    const parameter = typeof failure?.parameter_name === "string" ? failure.parameter_name : "";
    const keyRejected = parameter === "api_key";
    return {
      kind: "failure",
      result: {
        state: keyRejected ? "unavailable" : "degraded",
        headline: keyRejected
          ? "UptimeRobot rejected the API key."
          : "UptimeRobot rejected the monitor request.",
        metrics: [],
        error: keyRejected ? "unauthorized" : "upstream_error",
      },
    };
  }

  return {
    kind: "page",
    monitors: asArray(payload.monitors).map(asRecord),
    total: finiteNumber(asRecord(payload.pagination)?.total),
  };
}

async function probeUptimeRobot(): Promise<PlatformProbeResult> {
  const apiKey = envValue("UPTIMEROBOT_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "UptimeRobot credentials are no longer readable.",
      metrics: [],
      error: "not_configured",
    };
  }

  try {
    const deadline = Date.now() + PAGINATION_BUDGET_MS;
    const monitors: (Record<string, unknown> | undefined)[] = [];
    let reportedTotal: number | null = null;
    /** True only once we know we have seen every monitor in the account. */
    let coverageComplete = false;

    for (let page = 0; page < UPTIMEROBOT_MAX_PAGES; page += 1) {
      // The first page always gets the full probe timeout: without it there is
      // nothing to render at all.  Later pages spend only what is left.
      const timeoutMs = page === 0 ? PROBE_TIMEOUT_MS : nextPageTimeout(deadline);
      if (timeoutMs === null) break;

      const outcome = await fetchUptimeRobotPage(apiKey, monitors.length, timeoutMs);
      if (outcome.kind === "failure") {
        // Failing on page one means we learned nothing, so the typed failure is
        // the whole story.  Failing later still leaves real monitors on the
        // card, so keep them and fall through to the partial-coverage branch.
        if (page === 0) return outcome.result;
        break;
      }

      monitors.push(...outcome.monitors);
      if (outcome.total !== null) reportedTotal = outcome.total;

      if (reportedTotal !== null) {
        if (monitors.length >= reportedTotal) {
          coverageComplete = true;
          break;
        }
      } else if (outcome.monitors.length < UPTIMEROBOT_PAGE_LIMIT) {
        // No total to check against, so a short page is the end of the list.
        coverageComplete = true;
        break;
      }

      // `total` claims more but the page came back empty: the offset cannot
      // advance, so stop.  Coverage stays partial because the two disagree.
      if (outcome.monitors.length === 0) break;
    }

    const inspected = monitors.length;

    let up = 0;
    let down = 0;
    let paused = 0;
    let pending = 0;
    let ratioSum = 0;
    let ratioCount = 0;
    const downNames: string[] = [];

    for (const monitor of monitors) {
      const status = finiteNumber(monitor?.status);
      const ratio = firstRatio(monitor?.custom_uptime_ratio);
      if (ratio !== null && status !== UPTIMEROBOT_PAUSED) {
        ratioSum += ratio;
        ratioCount += 1;
      }
      if (status === UPTIMEROBOT_UP) up += 1;
      else if (status === UPTIMEROBOT_DOWN || status === UPTIMEROBOT_SEEMS_DOWN) {
        down += 1;
        const name = typeof monitor?.friendly_name === "string" ? monitor.friendly_name.trim() : "";
        if (name) downNames.push(name);
      } else if (status === UPTIMEROBOT_PAUSED) paused += 1;
      else pending += 1;
    }

    if (inspected === 0) {
      return {
        state: "degraded",
        headline: "UptimeRobot has no monitors configured.",
        metrics: [metric("Monitors", formatCount(0, "monitor"))],
      };
    }

    const partial = !coverageComplete;
    const accountTotal =
      reportedTotal !== null && reportedTotal > inspected ? reportedTotal : inspected;
    /** Every tally below is a floor while coverage is partial. */
    const atLeast = (count: number): string => (partial && count > 0 ? "+" : "");
    const averageRatio = ratioCount > 0 ? ratioSum / ratioCount : null;
    const monitorHints = [
      partial
        ? `${inspected.toLocaleString("en-US")} of ${accountTotal.toLocaleString("en-US")} checked`
        : null,
      pending > 0 ? `${pending} not checked yet` : null,
    ].filter((hint): hint is string => hint !== null);

    const metrics: PlatformMetric[] = [
      metric(
        "Monitors",
        formatCount(accountTotal, "monitor"),
        monitorHints.length > 0 ? monitorHints.join(", ") : undefined
      ),
      metric("Up", `${up}${atLeast(up)}`),
      metric(
        "Down",
        `${down}${atLeast(down)}`,
        downNames.length > 0 ? downNames.join(", ") : undefined
      ),
      metric("Paused", `${paused}${atLeast(paused)}`),
      metric(
        "Uptime",
        formatPercent(averageRatio, 2),
        partial
          ? `${UPTIMEROBOT_RATIO_DAYS}-day average, checked only`
          : `${UPTIMEROBOT_RATIO_DAYS}-day average`
      ),
    ];

    // Partial coverage can never be reported as an authoritative "healthy":
    // zero down monitors out of a truncated list is not evidence that zero are
    // down, because the down one may simply be on a page we never fetched.
    if (partial) {
      const scope = uncheckedSentence(inspected, reportedTotal);
      const checked = inspected.toLocaleString("en-US");
      return down > 0
        ? {
            state: "degraded",
            headline:
              `At least ${down.toLocaleString("en-US")} of ${checked} checked monitors ` +
              `${down === 1 ? "is" : "are"} down.  ${scope}`,
            metrics,
            error: "partial_read",
          }
        : {
            state: "stale",
            headline: `${up.toLocaleString("en-US")} of ${checked} checked monitors are up.  ${scope}`,
            metrics,
            error: "partial_read",
          };
    }

    if (down > 0) {
      return {
        state: "degraded",
        headline: `${down} of ${inspected} monitors ${down === 1 ? "is" : "are"} down.`,
        metrics,
      };
    }

    // "Not down" is not the same fact as "up".  A monitor that is pending, or
    // in a status we could not classify, has simply never reported — claiming
    // "All 1 monitors are up" when up is zero and one is pending states
    // something we do not know.  Hold the card indeterminate until it checks in.
    if (pending > 0) {
      return {
        state: "stale",
        headline:
          `${up} of ${inspected} monitors are up.  ` +
          `${pending} ${pending === 1 ? "has" : "have"} not reported yet.`,
        metrics,
        error: "pending_monitors",
      };
    }

    return {
      state: "healthy",
      headline:
        paused > 0
          ? `${up} of ${inspected} monitors are up.  ${paused} paused.`
          : `All ${inspected} monitors are up.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "UptimeRobot could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// PagerDuty
// ---------------------------------------------------------------------------

/** PagerDuty's classic list endpoint caps `limit` at 100. */
const PAGERDUTY_PAGE_LIMIT = 100;
/** Page cap: 500 simultaneously open incidents is already a catastrophe. */
const PAGERDUTY_MAX_PAGES = 5;

function pagerDutyIncidentsUrl(offset: number): string {
  return (
    "https://api.pagerduty.com/incidents" +
    "?statuses[]=triggered&statuses[]=acknowledged" +
    `&limit=${PAGERDUTY_PAGE_LIMIT}&offset=${offset}&total=true`
  );
}

type PagerDutyPage =
  | { kind: "failure"; result: PlatformProbeResult }
  | {
      kind: "page";
      incidents: (Record<string, unknown> | undefined)[];
      /** PagerDuty's own "there is another page" flag. */
      more: boolean;
      /** `total` when the API reported one (`total=true` asks for it). */
      total: number | null;
    };

/** Fetch one page of open incidents, mapping every refusal onto a card. */
async function fetchPagerDutyPage(
  apiKey: string,
  offset: number,
  timeoutMs: number
): Promise<PagerDutyPage> {
  const response = await requestJson(
    pagerDutyIncidentsUrl(offset),
    {
      method: "GET",
      headers: {
        authorization: `Token token=${apiKey}`,
        accept: "application/vnd.pagerduty+json;version=2",
      },
    },
    { timeoutMs }
  );

  if (!response.ok) {
    return {
      kind: "failure",
      result: upstreamFailure(
        response.status,
        response.status === 401 || response.status === 403
          ? "PagerDuty rejected the API key."
          : "PagerDuty did not return open incidents."
      ),
    };
  }

  const payload = asRecord(response.data);
  if (!payload) {
    return {
      kind: "failure",
      result: {
        state: "degraded",
        headline: "PagerDuty returned an unexpected response.",
        metrics: [],
        error: "invalid_response",
      },
    };
  }

  return {
    kind: "page",
    incidents: asArray(payload.incidents).map(asRecord),
    more: payload.more === true,
    total: finiteNumber(payload.total),
  };
}

async function probePagerDuty(): Promise<PlatformProbeResult> {
  const apiKey = envValue("PAGERDUTY_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "PagerDuty credentials are no longer readable.",
      metrics: [],
      error: "not_configured",
    };
  }

  try {
    const deadline = Date.now() + PAGINATION_BUDGET_MS;
    const incidents: (Record<string, unknown> | undefined)[] = [];
    let reportedTotal: number | null = null;
    /** True only once PagerDuty has told us there is no further page. */
    let coverageComplete = false;

    for (let page = 0; page < PAGERDUTY_MAX_PAGES; page += 1) {
      const timeoutMs = page === 0 ? PROBE_TIMEOUT_MS : nextPageTimeout(deadline);
      if (timeoutMs === null) break;

      const outcome = await fetchPagerDutyPage(apiKey, incidents.length, timeoutMs);
      if (outcome.kind === "failure") {
        // Same split as UptimeRobot: page one is the whole story, a later
        // failure just truncates coverage.
        if (page === 0) return outcome.result;
        break;
      }

      incidents.push(...outcome.incidents);
      if (outcome.total !== null) reportedTotal = outcome.total;

      if (!outcome.more) {
        coverageComplete = true;
        break;
      }
      // `more: true` with nothing in it cannot advance the offset.
      if (outcome.incidents.length === 0) break;
    }

    const inspected = incidents.length;
    const partial = !coverageComplete;
    /**
     * While coverage is partial every count is a floor: a triggered incident
     * may sit on a page we never read, so a zero here is not a zero.
     */
    const atLeast = (count: number): string => (partial && count > 0 ? "+" : "");

    let triggered = 0;
    let acknowledged = 0;
    let highUrgency = 0;
    let oldestTriggeredAt: number | null = null;

    for (const incident of incidents) {
      const status = typeof incident?.status === "string" ? incident.status : "";
      if (status === "triggered") triggered += 1;
      else if (status === "acknowledged") acknowledged += 1;
      if (incident?.urgency === "high") highUrgency += 1;
      if (status === "triggered" && typeof incident?.created_at === "string") {
        const createdMs = Date.parse(incident.created_at);
        if (Number.isFinite(createdMs) && (oldestTriggeredAt === null || createdMs < oldestTriggeredAt)) {
          oldestTriggeredAt = createdMs;
        }
      }
    }

    const metrics: PlatformMetric[] = [
      metric("Triggered", `${formatCount(triggered, "incident")}${atLeast(triggered)}`),
      metric("Acknowledged", `${formatCount(acknowledged, "incident")}${atLeast(acknowledged)}`),
      metric("High Urgency", `${highUrgency}${atLeast(highUrgency)}`),
    ];
    if (oldestTriggeredAt !== null) {
      metrics.push(
        metric("Oldest Triggered", formatAge(new Date(oldestTriggeredAt).toISOString()))
      );
    }
    if (partial) {
      metrics.push(
        metric(
          "Coverage",
          `${inspected.toLocaleString("en-US")} read`,
          reportedTotal !== null && reportedTotal > inspected
            ? `of ${reportedTotal.toLocaleString("en-US")} open`
            : "later pages not read"
        )
      );
    }

    if (triggered > 0) {
      const acknowledgedSentence =
        acknowledged > 0
          ? `  ${acknowledged}${atLeast(acknowledged)} more ${
              acknowledged === 1 ? "is" : "are"
            } acknowledged.`
          : "";
      return {
        state: "degraded",
        headline:
          `${triggered}${atLeast(triggered)} ${
            triggered === 1 ? "incident is" : "incidents are"
          } triggered.` + acknowledgedSentence,
        metrics,
        ...(partial ? { error: "partial_read" } : {}),
      };
    }

    // Zero triggered out of a truncated list is not evidence of zero, so the
    // card reports its coverage instead of claiming everything is quiet.
    if (partial) {
      return {
        state: "stale",
        headline:
          `No triggered incidents among the ${inspected.toLocaleString("en-US")} checked.  ` +
          uncheckedSentence(inspected, reportedTotal),
        metrics,
        error: "partial_read",
      };
    }

    return {
      state: "healthy",
      headline:
        acknowledged > 0
          ? `No triggered incidents.  ${acknowledged} acknowledged and being worked.`
          : "No open incidents.",
      metrics,
    };
  } catch (error) {
    return failureResult(error, "PagerDuty could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Datadog estimated usage (Infrastructure Free)
// ---------------------------------------------------------------------------

async function probeDatadog(): Promise<PlatformProbeResult> {
  try {
    const usage = await fetchDatadogUsage();
    if (!usage.configured) {
      return {
        state: "unavailable",
        headline: "Datadog credentials are no longer readable.",
        metrics: [],
        error: "not_configured",
      };
    }

    const metrics: PlatformMetric[] = [
      metric("Hosts", formatCount(usage.hosts ?? 0, "host"), `cap ${DATADOG_HOST_CAP}`),
      metric("Containers", formatCount(usage.containers ?? 0, "container")),
      metric("Log events (1h)", formatCount(Math.round(usage.logsIngestedEvents ?? 0), "event")),
      metric("APM spans (1h)", formatCount(Math.round(usage.apmIngestedSpans ?? 0), "span")),
    ];

    const hosts = usage.hosts ?? 0;
    if (hosts > DATADOG_HOST_CAP) {
      return {
        state: "degraded",
        headline: `Estimated ${formatCount(hosts, "host")} — Free allows ${DATADOG_HOST_CAP}.`,
        metrics,
        error: "host_cap",
      };
    }

    return {
      state: "healthy",
      headline: `Inside the ${DATADOG_HOST_CAP}-host Free cap.  Logs and APM are estimated usage, not a promise they are free.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Datadog estimated usage could not be read.");
  }
}

// ---------------------------------------------------------------------------

export const OBSERVABILITY_PROBES: readonly PlatformProbe[] = [
  {
    id: "sentry",
    name: "Sentry",
    category: "observability",
    // SENTRY_ORG is listed so an unconfigured card names it, but sentry-health
    // defaults the org, so the token alone is what gates the probe.
    requiredEnv: ["SENTRY_READ_TOKEN", "SENTRY_ORG"],
    consoleUrl: "https://sentry.io/",
    isConfigured: () => isSentryHealthConfigured(),
    probe: probeSentry,
  },
  {
    id: "uptimerobot",
    name: "UptimeRobot",
    category: "observability",
    requiredEnv: ["UPTIMEROBOT_API_KEY"],
    consoleUrl: "https://dashboard.uptimerobot.com/monitors",
    isConfigured: () => hasEnv("UPTIMEROBOT_API_KEY"),
    probe: probeUptimeRobot,
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    category: "observability",
    requiredEnv: ["PAGERDUTY_API_KEY"],
    consoleUrl: "https://app.pagerduty.com/incidents",
    isConfigured: () => hasEnv("PAGERDUTY_API_KEY"),
    probe: probePagerDuty,
  },
  {
    id: "datadog",
    name: "Datadog",
    category: "observability",
    requiredEnv: ["DD_API_KEY", "DD_APP_KEY"],
    consoleUrl: "https://us5.datadoghq.com/",
    isConfigured: () => isDatadogUsageConfigured(),
    probe: probeDatadog,
  },
];
