import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

interface HetznerPrice {
  net?: string;
  gross?: string;
}

interface HetznerLocation {
  name?: string;
}

interface LocationPrice {
  location?: string;
  price_monthly?: HetznerPrice;
}

interface NamedLocationPrices {
  name?: string;
  type?: string;
  prices?: LocationPrice[];
}

interface HetznerPricing {
  currency?: string;
  vat_rate?: string;
  image?: { price_per_gb_month?: HetznerPrice };
  floating_ip?: { price_monthly?: HetznerPrice };
  floating_ips?: NamedLocationPrices[];
  primary_ips?: NamedLocationPrices[];
  server_backup?: { percentage?: string };
  server_types?: NamedLocationPrices[];
  load_balancer_types?: NamedLocationPrices[];
  volume?: { price_per_gb_month?: HetznerPrice };
}

interface HetznerServer {
  id?: number;
  name?: string;
  status?: string;
  outgoing_traffic?: number | null;
  backup_window?: string | null;
  server_type?: { name?: string; prices?: LocationPrice[] };
  location?: HetznerLocation;
  // Deprecated by Hetzner after 2026-07-01, retained only as a fallback for
  // older responses during the transition.
  datacenter?: { location?: HetznerLocation };
}

interface HetznerVolume {
  id?: number;
  name?: string;
  status?: string;
  server?: number | null;
  size?: number;
  location?: HetznerLocation;
}

interface HetznerFloatingIp {
  id?: number;
  name?: string;
  description?: string | null;
  type?: string;
  server?: number | null;
  blocked?: boolean;
  home_location?: HetznerLocation;
}

interface HetznerPrimaryIp {
  id?: number;
  name?: string;
  type?: string;
  assignee_id?: number | null;
  assignee_type?: string;
  blocked?: boolean;
  location?: HetznerLocation;
  datacenter?: { location?: HetznerLocation } | null;
}

interface HetznerLoadBalancer {
  id?: number;
  name?: string;
  location?: HetznerLocation;
  load_balancer_type?: { name?: string };
  outgoing_traffic?: number | null;
  ingoing_traffic?: number | null;
}

interface HetznerImage {
  id?: number;
  name?: string | null;
  description?: string;
  type?: string;
  status?: string;
  image_size?: number | null;
  disk_size?: number;
  created_from?: { id?: number; name?: string } | null;
}

const ITEMS_PER_PAGE = 50;
const MAX_PAGES = 1_000;

function invalidResponse(message: string): never {
  throw new AdapterError(message, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchAllResources<T extends { id?: number }>(
  path: string,
  collectionKey:
    | "servers"
    | "volumes"
    | "floating_ips"
    | "primary_ips"
    | "load_balancers"
    | "images",
  headers: Record<string, string>,
  extraQuery: Array<[string, string]> = []
): Promise<T[]> {
  const resources: T[] = [];
  const seenIds = new Set<number>();
  let expectedLastPage: number | null = null;
  let expectedTotalEntries: number | null = null;
  for (let requestedPage = 1; requestedPage <= MAX_PAGES; requestedPage += 1) {
    const query = new URLSearchParams(extraQuery);
    query.set("per_page", String(ITEMS_PER_PAGE));
    query.set("page", String(requestedPage));
    const response = await fetchJson(
      `https://api.hetzner.cloud/v1${path}?${query}`,
      { headers }
    );
    if (!response.ok) return errorResult(response.status);
    if (!isRecord(response.data)) {
      invalidResponse(`Hetzner returned an invalid ${collectionKey} response`);
    }
    const data = response.data;
    const rows = data[collectionKey];
    const pagination = isRecord(data.meta) && isRecord(data.meta.pagination)
      ? data.meta.pagination
      : null;
    const page = pagination?.page;
    const perPage = pagination?.per_page;
    const lastPage = pagination?.last_page;
    const totalEntries = pagination?.total_entries;
    if (
      !Array.isArray(rows) ||
      !Number.isSafeInteger(page) ||
      page !== requestedPage ||
      !Number.isSafeInteger(perPage) ||
      (perPage as number) <= 0 ||
      rows.length > (perPage as number) ||
      !Number.isSafeInteger(lastPage) ||
      (lastPage as number) < requestedPage ||
      (lastPage as number) < 1 ||
      !Number.isSafeInteger(totalEntries) ||
      (totalEntries as number) < 0
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination metadata is invalid`);
    }
    if (
      (expectedLastPage != null && expectedLastPage !== lastPage) ||
      (expectedTotalEntries != null && expectedTotalEntries !== totalEntries)
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination totals changed between pages`);
    }
    expectedLastPage = lastPage as number;
    expectedTotalEntries = totalEntries as number;
    for (const row of rows) {
      const id = row && typeof row === "object" ? (row as { id?: unknown }).id : null;
      if (!Number.isSafeInteger(id) || (id as number) <= 0) {
        invalidResponse(`Hetzner returned a ${collectionKey} resource without an id`);
      }
      if (seenIds.has(id as number)) {
        invalidResponse(`Hetzner returned duplicate ${collectionKey} id ${id}`);
      }
      seenIds.add(id as number);
      resources.push(row as T);
    }

    const nextPage = pagination?.next_page;
    if (nextPage == null) {
      if (
        requestedPage !== expectedLastPage ||
        resources.length !== expectedTotalEntries
      ) {
        invalidResponse(`Hetzner ${collectionKey} pagination ended before all resources were read`);
      }
      return resources;
    }
    if (
      !Number.isSafeInteger(nextPage) ||
      (nextPage as number) < 1 ||
      nextPage !== requestedPage + 1 ||
      requestedPage >= expectedLastPage ||
      nextPage > expectedLastPage
    ) {
      invalidResponse(`Hetzner ${collectionKey} pagination did not advance`);
    }
  }
  invalidResponse(`Hetzner ${collectionKey} pagination exceeded the safety limit`);
}

function locationName(
  direct: HetznerLocation | undefined,
  legacy?: { location?: HetznerLocation } | null
): string | null {
  return direct?.name?.trim() || legacy?.location?.name?.trim() || null;
}

function catalogNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function locationPrice(
  catalog: NamedLocationPrices[] | undefined,
  selector: string | null,
  location: string | null,
  fallback: LocationPrice[] = []
): number | null {
  if (!selector || !location) return null;
  const entry = catalog?.find(
    (candidate) => candidate.name === selector || candidate.type === selector
  );
  const prices = entry?.prices ?? fallback;
  return catalogNumber(
    prices.find((candidate) => candidate.location === location)?.price_monthly?.net
  );
}

function priceMetadata(amount: number | null, currency: string | null) {
  return amount == null || currency == null ? null : { amount, currency };
}

function roundCatalogAmount(amount: number): number {
  // Catalog rates can include sub-cent per-GB/hour fractions. Keep useful
  // precision while avoiding binary floating-point artifacts in snapshots.
  return Math.round((amount + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const projectTokens: Record<string, string> = {};
  if (config && isRecord(config.projectTokens)) {
    for (const [projectName, token] of Object.entries(config.projectTokens)) {
      if (typeof token === "string") {
        projectTokens[projectName] = token;
      }
    }
  }
  if (Object.keys(projectTokens).length === 0 && apiKey) {
    const keys = apiKey.split(",").map((k) => k.trim()).filter(Boolean);
    keys.forEach((key, i) => {
      projectTokens[keys.length === 1 ? "default" : `project_${i}`] = key;
    });
  }

  const tokens = Object.values(projectTokens);
  if (tokens.length === 0) {
    invalidResponse("No Hetzner project tokens provided");
  }

  let servers: HetznerServer[] = [];
  let volumes: HetznerVolume[] = [];
  let floatingIps: HetznerFloatingIp[] = [];
  let primaryIps: HetznerPrimaryIp[] = [];
  let loadBalancers: HetznerLoadBalancer[] = [];
  let images: HetznerImage[] = [];

  for (const token of tokens) {
    const headers = { Authorization: `Bearer ${token}` };
    const [
      tokenServers,
      tokenVolumes,
      tokenFloatingIps,
      tokenPrimaryIps,
      tokenLoadBalancers,
      tokenImages,
    ] = await Promise.all([
      fetchAllResources<HetznerServer>("/servers", "servers", headers),
      fetchAllResources<HetznerVolume>("/volumes", "volumes", headers),
      fetchAllResources<HetznerFloatingIp>("/floating_ips", "floating_ips", headers),
      fetchAllResources<HetznerPrimaryIp>("/primary_ips", "primary_ips", headers),
      fetchAllResources<HetznerLoadBalancer>("/load_balancers", "load_balancers", headers),
      fetchAllResources<HetznerImage>("/images", "images", headers, [
        ["type", "snapshot"],
        ["type", "backup"],
      ]),
    ]);
    servers = servers.concat(tokenServers);
    volumes = volumes.concat(tokenVolumes);
    floatingIps = floatingIps.concat(tokenFloatingIps);
    primaryIps = primaryIps.concat(tokenPrimaryIps);
    loadBalancers = loadBalancers.concat(tokenLoadBalancers);
    images = images.concat(tokenImages);
  }

  const pricingResponse = await fetchJson("https://api.hetzner.cloud/v1/pricing", {
    headers: { Authorization: `Bearer ${tokens[0]}` },
  });

  if (!pricingResponse.ok) return errorResult(pricingResponse.status);
  if (!pricingResponse.data || typeof pricingResponse.data !== "object") {
    invalidResponse("Hetzner returned an invalid pricing response");
  }
  const pricing = (pricingResponse.data as { pricing?: HetznerPricing }).pricing;
  if (!pricing || typeof pricing !== "object") {
    invalidResponse("Hetzner returned no pricing catalog");
  }
  const rawCurrency = pricing.currency?.trim().toUpperCase() || null;
  let exchangeRate = 1.09;
  const currencyConversionApplied = rawCurrency === "EUR";
  if (currencyConversionApplied) {
    try {
      const rateRes = await fetchJson("https://open.er-api.com/v6/latest/EUR");
      if (rateRes.ok && rateRes.data && typeof rateRes.data === "object") {
        const rates = (rateRes.data as { rates?: Record<string, number> }).rates;
        if (rates && typeof rates.USD === "number" && rates.USD > 0) {
          exchangeRate = rates.USD;
        }
      }
    } catch {
      // Gracefully fall back to HETZNER_EUR_USD_RATE or default
    }
    if (process.env.HETZNER_EUR_USD_RATE) {
      const parsed = parseFloat(process.env.HETZNER_EUR_USD_RATE);
      if (!isNaN(parsed) && parsed > 0) {
        exchangeRate = parsed;
      }
    }
  }
  const currency = currencyConversionApplied ? "USD" : rawCurrency;

  const convertPrice = (price: number | null | undefined): number | null => {
    if (price == null) return null;
    if (currencyConversionApplied) {
      return roundCatalogAmount(price * exchangeRate);
    }
    return price;
  };

  const backupPercentage = catalogNumber(pricing.server_backup?.percentage);
  const volumePricePerGb = catalogNumber(pricing.volume?.price_per_gb_month?.net);
  const imagePricePerGb = catalogNumber(pricing.image?.price_per_gb_month?.net);

  let pricingComplete = currency != null;
  const runRateByResource = {
    servers: 0,
    serverBackups: 0,
    volumes: 0,
    floatingIps: 0,
    primaryIps: 0,
    loadBalancers: 0,
    snapshots: 0,
  };
  let totalBandwidthBytes = 0;
  const records: AdapterExternalBillingRecord[] = [];

  const serverInventory = servers.map((server) => {
    if (!("backup_window" in server)) {
      invalidResponse(`Hetzner server ${server.id ?? "unknown"} omitted backup_window`);
    }
    if (
      server.backup_window !== null &&
      (typeof server.backup_window !== "string" || !server.backup_window.trim())
    ) {
      invalidResponse(`Hetzner server ${server.id ?? "unknown"} has invalid backup_window`);
    }
    const location = locationName(server.location, server.datacenter);
    const type = server.server_type?.name?.trim() || null;
    const monthlyPrice = locationPrice(
      pricing.server_types,
      type,
      location,
      server.server_type?.prices
    );
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.servers += convertedMonthlyPrice;
    const backupEnabled = Boolean(server.backup_window?.trim());
    const backupMonthlyPrice = backupEnabled && monthlyPrice != null && backupPercentage != null
      ? roundCatalogAmount(monthlyPrice * (backupPercentage / 100))
      : backupEnabled
        ? null
        : 0;
    const convertedBackupMonthlyPrice = convertPrice(backupMonthlyPrice);
    if (backupEnabled && convertedBackupMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.serverBackups += convertedBackupMonthlyPrice ?? 0;
    if (typeof server.outgoing_traffic === "number") {
      totalBandwidthBytes += server.outgoing_traffic;
    }
    if (server.id != null && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: String(server.id),
        kind: "service_plan",
        serviceName: server.name ?? `Server ${server.id}`,
        planName: type,
        status: server.status ?? "unknown",
        amountUsd: convertedMonthlyPrice,
        currency,
        rollupRole: "metadata",
      });
    }
    if (server.id != null && backupEnabled && convertedBackupMonthlyPrice != null && convertedBackupMonthlyPrice > 0) {
      records.push({
        externalId: `server-backup:${server.id}`,
        kind: "service_plan",
        serviceName: `${server.name ?? `Server ${server.id}`} backups`,
        planName: backupPercentage == null ? "Backups" : `Backups (${backupPercentage}%)`,
        status: "active",
        amountUsd: convertedBackupMonthlyPrice,
        currency,
        rollupRole: "metadata",
      });
    }
    return {
      id: server.id ?? null,
      name: server.name ?? null,
      status: server.status ?? null,
      type,
      location,
      outgoingTrafficBytes: server.outgoing_traffic ?? null,
      backupEnabled,
      monthlyCatalogPrice: priceMetadata(convertedMonthlyPrice, currency),
      backupMonthlyCatalogPrice: backupEnabled
        ? priceMetadata(convertedBackupMonthlyPrice, currency)
        : null,
    };
  });

  const volumeInventory = volumes.map((volume) => {
    const monthlyPrice =
      volumePricePerGb != null && typeof volume.size === "number" && volume.size >= 0
        ? roundCatalogAmount(volumePricePerGb * volume.size)
        : null;
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.volumes += convertedMonthlyPrice;
    if (volume.id != null && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: `volume:${volume.id}`,
        kind: "service_plan",
        serviceName: volume.name ?? `Volume ${volume.id}`,
        planName: `${volume.size} GB volume`,
        status: volume.status ?? "available",
        amountUsd: convertedMonthlyPrice,
        currency,
        usageQuantity: volume.size ?? null,
        usageUnit: "GB",
        rollupRole: volume.server == null ? "metadata" : "metadata",
      });
    }
    return {
      id: volume.id ?? null,
      name: volume.name ?? null,
      status: volume.status ?? null,
      serverId: volume.server ?? null,
      sizeGB: volume.size ?? null,
      location: locationName(volume.location),
      monthlyCatalogPrice: priceMetadata(convertedMonthlyPrice, currency),
    };
  });

  const floatingIpInventory = floatingIps.map((ip) => {
    const location = locationName(ip.home_location);
    const type = ip.type?.trim() || null;
    const typedPrice = locationPrice(pricing.floating_ips, type, location);
    const monthlyPrice = (pricing.floating_ips?.length ?? 0) > 0
      ? typedPrice
      : catalogNumber(pricing.floating_ip?.price_monthly?.net);
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.floatingIps += convertedMonthlyPrice;
    if (ip.id != null && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: `floating-ip:${ip.id}`,
        kind: "service_plan",
        serviceName: ip.name || ip.description || `Floating IP ${ip.id}`,
        planName: type ? `Floating ${type.toUpperCase()}` : "Floating IP",
        status: ip.blocked ? "blocked" : "active",
        amountUsd: convertedMonthlyPrice,
        currency,
        rollupRole: ip.server == null ? "metadata" : "metadata",
      });
    }
    return {
      id: ip.id ?? null,
      name: ip.name || ip.description || null,
      type,
      serverId: ip.server ?? null,
      blocked: ip.blocked ?? null,
      location,
      monthlyCatalogPrice: priceMetadata(convertedMonthlyPrice, currency),
    };
  });

  const primaryIpInventory = primaryIps.map((ip) => {
    const location = locationName(ip.location, ip.datacenter);
    const type = ip.type?.trim() || null;
    const monthlyPrice = locationPrice(pricing.primary_ips, type, location);
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.primaryIps += convertedMonthlyPrice;
    if (ip.id != null && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: `primary-ip:${ip.id}`,
        kind: "service_plan",
        serviceName: ip.name ?? `Primary IP ${ip.id}`,
        planName: type ? `Primary ${type.toUpperCase()}` : "Primary IP",
        status: ip.blocked ? "blocked" : "active",
        amountUsd: convertedMonthlyPrice,
        currency,
        rollupRole: ip.assignee_id == null ? "metadata" : "metadata",
      });
    }
    return {
      id: ip.id ?? null,
      name: ip.name ?? null,
      type,
      assigneeId: ip.assignee_id ?? null,
      assigneeType: ip.assignee_type ?? null,
      blocked: ip.blocked ?? null,
      location,
      monthlyCatalogPrice: priceMetadata(convertedMonthlyPrice, currency),
    };
  });

  const loadBalancerInventory = loadBalancers.map((loadBalancer) => {
    const location = locationName(loadBalancer.location);
    const type = loadBalancer.load_balancer_type?.name?.trim() || null;
    const monthlyPrice = locationPrice(pricing.load_balancer_types, type, location);
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.loadBalancers += convertedMonthlyPrice;
    if (typeof loadBalancer.outgoing_traffic === "number") {
      totalBandwidthBytes += loadBalancer.outgoing_traffic;
    }
    if (loadBalancer.id != null && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: `load-balancer:${loadBalancer.id}`,
        kind: "service_plan",
        serviceName: loadBalancer.name ?? `Load Balancer ${loadBalancer.id}`,
        planName: type,
        status: "active",
        amountUsd: convertedMonthlyPrice,
        currency,
        rollupRole: "metadata",
      });
    }
    return {
      id: loadBalancer.id ?? null,
      name: loadBalancer.name ?? null,
      type,
      location,
      outgoingTrafficBytes: loadBalancer.outgoing_traffic ?? null,
      ingoingTrafficBytes: loadBalancer.ingoing_traffic ?? null,
      monthlyCatalogPrice: priceMetadata(convertedMonthlyPrice, currency),
    };
  });

  const imageInventory = images.map((image) => {
    // Automatic backup artifacts are already represented by the one flat
    // backup add-on on their source server. Only snapshots use per-GB image
    // pricing, otherwise the same backup would be counted up to seven times.
    if (image.type !== "snapshot" && image.type !== "backup") {
      invalidResponse(`Hetzner image ${image.id ?? "unknown"} has an unsupported type`);
    }
    const isSnapshot = image.type === "snapshot";
    const monthlyPrice = isSnapshot && imagePricePerGb != null && image.image_size != null
      ? roundCatalogAmount(imagePricePerGb * image.image_size)
      : isSnapshot
        ? null
        : 0;
    const convertedMonthlyPrice = convertPrice(monthlyPrice);
    if (isSnapshot && convertedMonthlyPrice == null) pricingComplete = false;
    else runRateByResource.snapshots += convertedMonthlyPrice ?? 0;
    if (image.id != null && isSnapshot && convertedMonthlyPrice != null && convertedMonthlyPrice > 0) {
      records.push({
        externalId: `snapshot:${image.id}`,
        kind: "service_plan",
        serviceName: image.name || image.description || `Snapshot ${image.id}`,
        planName: image.image_size == null ? "Snapshot" : `${image.image_size} GB snapshot`,
        status: image.status ?? "unknown",
        amountUsd: convertedMonthlyPrice,
        currency,
        usageQuantity: image.image_size,
        usageUnit: "GB",
        rollupRole: "metadata",
      });
    }
    return {
      id: image.id ?? null,
      name: image.name || image.description || null,
      type: image.type ?? null,
      status: image.status ?? null,
      imageSizeGB: image.image_size ?? null,
      diskSizeGB: image.disk_size ?? null,
      sourceServerId: image.created_from?.id ?? null,
      monthlyCatalogPrice: isSnapshot ? priceMetadata(convertedMonthlyPrice, currency) : null,
      priceIncludedInServerBackup: image.type === "backup",
    };
  });

  const runRateAmount = roundCatalogAmount(
    Object.values(runRateByResource).reduce((sum, amount) => sum + amount, 0)
  );

  // Pro-rate catalog monthly run-rate across the UTC calendar month so budgets
  // see money without pretending this is an invoice. Hetzner Cloud API still
  // has no invoice/billing-history endpoint (accounts.hetzner.com UI only).
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthMs = Math.max(1, nextMonth.getTime() - monthStart.getTime());
  const elapsedMs = Math.min(monthMs, Math.max(0, now.getTime() - monthStart.getTime()));
  const monthFraction = elapsedMs / monthMs;
  const estimatedMtd =
    pricingComplete && runRateAmount != null && Number.isFinite(runRateAmount)
      ? roundCatalogAmount(runRateAmount * monthFraction)
      : null;

  return {
    balance: null,
    totalCost: estimatedMtd,
    costWindowStart: pricingComplete ? monthStart : null,
    costWindowEnd: pricingComplete ? now : null,
    costScope: pricingComplete ? ("calendar_month_to_date" as const) : ("unknown" as const),
    costCoverageCaveat:
      estimatedMtd != null
        ? {
            code: "hetzner_catalog_runrate_prorated",
            message:
              "Estimated MTD from Hetzner public pricing catalog × current resources, pro-rated by UTC month elapsed. Not an invoice (Hetzner has no billing API).",
          }
        : null,
    totalRequests: null,
    credits: null,
    rawData: {
      servers: serverInventory,
      volumes: volumeInventory,
      floatingIps: floatingIpInventory,
      primaryIps: primaryIpInventory,
      loadBalancers: loadBalancerInventory,
      images: imageInventory,
      resourceCounts: {
        servers: serverInventory.length,
        volumes: volumeInventory.length,
        floatingIps: floatingIpInventory.length,
        primaryIps: primaryIpInventory.length,
        loadBalancers: loadBalancerInventory.length,
        snapshots: imageInventory.filter((image) => image.type === "snapshot").length,
        backups: imageInventory.filter((image) => image.type === "backup").length,
      },
      totalBandwidthBytes,
      monthlyRunRate: pricingComplete
        ? {
            amount: runRateAmount,
            currency,
            basis: "current_resource_catalog_net_monthly_maximum",
            byResource: runRateByResource,
            estimatedMtdUsd: estimatedMtd,
            monthFraction,
          }
        : null,
      pricingVatRate: pricing.vat_rate ?? null,
      capabilities: {
        completeResourceInventory: true,
        catalogMonthlyRunRate: pricingComplete,
        catalogMtdEstimate: estimatedMtd != null,
        actualInvoiceCost: false,
        accountCurrencyKnown: currency != null,
        currencyConversionApplied,
        backupArtifactDoubleCountAvoided: true,
      },
    },
    externalBilling: pricingComplete
      ? {
          // Keep the existing namespace so the expanded authoritative list
          // replaces, rather than strands, legacy server-only records.
          source: "hetzner-cloud-server-plans",
          authoritative: true,
          records,
        }
      : undefined,
  };
}
