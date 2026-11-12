import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingSync,
} from "./helpers";
import {
  fetchGoogleServiceAccountAccessToken,
  GOOGLE_BIGQUERY_READONLY_SCOPE,
  parseGoogleServiceAccountCredential,
} from "./google-service-account";

const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";
const MAXIMUM_BYTES_BILLED = "1073741824";
const MAX_TABLE_PAGES = 10;
const MAX_QUERY_PAGES = 20;

interface DatasetRef {
  projectId: string;
  datasetId: string;
}

interface BillingRow {
  projectId: string | null;
  projectNumber: string | null;
  projectName: string | null;
  skuId: string | null;
  skuDescription: string | null;
  usageUnit: string | null;
  reportThrough: string | null;
  netUsd: number;
  usageQuantity: number | null;
}

export interface GoogleCloudBillingResult {
  status: "ready" | "pending";
  totalCostUsd: number | null;
  windowStart: string;
  windowEnd: string | null;
  reportThrough: string | null;
  queryProjectId: string;
  dataset: string;
  tableId: string | null;
  projectCount: number;
  rows: BillingRow[];
  externalBilling: AdapterExternalBillingSync;
}

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDataset(value: unknown): DatasetRef {
  const input = cleanString(value);
  const match = input?.match(/^([a-z][a-z0-9-]{4,61}[a-z0-9])\.([A-Za-z_][A-Za-z0-9_]{0,1023})$/);
  if (!match) {
    configurationError(
      "Google Cloud billingDataset must use the project-id.dataset_id format"
    );
  }
  return { projectId: match[1], datasetId: match[2] };
}

function validateTableId(value: unknown): string | null {
  const tableId = cleanString(value);
  if (!tableId) return null;
  if (!/^gcp_billing_export_v1_[A-Za-z0-9_-]+$/.test(tableId)) {
    configurationError(
      "Google Cloud billingTable must be a standard gcp_billing_export_v1_* table ID"
    );
  }
  return tableId;
}

async function discoverTable(
  dataset: DatasetRef,
  token: string,
  configuredTable: unknown
): Promise<string | null> {
  const explicit = validateTableId(configuredTable);
  if (explicit) return explicit;

  const tables = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_TABLE_PAGES; page++) {
    const url = new URL(
      `${BIGQUERY_API}/projects/${encodeURIComponent(dataset.projectId)}/datasets/${encodeURIComponent(dataset.datasetId)}/tables`
    );
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      errorResult(response.status, { note: "Google BigQuery table discovery failed" });
    }
    const data = response.data as {
      tables?: Array<{ tableReference?: { tableId?: unknown } }>;
      nextPageToken?: unknown;
    } | null;
    if (data?.tables != null && !Array.isArray(data.tables)) {
      invalidResponse("Google BigQuery table list is malformed");
    }
    for (const table of data?.tables ?? []) {
      const tableId = cleanString(table.tableReference?.tableId);
      if (tableId?.startsWith("gcp_billing_export_v1_")) tables.add(tableId);
    }
    pageToken = cleanString(data?.nextPageToken);
    if (!pageToken) break;
    if (page === MAX_TABLE_PAGES - 1) {
      invalidResponse("Google BigQuery table discovery exceeded the page limit");
    }
  }

  // Google creates the first export table asynchronously after Standard usage
  // cost export is enabled. Treat that expected provisioning window as pending
  // rather than a false zero or a permanent configuration error.
  if (tables.size === 0) return null;
  if (tables.size > 1) {
    configurationError(
      "Multiple standard Cloud Billing export tables were found; set billingTable explicitly"
    );
  }
  return [...tables][0];
}

function monthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString(), end: now.toISOString() };
}

function buildQuery(
  dataset: DatasetRef,
  tableId: string,
  googleProjectId: string | null
): string {
  const projectFilter = googleProjectId ? "\n    AND project.id = @google_project_id" : "";
  return `SELECT
    project.id AS project_id,
    ANY_VALUE(project.number) AS project_number,
    ANY_VALUE(project.name) AS project_name,
    sku.id AS sku_id,
    ANY_VALUE(sku.description) AS sku_description,
    usage.pricing_unit AS usage_unit,
    CAST(MAX(export_time) AS STRING) AS report_through,
    COUNTIF(currency_conversion_rate IS NULL OR currency_conversion_rate <= 0) AS invalid_rate_rows,
    CAST(SUM(SAFE_DIVIDE(
      CAST(cost AS NUMERIC) + IFNULL((
        SELECT SUM(CAST(credit.amount AS NUMERIC)) FROM UNNEST(credits) AS credit
      ), 0),
      CAST(currency_conversion_rate AS NUMERIC)
    )) AS STRING) AS net_usd,
    CAST(SUM(CAST(usage.amount_in_pricing_units AS NUMERIC)) AS STRING) AS usage_quantity
  FROM \`${dataset.projectId}.${dataset.datasetId}.${tableId}\`
  WHERE usage_start_time >= @window_start
    AND usage_start_time < @window_end
    AND _PARTITIONTIME >= @window_start
    AND _PARTITIONTIME < @window_end
    AND service.description = 'Gemini API'
    AND cost_type = 'regular'${projectFilter}
  GROUP BY project.id, sku.id, usage.pricing_unit`;
}

interface QueryPage {
  jobComplete?: unknown;
  jobReference?: { projectId?: unknown; jobId?: unknown; location?: unknown };
  schema?: { fields?: Array<{ name?: unknown }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  pageToken?: unknown;
  totalRows?: unknown;
  errors?: unknown[];
}

function assertQueryPage(data: unknown): QueryPage {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    invalidResponse("Google BigQuery query response is malformed");
  }
  const page = data as QueryPage;
  if (Array.isArray(page.errors) && page.errors.length > 0) {
    invalidResponse("Google BigQuery query returned execution errors");
  }
  if (page.rows != null && !Array.isArray(page.rows)) {
    invalidResponse("Google BigQuery query rows are malformed");
  }
  return page;
}

function queryFieldNames(page: QueryPage): string[] | null {
  if (page.schema == null) return null;
  if (!Array.isArray(page.schema.fields) || page.schema.fields.length === 0) {
    invalidResponse("Google BigQuery query schema is malformed");
  }
  const fieldNames = page.schema.fields.map((field) => cleanString(field.name));
  if (fieldNames.some((field) => !field)) {
    invalidResponse("Google BigQuery query schema is malformed");
  }
  return fieldNames as string[];
}

function sameFieldNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

async function executeQuery(
  queryProjectId: string,
  dataset: DatasetRef,
  tableId: string,
  token: string,
  projectId: string | null,
  window: { start: string; end: string }
): Promise<{ fieldNames: string[]; rows: NonNullable<QueryPage["rows"]> }> {
  const queryParameters = [
    { name: "window_start", parameterType: { type: "TIMESTAMP" }, parameterValue: { value: window.start } },
    { name: "window_end", parameterType: { type: "TIMESTAMP" }, parameterValue: { value: window.end } },
    ...(projectId
      ? [{ name: "google_project_id", parameterType: { type: "STRING" }, parameterValue: { value: projectId } }]
      : []),
  ];
  const response = await fetchJson(
    `${BIGQUERY_API}/projects/${encodeURIComponent(queryProjectId)}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: buildQuery(dataset, tableId, projectId),
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters,
        maximumBytesBilled: MAXIMUM_BYTES_BILLED,
        timeoutMs: 20_000,
        maxResults: 1000,
      }),
    }
  );
  if (!response.ok) {
    errorResult(response.status, { note: "Google BigQuery billing query failed" });
  }

  let page = assertQueryPage(response.data);
  const jobProject = cleanString(page.jobReference?.projectId) ?? queryProjectId;
  const jobId = cleanString(page.jobReference?.jobId);
  const location = cleanString(page.jobReference?.location);
  let names = queryFieldNames(page);
  const rows: NonNullable<QueryPage["rows"]> = [...(page.rows ?? [])];
  let nextPageToken = cleanString(page.pageToken);
  let complete = page.jobComplete === true;

  for (let pageIndex = 0; !complete || nextPageToken; pageIndex++) {
    if (!jobId) invalidResponse("Google BigQuery query omitted its job reference");
    if (pageIndex >= MAX_QUERY_PAGES) {
      invalidResponse("Google BigQuery query exceeded the page limit");
    }
    const url = new URL(
      `${BIGQUERY_API}/projects/${encodeURIComponent(jobProject)}/queries/${encodeURIComponent(jobId)}`
    );
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("timeoutMs", "20000");
    if (location) url.searchParams.set("location", location);
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    const nextResponse = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!nextResponse.ok) {
      errorResult(nextResponse.status, {
        note: "Google BigQuery billing query pagination failed",
      });
    }
    page = assertQueryPage(nextResponse.data);
    const nextNames = queryFieldNames(page);
    if (nextNames) {
      if (names && !sameFieldNames(names, nextNames)) {
        invalidResponse("Google BigQuery query schema changed between result pages");
      }
      names = nextNames;
    }
    rows.push(...(page.rows ?? []));
    nextPageToken = cleanString(page.pageToken);
    complete = page.jobComplete === true;
  }

  const totalRows = parseNumber(page.totalRows);
  if (totalRows != null && totalRows !== rows.length) {
    invalidResponse("Google BigQuery billing query returned a truncated result");
  }
  if (!names) {
    invalidResponse("Google BigQuery query omitted its result schema");
  }
  return { fieldNames: names, rows };
}

function rowObject(
  fieldNames: string[],
  row: NonNullable<QueryPage["rows"]>[number]
): Record<string, unknown> {
  if (!Array.isArray(row.f) || row.f.length !== fieldNames.length) {
    invalidResponse("Google BigQuery billing row does not match its schema");
  }
  return Object.fromEntries(fieldNames.map((name, index) => [name, row.f![index]?.v]));
}

function parseBillingRows(
  fieldNames: string[],
  rows: NonNullable<QueryPage["rows"]>
): BillingRow[] {
  return rows.map((row) => {
    const value = rowObject(fieldNames, row);
    const invalidRates = parseNumber(value.invalid_rate_rows);
    const netUsd = parseNumber(value.net_usd);
    if (invalidRates == null || !Number.isSafeInteger(invalidRates) || invalidRates < 0) {
      invalidResponse("Google BigQuery billing row has invalid conversion metadata");
    }
    if (invalidRates > 0) {
      invalidResponse("Google BigQuery billing row cannot be normalized to USD");
    }
    if (netUsd == null) {
      invalidResponse("Google BigQuery billing row omitted net USD cost");
    }
    return {
      projectId: cleanString(value.project_id),
      projectNumber: cleanString(value.project_number),
      projectName: cleanString(value.project_name),
      skuId: cleanString(value.sku_id),
      skuDescription: cleanString(value.sku_description),
      usageUnit: cleanString(value.usage_unit),
      reportThrough: cleanString(value.report_through),
      netUsd,
      usageQuantity: parseNumber(value.usage_quantity),
    };
  });
}

function configuredProject(value: unknown): string | null {
  const projectId = cleanString(value);
  if (!projectId) return null;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    configurationError("googleProjectId is not a valid Google Cloud project ID");
  }
  return projectId;
}

export function hasGoogleCloudBillingConfig(
  config: Record<string, unknown> | undefined
): boolean {
  // The shared service-account credential also powers Cloud Monitoring. Do
  // not interpret that credential alone as intent to enable the independent
  // BigQuery billing channel.
  return Boolean(
    cleanString(config?.billingDataset) || cleanString(config?.billingTable)
  );
}

export async function fetchGoogleCloudBilling(
  config: Record<string, unknown>
): Promise<GoogleCloudBillingResult> {
  const dataset = parseDataset(config.billingDataset);
  const credential = parseGoogleServiceAccountCredential(
    config.serviceAccountJson
  );
  const projectId = configuredProject(config.googleProjectId);
  const token = await fetchGoogleServiceAccountAccessToken(
    credential,
    GOOGLE_BIGQUERY_READONLY_SCOPE
  );
  const tableId = await discoverTable(dataset, token, config.billingTable);
  const window = monthWindow();
  if (!tableId) {
    return {
      status: "pending",
      totalCostUsd: null,
      windowStart: window.start,
      windowEnd: null,
      reportThrough: null,
      queryProjectId: credential.project_id,
      dataset: `${dataset.projectId}.${dataset.datasetId}`,
      tableId: null,
      projectCount: 0,
      rows: [],
      externalBilling: {
        source: `google-cloud-billing-export:${projectId ?? "pending"}`,
        authoritative: false,
        records: [
          {
            externalId: `gemini-mtd:${projectId ?? "pending"}`,
            kind: "billing_period",
            serviceName: "Gemini API",
            planName: "Cloud Billing export provisioning",
            status: "pending",
            amountUsd: null,
            currency: "USD",
            currentPeriodStart: window.start,
            currentPeriodEnd: null,
            rollupRole: "canonical",
            dateKind: "report_through",
          },
        ],
      },
    };
  }
  const query = await executeQuery(
    credential.project_id,
    dataset,
    tableId,
    token,
    projectId,
    window
  );
  const rows = parseBillingRows(query.fieldNames, query.rows);
  const observedProjects = new Set(
    rows.map((row) => row.projectId ?? "__unattributed__")
  );
  if (!projectId && observedProjects.size > 1) {
    configurationError(
      "Gemini billing spans multiple Google Cloud projects; set googleProjectId"
    );
  }

  const totalCostUsd = rows.length > 0
    ? rows.reduce((sum, row) => sum + row.netUsd, 0)
    : null;
  if (totalCostUsd != null && !Number.isFinite(totalCostUsd)) {
    invalidResponse("Google BigQuery billing total is invalid");
  }
  const reportThrough = rows
    .map((row) => row.reportThrough)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const scopeId = projectId ?? rows[0]?.projectId ?? "unattributed";
  const status = rows.length > 0 ? "ready" : "pending";
  const records = rows.map((row) => ({
    externalId: `gemini-sku:${row.projectId ?? "unattributed"}:${row.skuId ?? "unknown"}:${row.usageUnit ?? "unknown"}`,
    kind: "billing_period" as const,
    serviceName: "Gemini API",
    planName: row.skuDescription,
    status: "active",
    amountUsd: row.netUsd,
    currency: "USD",
    currentPeriodStart: window.start,
    currentPeriodEnd: reportThrough ?? window.end,
    usageQuantity: row.usageQuantity,
    usageUnit: row.usageUnit,
    rollupRole: "component" as const,
    dateKind: "report_through" as const,
  }));

  return {
    status,
    totalCostUsd,
    windowStart: window.start,
    windowEnd: rows.length > 0 ? window.end : null,
    reportThrough,
    queryProjectId: credential.project_id,
    dataset: `${dataset.projectId}.${dataset.datasetId}`,
    tableId,
    projectCount: observedProjects.size,
    rows,
    externalBilling: {
      source: `google-cloud-billing-export:${scopeId}`,
      // A successfully completed query is a complete inventory even when the
      // export has not populated any rows yet. Keep the spend unknown/pending,
      // but allow reconciliation to prune stale project identities and
      // previous-period SKU components. Table discovery still uses the
      // non-authoritative provisioning path above because no query ran there.
      authoritative: true,
      records: [
        {
          externalId: `gemini-mtd:${scopeId}`,
          kind: "billing_period",
          serviceName: "Gemini API",
          planName: "Cloud Billing export",
          status: rows.length > 0 ? "active" : "pending",
          amountUsd: totalCostUsd,
          currency: "USD",
          currentPeriodStart: window.start,
          currentPeriodEnd: rows.length > 0 ? reportThrough ?? window.end : null,
          rollupRole: "canonical",
          dateKind: "report_through",
        },
        ...records,
      ],
    },
  };
}
