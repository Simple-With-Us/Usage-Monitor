import {
  AdapterError,
  errorResult,
  fetchJson,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

interface PineconeIndex {
  name: string;
  host?: string;
  dimension?: number;
  metric?: string;
  vector_type?: string;
  status?: { ready?: boolean; state?: string };
  spec?: {
    serverless?: {
      cloud?: string;
      region?: string;
      read_capacity?: {
        mode?: string;
        dedicated?: {
          node_type?: string;
          scaling?: string;
          manual?: { shards?: number; replicas?: number };
        };
      };
    };
    pod?: {
      environment?: string;
      pod_type?: string;
      pods?: number;
      replicas?: number;
      shards?: number;
    };
    byoc?: { cloud?: string; region?: string };
  };
}

interface PineconeBackup {
  backup_id?: string;
  source_index_name?: string;
  name?: string;
  status?: string;
  cloud?: string;
  region?: string;
  record_count?: number | null;
  namespace_count?: number | null;
  size_bytes?: number | null;
  created_at?: string;
}

interface PineconeCollection {
  name?: string;
  status?: string;
  environment?: string;
  size?: number;
  vector_count?: number;
  dimension?: number;
}

interface PineconeAssistant {
  name?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface OptionalInventory<T> {
  items: T[] | null;
  error: string | null;
}

const PINECONE_API_VERSION = "2026-04";
const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;

export function pineconeHeaders(apiKey: string): Record<string, string> {
  return {
    "Api-Key": apiKey,
    "X-Pinecone-Api-Version": PINECONE_API_VERSION,
    "Content-Type": "application/json",
  };
}

export function isAllowedPineconeIndexHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("@")
  ) {
    return false;
  }
  const labels = normalized.split(".");
  return (
    labels.length >= 5 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    normalized.endsWith(".pinecone.io") &&
    labels.includes("svc")
  );
}

function inventoryError(error: unknown): string {
  if (error instanceof AdapterError) {
    return error.status == null
      ? `${error.code}: ${error.message}`
      : `${error.code} (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown inventory error";
}

async function fetchPagedInventory<T>(options: {
  apiKey: string;
  path: string;
  itemKey: "data" | "assistants";
  tokenParameter: "paginationToken" | "pagination_token";
  idOf: (item: T) => string | null;
}): Promise<OptionalInventory<T>> {
  const items: T[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let token: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (token != null) query.set(options.tokenParameter, token);
      const response = await fetchJson(
        `https://api.pinecone.io${options.path}?${query}`,
        { headers: pineconeHeaders(options.apiKey) }
      );
      if (!response.ok) {
        if (response.status === 401) return errorResult(response.status);
        return { items: null, error: `HTTP ${response.status}` };
      }
      if (!response.data || typeof response.data !== "object") {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      const body = response.data as Record<string, unknown>;
      const rows = body[options.itemKey];
      if (!Array.isArray(rows)) {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      for (const row of rows) {
        if (!row || typeof row !== "object") {
          return { items: null, error: "INVALID_RESPONSE" };
        }
        const item = row as T;
        const id = options.idOf(item)?.trim() || null;
        if (!id || seenIds.has(id)) {
          return { items: null, error: "INVALID_RESPONSE" };
        }
        seenIds.add(id);
        items.push(item);
      }
      const pagination = body.pagination;
      if (pagination != null && typeof pagination !== "object") {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      const next =
        pagination && typeof pagination === "object"
          ? (pagination as { next?: unknown }).next
          : null;
      if (next == null || next === "") return { items, error: null };
      if (typeof next !== "string" || seenTokens.has(next)) {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      seenTokens.add(next);
      token = next;
    }
    return { items: null, error: "PAGINATION_LIMIT" };
  } catch (error) {
    if (error instanceof AdapterError && error.status === 401) throw error;
    return { items: null, error: inventoryError(error) };
  }
}

async function fetchCollections(apiKey: string): Promise<OptionalInventory<PineconeCollection>> {
  try {
    const response = await fetchJson("https://api.pinecone.io/collections", {
      headers: pineconeHeaders(apiKey),
    });
    if (!response.ok) {
      if (response.status === 401) return errorResult(response.status);
      return { items: null, error: `HTTP ${response.status}` };
    }
    if (!response.data || typeof response.data !== "object") {
      return { items: null, error: "INVALID_RESPONSE" };
    }
    const body = response.data as {
      collections?: unknown;
      pagination?: { next?: unknown } | null;
    };
    // The documented 2026-04 collections endpoint returns the complete list
    // and accepts no pagination parameter. Fail closed if that contract ever
    // starts returning a continuation token rather than claiming completeness.
    if (!Array.isArray(body.collections) || body.pagination?.next) {
      return { items: null, error: "INVALID_RESPONSE" };
    }
    const seen = new Set<string>();
    const collections: PineconeCollection[] = [];
    for (const row of body.collections) {
      if (!row || typeof row !== "object") {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      const item = row as PineconeCollection;
      const name = item.name?.trim();
      if (!name || seen.has(name)) {
        return { items: null, error: "INVALID_RESPONSE" };
      }
      seen.add(name);
      collections.push(item);
    }
    return { items: collections, error: null };
  } catch (error) {
    if (error instanceof AdapterError && error.status === 401) throw error;
    return { items: null, error: inventoryError(error) };
  }
}

function indexPlanName(index: PineconeIndex): string {
  const serverless = index.spec?.serverless;
  if (serverless) {
    const dedicated = serverless.read_capacity?.dedicated;
    return [
      serverless.read_capacity?.mode?.toLowerCase() === "dedicated"
        ? "Serverless Dedicated"
        : "Serverless",
      dedicated?.node_type,
      serverless.cloud,
      serverless.region,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const pod = index.spec?.pod;
  if (pod) {
    return ["Pod", pod.pod_type, pod.environment].filter(Boolean).join(" · ");
  }
  const byoc = index.spec?.byoc;
  if (byoc) {
    return ["BYOC", byoc.cloud, byoc.region].filter(Boolean).join(" · ");
  }
  return "Index";
}

function inventorySync(
  source: string,
  inventory: OptionalInventory<unknown>,
  records: AdapterExternalBillingRecord[]
): AdapterExternalBillingSync | null {
  return inventory.items == null
    ? null
    : { source, authoritative: true, records };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const [indexesResponse, backupsResult, collectionsResult, assistantsResult] = await Promise.all([
    fetchJson("https://api.pinecone.io/indexes", {
      headers: pineconeHeaders(apiKey),
    }),
    fetchPagedInventory<PineconeBackup>({
      apiKey,
      path: "/backups",
      itemKey: "data",
      tokenParameter: "paginationToken",
      idOf: (backup) => backup.backup_id?.trim() || null,
    }),
    fetchCollections(apiKey),
    fetchPagedInventory<PineconeAssistant>({
      apiKey,
      path: "/assistant/assistants",
      itemKey: "assistants",
      tokenParameter: "pagination_token",
      idOf: (assistant) => assistant.name?.trim() || null,
    }),
  ]);

  if (!indexesResponse.ok) return errorResult(indexesResponse.status);
  if (!indexesResponse.data || typeof indexesResponse.data !== "object") {
    throw new AdapterError("Pinecone returned an invalid indexes response", {
      code: "INVALID_RESPONSE",
    });
  }
  const indexRows = (indexesResponse.data as { indexes?: unknown }).indexes;
  if (!Array.isArray(indexRows)) {
    throw new AdapterError("Pinecone returned no index list", {
      code: "INVALID_RESPONSE",
    });
  }
  const seenIndexes = new Set<string>();
  const indexes: PineconeIndex[] = [];
  for (const row of indexRows) {
    if (!row || typeof row !== "object") {
      throw new AdapterError("Pinecone returned an invalid index", {
        code: "INVALID_RESPONSE",
      });
    }
    const index = row as PineconeIndex;
    if (!index.name?.trim() || seenIndexes.has(index.name)) {
      throw new AdapterError("Pinecone returned an index without a unique name", {
        code: "INVALID_RESPONSE",
      });
    }
    seenIndexes.add(index.name);
    indexes.push(index);
  }

  let vectorCountTotal = 0;
  let vectorCountsComplete = true;
  const stats: Array<Record<string, unknown>> = [];
  const vectorCountByIndex = new Map<string, number | null>();
  await Promise.all(
    indexes.map(async (index) => {
      let vectorCount: number | null = null;
      try {
        const host = index.host;
        if (!host) {
          throw new AdapterError("Pinecone index has no data-plane host", {
            code: "INVALID_RESPONSE",
          });
        }
        if (!isAllowedPineconeIndexHost(host)) {
          throw new AdapterError(
            "Pinecone returned an index host outside the allowed *.svc.*.pinecone.io domain",
            { code: "UNSAFE_OUTBOUND_URL" }
          );
        }
        const statsResponse = await fetchJson(
          `https://${host}/describe_index_stats`,
          {
            headers: pineconeHeaders(apiKey),
            method: "POST",
            body: JSON.stringify({}),
          },
          { security: "untrusted" }
        );
        if (!statsResponse.ok) {
          throw new AdapterError(`Pinecone index stats returned HTTP ${statsResponse.status}`, {
            code: "HTTP_ERROR",
            status: statsResponse.status,
          });
        }
        const indexStats = statsResponse.data as { totalVectorCount?: unknown };
        if (
          typeof indexStats?.totalVectorCount !== "number" ||
          !Number.isSafeInteger(indexStats.totalVectorCount) ||
          indexStats.totalVectorCount < 0
        ) {
          throw new AdapterError("Pinecone returned invalid index stats", {
            code: "INVALID_RESPONSE",
          });
        }
        vectorCount = indexStats.totalVectorCount;
        vectorCountTotal += vectorCount;
        stats.push({ name: index.name, stats: indexStats });
      } catch (error) {
        vectorCountsComplete = false;
        stats.push({ name: index.name, error: inventoryError(error) });
      }
      vectorCountByIndex.set(index.name, vectorCount);
    })
  );
  stats.sort((left, right) => String(left.name).localeCompare(String(right.name)));

  const indexRecords: AdapterExternalBillingRecord[] = indexes.map((index) => ({
    externalId: index.name,
    kind: "service_plan",
    serviceName: index.name,
    planName: indexPlanName(index),
    status:
      index.status?.state ??
      (index.status?.ready === true
        ? "ready"
        : index.status?.ready === false
          ? "initializing"
          : "unknown"),
    usageQuantity: vectorCountByIndex.get(index.name) ?? null,
    usageUnit: "vectors",
    rollupRole: "metadata",
  }));

  const backupRecords: AdapterExternalBillingRecord[] = (backupsResult.items ?? []).map(
    (backup) => ({
      externalId: backup.backup_id!,
      kind: "service_plan",
      serviceName: backup.name || `Backup ${backup.backup_id}`,
      planName: backup.source_index_name
        ? `Index backup · ${backup.source_index_name}`
        : "Index backup",
      status: backup.status ?? "unknown",
      usageQuantity: backup.size_bytes ?? null,
      usageUnit: "bytes",
      rollupRole: "metadata",
    })
  );
  const collectionRecords: AdapterExternalBillingRecord[] = (collectionsResult.items ?? []).map(
    (collection) => ({
      externalId: collection.name!,
      kind: "service_plan",
      serviceName: collection.name!,
      planName: collection.environment
        ? `Pod collection · ${collection.environment}`
        : "Pod collection",
      status: collection.status ?? "unknown",
      usageQuantity: collection.size ?? null,
      usageUnit: "bytes",
      rollupRole: "metadata",
    })
  );
  const assistantRecords: AdapterExternalBillingRecord[] = (assistantsResult.items ?? []).map(
    (assistant) => ({
      externalId: assistant.name!,
      kind: "service_plan",
      serviceName: assistant.name!,
      planName: "Pinecone Assistant",
      status: assistant.status ?? "unknown",
      rollupRole: "metadata",
    })
  );

  const optionalSyncs = [
    inventorySync("pinecone-backup-inventory", backupsResult, backupRecords),
    inventorySync("pinecone-collection-inventory", collectionsResult, collectionRecords),
    inventorySync("pinecone-assistant-inventory", assistantsResult, assistantRecords),
  ].filter((sync): sync is AdapterExternalBillingSync => sync != null);

  const inventoryErrors = Object.fromEntries(
    [
      ["backups", backupsResult.error],
      ["collections", collectionsResult.error],
      ["assistants", assistantsResult.error],
    ].filter((entry): entry is [string, string] => entry[1] != null)
  );

  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: {
      indexes: indexes.map((index) => ({
        name: index.name,
        host: index.host ?? null,
        dimension: index.dimension ?? null,
        metric: index.metric ?? null,
        vectorType: index.vector_type ?? null,
        status: index.status ?? null,
        spec: index.spec ?? null,
      })),
      stats,
      totalVectorCount: vectorCountsComplete ? vectorCountTotal : null,
      backups: (backupsResult.items ?? []).map((backup) => ({
        id: backup.backup_id ?? null,
        name: backup.name ?? null,
        sourceIndex: backup.source_index_name ?? null,
        status: backup.status ?? null,
        cloud: backup.cloud ?? null,
        region: backup.region ?? null,
        recordCount: backup.record_count ?? null,
        namespaceCount: backup.namespace_count ?? null,
        sizeBytes: backup.size_bytes ?? null,
        createdAt: backup.created_at ?? null,
      })),
      collections: (collectionsResult.items ?? []).map((collection) => ({
        name: collection.name ?? null,
        status: collection.status ?? null,
        environment: collection.environment ?? null,
        sizeBytes: collection.size ?? null,
        vectorCount: collection.vector_count ?? null,
        dimension: collection.dimension ?? null,
      })),
      assistants: (assistantsResult.items ?? []).map((assistant) => ({
        name: assistant.name ?? null,
        status: assistant.status ?? null,
        createdAt: assistant.created_at ?? null,
        updatedAt: assistant.updated_at ?? null,
      })),
      inventoryErrors,
      capabilities: {
        indexInventory: true,
        vectorCount: true,
        vectorCountsComplete,
        backupInventory: backupsResult.items != null,
        collectionInventory: collectionsResult.items != null,
        assistantInventory: assistantsResult.items != null,
        billingCost: false,
        subscriptionStatus: false,
        apiVersion: PINECONE_API_VERSION,
      },
    },
    externalBilling: {
      source: "pinecone-index-inventory",
      authoritative: true,
      records: indexRecords,
    },
    externalBillingSyncs: optionalSyncs.length > 0 ? optionalSyncs : undefined,
  };
}
