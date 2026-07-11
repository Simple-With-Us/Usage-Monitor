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
  await prisma.providerAlertChannelDelivery.deleteMany();
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

  it("retries only the failed channel while preserving successful channel state", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "partial-delivery",
        displayName: "Partial Delivery",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const slackUrl = "https://hooks.slack.test/services/channel";
    const webhookUrl = "https://alerts.example/webhook";
    let webhookCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === slackUrl) return new Response("ok", { status: 200 });
      webhookCalls += 1;
      return new Response(webhookCalls === 1 ? "down" : "ok", {
        status: webhookCalls === 1 ? 503 : 200,
      });
    });
    const config = {
      channels: [
        { kind: "slack" as const, url: slackUrl },
        { kind: "webhook" as const, url: webhookUrl },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(first.sent).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelStates = await prisma.providerAlertChannelDelivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { channelKind: "asc" },
    });
    expect(channelStates).toHaveLength(2);
    expect(channelStates.find((state) => state.channelKind === "slack")?.lastSucceededAt).not.toBeNull();
    expect(channelStates.find((state) => state.channelKind === "webhook")?.lastSucceededAt).toBeNull();

    const second = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(second.sent).toBe(1);
    expect(second.errors).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toBe(webhookUrl);

    const third = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(third.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("times out a hung channel attempt and succeeds on a bounded retry", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "timeout-retry",
        displayName: "Timeout Retry",
        type: "builtin",
        plan: { create: { billingMode: "actual", lowBalanceUsd: 10 } },
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-20T08:00:00.000Z"),
            balance: 5,
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config: {
        channels: [{ kind: "webhook", url: "https://alerts.example/timeout" }],
        minSeverity: "warning",
        reminderHours: 24,
        timeoutMs: 5,
        maxAttempts: 2,
        retryBaseMs: 0,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.sent).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const notification = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(channelState.attemptCount).toBe(2);
    expect(channelState.successCount).toBe(1);
    expect(channelState.lastError).toBeNull();
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
    const body = JSON.parse(String(callArgs[1]?.body ?? "{}"));
    expect(body.to).toBe("oncall@example.com");
    expect(body.from).toBe("alerts@example.com");
    expect(body.subject).toContain("Test Email");
    expect(body.html).toContain("Test Email");
  });

  it("uses one PagerDuty dedup key for trigger, retried resolve, and reopen", async () => {
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

    const responseStatuses = [202, 503, 202, 202];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: responseStatuses.shift() ?? 202 })
    );
    const config = {
      channels: [
        { kind: "pagerduty" as const, routingKey: "test-routing-key" },
      ],
      minSeverity: "warning" as const,
      reminderHours: 24,
      maxAttempts: 1,
      retryBaseMs: 0,
    };

    const first = await deliverProviderAlerts({
      now: new Date("2026-07-20T12:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    
    expect(first.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(String(callArgs[1]?.body ?? "{}"));
    expect(body.routing_key).toBe("test-routing-key");
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe(`api-usage-monitor:${provider.id}:balance_low`);
    expect(body.payload.source).toBe("API Usage Monitor");
    expect(body.payload.component).toBe("test_pd");
    expect(body.payload.severity).toBe("warning"); // The default balance low is warning

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T13:00:00.000Z"),
        balance: 25,
      },
    });
    const failedResolve = await deliverProviderAlerts({
      now: new Date("2026-07-20T13:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(failedResolve.resolved).toBe(0);
    expect(failedResolve.errors).toHaveLength(1);
    const stillOpen = await prisma.providerAlertNotification.findUniqueOrThrow({
      where: { stateKey: `${provider.id}:balance_low` },
    });
    expect(stillOpen.resolvedAt).toBeNull();

    const resolved = await deliverProviderAlerts({
      now: new Date("2026-07-20T14:00:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.resolved).toBe(1);
    const resolveBodies = fetchMock.mock.calls
      .slice(1, 3)
      .map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
    expect(resolveBodies.every((payload) => payload.event_action === "resolve")).toBe(true);
    expect(resolveBodies.every((payload) => payload.dedup_key === body.dedup_key)).toBe(true);

    const channelState = await prisma.providerAlertChannelDelivery.findFirstOrThrow({
      where: { notificationId: stillOpen.id, channelKind: "pagerduty" },
    });
    expect(channelState.resolveAttemptCount).toBe(2);
    expect(channelState.lastResolvedAt).not.toBeNull();

    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-20T15:00:00.000Z"),
        balance: 5,
      },
    });
    const reopened = await deliverProviderAlerts({
      now: new Date("2026-07-20T15:30:00.000Z"),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(reopened.sent).toBe(1);
    const reopenedBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body ?? "{}"));
    expect(reopenedBody.event_action).toBe("trigger");
    expect(reopenedBody.dedup_key).toBe(body.dedup_key);
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
