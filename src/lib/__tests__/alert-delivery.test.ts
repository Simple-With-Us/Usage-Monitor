import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let deliverProviderAlerts: typeof import("../alert-delivery").deliverProviderAlerts;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-delivery-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ deliverProviderAlerts } = await import("../alert-delivery"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.providerAlertNotification.deleteMany();
  await prisma.externalUsageEventTombstone.deleteMany();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
  await prisma.usageSnapshotDailyRollup.deleteMany();
  await prisma.usageSnapshot.deleteMany();
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

describe("alert delivery", () => {
  it("sends one alert, suppresses reminders until due, and resolves cleared alerts", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "twilio",
        displayName: "Twilio",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            billingMode: "actual",
            lowBalanceUsd: 10,
          },
        },
      },
    });

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
        balance: 5,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [{ kind: "webhook" as const, url: "https://alerts.example/webhook" }],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(first.sent).toBe(1);
    expect(first.activeAlerts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const notifications = await prisma.providerAlertNotification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].sendCount).toBe(1);
    expect(notifications[0].resolvedAt).toBeNull();

    const second = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T14:00:00.000Z"),
        balance: 25,
      },
    });

    const third = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:30:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    expect(third.resolved).toBe(1);

    const resolved = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("supports email delivery via Resend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "test_email",
        displayName: "Test Email",
        type: "builtin",
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [
        { kind: "email" as const, apiKey: "test-api-key", from: "alerts@example.com", to: "oncall@example.com" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };

    // We need an alert to be triggered, let's create a snapshot to trigger a balance low
    await prisma.providerPlan.create({
      data: {
        providerId: provider.id,
        billingMode: "actual",
        lowBalanceUsd: 10,
      }
    });

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
        balance: 5,
      },
    });

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    
    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.resend.com/emails");
    expect(callArgs[1].headers).toMatchObject({
      Authorization: "Bearer test-api-key",
    });
    const body = JSON.parse(callArgs[1].body);
    expect(body.to).toBe("oncall@example.com");
    expect(body.from).toBe("alerts@example.com");
    expect(body.subject).toContain("Test Email");
    expect(body.html).toContain("Test Email");
  });

  it("supports pagerduty delivery", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "test_pd",
        displayName: "Test PD",
        type: "builtin",
        plan: {
          create: {
            billingMode: "actual",
            lowBalanceUsd: 10,
          },
        },
      },
    });

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
        balance: 5,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "test-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock,
    });
    
    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(callArgs[1].body);
    expect(body.routing_key).toBe("test-routing-key");
    expect(body.payload.source).toBe("API Usage Monitor");
    expect(body.payload.component).toBe("test_pd");
    expect(body.payload.severity).toBe("warning"); // The default balance low is warning
  });

  it("delivers budget alerts from canonical pushed spend", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: { billingMode: "actual", monthlyBudgetUsd: 10 },
        },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T11:00:00.000Z"),
            totalCost: 0,
          },
        },
      },
    });
    await prisma.externalUsageEvent.create({
      data: {
        idempotencyKey: "pushed-budget-warning",
        sourceApp: "claude-code",
        provider: "anthropic",
        billingMode: "actual",
        metricType: "cost",
        costUsd: 9,
        occurredAt: new Date("2026-07-20T10:00:00.000Z"),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/webhook" }],
        minSeverity: "warning",
        reminderHours: 24,
      },
      fetchImpl: fetchMock,
    });

    expect(result.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.provider.id).toBe(provider.id);
    expect(payload.alert.code).toBe("budget_warning");
    expect(payload.alert.message).toContain("$9.00");
  });
});
