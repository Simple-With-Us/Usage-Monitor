export type B2AppId =
  | "usage-monitor"
  | "socratic-trade"
  | "congress-trade"
  | "fleet-infra"
  | "other";

export interface B2AppUsageSlice {
  id: B2AppId;
  label: string;
  bucketNames: string[];
  storageGb: number;
  latestDay: {
    date: string;
    storedGb: number;
    downloadedGb: number;
    classCTransactions: number;
    classBTransactions: number;
  } | null;
}

export interface B2AppUsageDailyPoint {
  date: string;
  accountDownloadedGb: number;
  accountClassCTotal: number;
  byApp: Partial<
    Record<B2AppId, { downloadedGb: number; classCTransactions: number }>
  >;
}

export interface B2AppUsageBreakdownPayload {
  configured: boolean;
  asOf: string;
  cacheAgeSeconds: number;
  reportDate: string | null;
  storageSource: "external_billing" | "unavailable";
  reportSource: "usage_csv" | "unavailable";
  warnings: string[];
  caps: {
    classCDailyFree: number;
    downloadGbDailyFree: number;
  };
  alerts: {
    classCNearCap: boolean;
    downloadNearCap: boolean;
    classCSpike: boolean;
  };
  apps: B2AppUsageSlice[];
  dailySeries: B2AppUsageDailyPoint[];
}
