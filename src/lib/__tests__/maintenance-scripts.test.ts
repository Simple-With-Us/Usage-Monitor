import { Prisma, type PrismaClient } from "@prisma/client";
import { createPrismaClient } from "@/lib/create-prisma-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeOtlpPoint } from "../otlp/mapping-utils";
import { isSecretConfigKey } from "../provider-secret-config";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
// Standalone maintenance modules are plain ESM for direct Node execution; `allowJs`
// resolves them without type declarations.
import {
  applyClaudeCumulativeCostRepair,
  historicalClaudeCostSeriesKey,
  planClaudeCumulativeCostRepair,
} from "../../../scripts/lib/claude-cost-repair.mjs";
import {
  applyProviderSecretMigration,
  decryptProviderSecretConfig,
  encryptProviderSecretConfig,
  isProviderSecretConfigKey,
  planProviderSecretMigration,
} from "../../../scripts/lib/provider-secret-migration.mjs";

let tempDirectory: string;
let prisma: PrismaClient;
const encryptionKey = Buffer.from("11".repeat(32), "hex");

beforeAll(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-scripts-test-"));
  const dbPath = path.join(tempDirectory, "test.db");
  setupPrismaSqliteTestDb(dbPath);
  prisma = createPrismaClient({ databaseUrl: `file:${dbPath}` });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_provider_secret_migration");
  await prisma.otlpMetricState.deleteMany();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.provider.deleteMany();
});

async function createProvider(
  id: string,
  config: Record<string, unknown>,
  secretConfig: string | null = null
) {
  return prisma.provider.create({
    data: {
      id,
      name: id,
      displayName: id,
      config: config as Prisma.InputJsonObject,
      secretConfig,
    },
  });
}

async function createUsageEvent(input: {
  id: string;
  occurredAt: string;
  metricType?: string;
  costUsd?: number;
  quantity?: number;
  metadata?: Record<string, unknown>;
}) {
  return prisma.externalUsageEvent.create({
    data: {
      id: input.id,
      idempotencyKey: `key-${input.id}`,
      sourceApp: "claude-code",
      provider: "anthropic",
      service: "claude-code",
      label: input.metricType === "usage" ? "token:input" : "cost",
      keyRef: "claude-sonnet",
      billingMode: "actual",
      metricType: input.metricType ?? "cost",
      costUsd: input.costUsd,
      quantity: input.quantity,
      occurredAt: new Date(input.occurredAt),
      metadata: (input.metadata ?? { model: "claude-sonnet" }) as Prisma.InputJsonObject,
    },
  });
}

describe("provider-secret migration", () => {
  it("keeps the runtime and migration secret-key classifiers in parity", () => {
    const keys = [
      "apiSecret",
      "api_secret",
      "api-token",
      "ADMIN_API_KEY",
      "clientSecret",
      "private_key",
      "Authorization",
      "extraHeaders",
      "nestedCredentialValue",
      "refresh-token",
      "webhook_secret",
      "publicKey",
      "public_key",
      "tokenBucketSize",
      "secretaryName",
      "monkey",
      "endpoint",
      "organizationId",
      "cookie",
      "cookies",
      "sessionCookie",
      "localStorage",
      "sessionStorage",
      "serviceAccountJson",
    ];
    for (const key of keys) {
      expect(isProviderSecretConfigKey(key), key).toBe(isSecretConfigKey(key));
    }
  });

  it("lets authoritative encrypted values win over stale legacy plaintext", async () => {
    const encrypted = encryptProviderSecretConfig(
      { nested: { apiSecret: "fresh", accessToken: "encrypted-only" } },
      encryptionKey
    );
    await createProvider(
      "provider-encrypted-wins",
      {
        endpoint: "https://example.test",
        nested: { apiSecret: "stale", region: "us-east" },
      },
      encrypted
    );

    const plan = await planProviderSecretMigration(prisma, { encryptionKey });
    expect(plan.candidateCount).toBe(1);
    await prisma.$transaction((tx) => applyProviderSecretMigration(tx, plan));

    const provider = await prisma.provider.findUniqueOrThrow({
      where: { id: "provider-encrypted-wins" },
    });
    expect(provider.config).toEqual({
      endpoint: "https://example.test",
      nested: { region: "us-east" },
    });
    expect(decryptProviderSecretConfig(provider.secretConfig!, encryptionKey)).toEqual({
      nested: { apiSecret: "fresh", accessToken: "encrypted-only" },
    });
  });

  it("precomputes all candidates and rolls every row back if one update fails", async () => {
    await createProvider("a-provider-ok", { endpoint: "one", apiToken: "secret-one" });
    await createProvider("z-provider-fail", { endpoint: "two", apiToken: "secret-two" });
    const plan = await planProviderSecretMigration(prisma, { encryptionKey });
    expect(plan.candidateCount).toBe(2);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_provider_secret_migration
      BEFORE UPDATE ON Provider
      WHEN OLD.id = 'z-provider-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced provider migration failure');
      END
    `);
    await expect(
      prisma.$transaction((tx) => applyProviderSecretMigration(tx, plan))
    ).rejects.toThrow();

    const providers = await prisma.provider.findMany({ orderBy: { id: "asc" } });
    expect(providers.map((provider) => provider.secretConfig)).toEqual([null, null]);
    expect(providers.map((provider) => provider.config)).toEqual([
      { endpoint: "one", apiToken: "secret-one" },
      { endpoint: "two", apiToken: "secret-two" },
    ]);
  });
});

describe("Claude cumulative-cost repair", () => {
  it("repairs cost rows only and is a no-op on rerun", async () => {
    await createUsageEvent({ id: "cost-1", occurredAt: "2026-07-01T00:00:00Z", costUsd: 2 });
    await createUsageEvent({ id: "cost-2", occurredAt: "2026-07-02T00:00:00Z", costUsd: 5 });
    await createUsageEvent({
      id: "tokens-1",
      occurredAt: "2026-07-01T00:00:00Z",
      metricType: "usage",
      quantity: 100,
    });
    await createUsageEvent({
      id: "tokens-2",
      occurredAt: "2026-07-02T00:00:00Z",
      metricType: "usage",
      quantity: 250,
    });

    const plan = await planClaudeCumulativeCostRepair(prisma);
    expect(plan.report).toMatchObject({
      mode: "dry-run",
      scope: "cost-only",
      candidateRows: 2,
      currentSummedCostUsd: 7,
      reconstructedCostUsd: 5,
      compactedClaudeRollups: 0,
    });
    const first = await prisma.$transaction((tx) =>
      applyClaudeCumulativeCostRepair(tx, plan)
    );
    expect(first.applied).toBe(2);

    const rows = await prisma.externalUsageEvent.findMany({ orderBy: { id: "asc" } });
    expect(rows.filter((row) => row.metricType === "cost").map((row) => row.costUsd)).toEqual([
      2,
      3,
    ]);
    expect(rows.filter((row) => row.metricType === "usage").map((row) => row.quantity)).toEqual([
      100,
      250,
    ]);

    const rerun = await planClaudeCumulativeCostRepair(prisma);
    expect(rerun.report.candidateRows).toBe(0);
    const second = await prisma.$transaction((tx) =>
      applyClaudeCumulativeCostRepair(tx, rerun)
    );
    expect(second).toMatchObject({ applied: 0, checkpointsSeeded: 0 });
    expect(await prisma.externalUsageEvent.count()).toBe(4);
  });

  it("rechecks rollups inside the apply transaction and leaves rows untouched", async () => {
    await createUsageEvent({ id: "cost-rollup", occurredAt: "2026-07-01T00:00:00Z", costUsd: 9 });
    const plan = await planClaudeCumulativeCostRepair(prisma);
    expect(plan.report.compactedClaudeRollups).toBe(0);
    await prisma.externalUsageEventDailyRollup.create({
      data: {
        day: new Date("2026-07-01T00:00:00Z"),
        groupKey: "rollup-group",
        sourceApp: "claude-code",
        provider: "anthropic",
        billingMode: "actual",
        metricType: "cost",
        confidence: "actual",
        latestOccurredAt: new Date("2026-07-01T00:00:00Z"),
      },
    });

    await expect(
      prisma.$transaction((tx) => applyClaudeCumulativeCostRepair(tx, plan))
    ).rejects.toThrow(/compacted Claude rollups exist/);
    const event = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { id: "cost-rollup" },
    });
    expect(event.costUsd).toBe(9);
    expect(event.metadata).toEqual({ model: "claude-sonnet" });
  });

  it("matches the OTLP series fixture and never rewinds a newer checkpoint", async () => {
    const resourceAttrs = {
      "service.name": "claude-code",
      "deployment.environment": "production",
      project: "API Usage Monitor",
      "host.name": "build-mac",
    };
    const pointAttrs = {
      model: "claude-sonnet",
      project: "Socratic.Trade",
      "user.email": "historical@example.test",
    };
    const point = {
      attributes: Object.entries(pointAttrs).map(([key, value]) => ({
        key,
        value: { stringValue: value },
      })),
      startTimeUnixNano: "1782864000000000000",
      timeUnixNano: "1782950400000000000",
      asDouble: 12,
    };
    const descriptor = describeOtlpPoint({
      metricName: "claude_code.cost.usage",
      resourceAttrs,
      point,
      value: 12,
      temporality: "cumulative",
      occurredAt: new Date("2026-07-02T00:00:00Z"),
    });
    const historicalMetadata = { ...resourceAttrs, ...pointAttrs, unit: "USD" };
    expect(historicalClaudeCostSeriesKey(historicalMetadata)).toBe(descriptor.seriesKey);

    await createUsageEvent({
      id: "cost-fixture-1",
      occurredAt: "2026-07-01T00:00:00Z",
      costUsd: 8,
      metadata: historicalMetadata,
    });
    await createUsageEvent({
      id: "cost-fixture-2",
      occurredAt: "2026-07-02T00:00:00Z",
      costUsd: 12,
      metadata: historicalMetadata,
    });
    const plan = await planClaudeCumulativeCostRepair(prisma);
    expect(plan.checkpoints[0].seriesKey).toBe(descriptor.seriesKey);

    const newerTime = "1783036800000000000";
    await prisma.otlpMetricState.create({
      data: {
        seriesKey: descriptor.seriesKey,
        metricName: descriptor.metricName,
        startTimeUnixNano: descriptor.startTimeUnixNano,
        lastTimeUnixNano: newerTime,
        lastValue: 99,
        lastPointKey: "newer-live-point",
      },
    });
    const result = await prisma.$transaction((tx) =>
      applyClaudeCumulativeCostRepair(tx, plan)
    );
    expect(result.checkpointsPreserved).toBe(1);

    const checkpoint = await prisma.otlpMetricState.findUniqueOrThrow({
      where: { seriesKey: descriptor.seriesKey },
    });
    expect(checkpoint).toMatchObject({
      lastTimeUnixNano: newerTime,
      lastValue: 99,
      lastPointKey: "newer-live-point",
    });
  });
});
