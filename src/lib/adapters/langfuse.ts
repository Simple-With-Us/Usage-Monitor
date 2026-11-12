import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type FetchJsonOptions,
  type UsageResult,
} from "./helpers";

const DEFAULT_HOST = "https://cloud.langfuse.com";

type MetricsView =
  | "traces"
  | "observations"
  | "scores-numeric"
  | "scores-categorical";

interface MetricsResult {
  count: number;
  trackedLlmCostUsd: number | null;
  trackedLlmCostCoverage: "unknown";
}

function invalidResponse(view: MetricsView, message: string): never {
  throw new AdapterError(
    `Langfuse returned an invalid ${view} metrics response: ${message}`,
    { code: "INVALID_RESPONSE" }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonnegativeMetric(
  view: MetricsView,
  value: unknown,
  field: string,
  integer: boolean
): number {
  const parsed = parseNumber(value);
  if (
    parsed == null ||
    parsed < 0 ||
    (integer && !Number.isSafeInteger(parsed))
  ) {
    invalidResponse(
      view,
      `${field} must be a ${integer ? "non-negative integer" : "finite non-negative number"}`
    );
  }
  return parsed;
}

function fetchOptions(host: string): FetchJsonOptions {
  return { security: host === DEFAULT_HOST ? "trusted" : "untrusted" };
}

function metricsQuery(
  view: MetricsView,
  fromTimestamp: string,
  toTimestamp: string
): Record<string, unknown> {
  return {
    view,
    dimensions: [],
    metrics: [
      { measure: "count", aggregation: "count" },
      ...(view === "observations"
        ? [{ measure: "totalCost", aggregation: "sum" }]
        : []),
    ],
    filters: [],
    fromTimestamp,
    toTimestamp,
  };
}

async function fetchMetrics(
  apiKey: string,
  host: string,
  view: MetricsView,
  fromTimestamp: string,
  toTimestamp: string
): Promise<MetricsResult> {
  const query = new URLSearchParams({
    query: JSON.stringify(metricsQuery(view, fromTimestamp, toTimestamp)),
  });
  const response = await fetchJson(
    `${host}/api/public/metrics?${query.toString()}`,
    { headers: { Authorization: `Basic ${apiKey}` } },
    fetchOptions(host)
  );

  if (!response.ok) {
    errorResult(response.status, { response: response.data });
  }
  if (!isRecord(response.data) || !Array.isArray(response.data.data)) {
    invalidResponse(view, "data must be an array");
  }

  let count = 0;
  let trackedLlmCostUsd = 0;
  let hasTrackedCost = response.data.data.length === 0;
  let hasUnknownTrackedCost = false;

  for (const row of response.data.data) {
    if (!isRecord(row)) {
      invalidResponse(view, "each data row must be an object");
    }
    count += readNonnegativeMetric(view, row.count_count, "count_count", true);

    if (view === "observations") {
      if (row.sum_totalCost == null) {
        hasUnknownTrackedCost = true;
      } else {
        trackedLlmCostUsd += readNonnegativeMetric(
          view,
          row.sum_totalCost,
          "sum_totalCost",
          false
        );
        hasTrackedCost = true;
      }
    }
  }

  return {
    count,
    trackedLlmCostUsd:
      view === "observations" && hasTrackedCost && !hasUnknownTrackedCost
        ? trackedLlmCostUsd
        : null,
    // A numeric aggregate is a useful known-cost diagnostic, but it does not
    // prove every observation had provider/model pricing metadata.
    trackedLlmCostCoverage: "unknown",
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const publicKey = config?.publicKey ?? apiKey;
  const secretKey = config?.secretKey;
  const configuredHost = config?.host;

  if (typeof publicKey !== "string" || publicKey.trim() === "") {
    configurationError("publicKey must be a non-empty string");
  }
  if (typeof secretKey !== "string" || secretKey.trim() === "") {
    configurationError("secretKey is required in config (Langfuse secret key)");
  }
  if (configuredHost != null && typeof configuredHost !== "string") {
    configurationError("host must be a string");
  }

  const host = (configuredHost || DEFAULT_HOST).replace(/\/+$/, "");
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();
  const periodEnd = now.toISOString();
  const views: MetricsView[] = [
    "traces",
    "observations",
    "scores-numeric",
    "scores-categorical",
  ];
  const results = await Promise.all(
    views.map((view) =>
      fetchMetrics(auth, host, view, monthStart, periodEnd)
    )
  );
  const byView = Object.fromEntries(
    views.map((view, index) => [view, results[index]])
  ) as Record<MetricsView, MetricsResult>;
  const billableUnitCount = results.reduce((sum, result) => sum + result.count, 0);

  const labels: Record<MetricsView, { serviceName: string; usageUnit: string }> = {
    traces: { serviceName: "Traces", usageUnit: "traces" },
    observations: { serviceName: "Observations", usageUnit: "observations" },
    "scores-numeric": {
      serviceName: "Numeric/boolean scores",
      usageUnit: "numeric_scores",
    },
    "scores-categorical": {
      serviceName: "Categorical scores",
      usageUnit: "categorical_scores",
    },
  };
  const records: AdapterExternalBillingRecord[] = views.map((view) => ({
    externalId: `mtd:${monthStart.slice(0, 10)}:${view}`,
    kind: "billing_period",
    serviceName: labels[view].serviceName,
    status: "usage_reported",
    currentPeriodStart: monthStart,
    currentPeriodEnd: periodEnd,
    usageQuantity: byView[view].count,
    usageUnit: labels[view].usageUnit,
    rollupRole: "metadata",
    dateKind: "report_through",
  }));

  return {
    balance: null,
    // Langfuse's totalCost metric is the cost of model calls observed in the
    // project. It is not Langfuse's own subscription or usage invoice.
    totalCost: null,
    totalRequests: billableUnitCount,
    credits: null,
    rawData: {
      period: {
        scope: "calendar_month_to_date",
        start: monthStart,
        end: periodEnd,
      },
      billableUnitCount,
      unitCounts: {
        traces: byView.traces.count,
        observations: byView.observations.count,
        numericScores: byView["scores-numeric"].count,
        categoricalScores: byView["scores-categorical"].count,
      },
      trackedLlmCostUsd: byView.observations.trackedLlmCostUsd,
      trackedLlmCostCoverage:
        byView.observations.trackedLlmCostCoverage,
      capabilities: {
        billableUnitUsage: true,
        trackedLlmCost: byView.observations.trackedLlmCostUsd != null,
        langfuseInvoiceCost: false,
        subscriptionStatus: false,
      },
    },
    externalBilling: {
      source: "langfuse-legacy-metrics",
      authoritative: true,
      records,
    },
  };
}
