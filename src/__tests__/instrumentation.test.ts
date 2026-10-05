import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startUsagePollingScheduler: vi.fn(),
  applySqliteNativeMemoryPragmas: vi.fn().mockResolvedValue(undefined),
  computeBudgetStatus: vi.fn().mockResolvedValue({}),
  computeProjectBudgetStatus: vi.fn().mockResolvedValue({}),
  deactivateDecommissionedBuiltInProviders: vi.fn().mockResolvedValue(0),
  clearLlmMustKeepFundedFlags: vi.fn().mockResolvedValue(0),
  initDatadogTracer: vi.fn(),
}));

vi.mock("@/lib/usage-recorder", () => ({
  startUsagePollingScheduler: mocks.startUsagePollingScheduler,
}));

vi.mock("@/lib/prisma", () => ({
  applySqliteNativeMemoryPragmas: mocks.applySqliteNativeMemoryPragmas,
}));

vi.mock("@/lib/provider-retirement", () => ({
  deactivateDecommissionedBuiltInProviders:
    mocks.deactivateDecommissionedBuiltInProviders,
}));

vi.mock("@/lib/provider-funding-policy", () => ({
  clearLlmMustKeepFundedFlags: mocks.clearLlmMustKeepFundedFlags,
}));

vi.mock("@/lib/budget-status", () => ({
  computeBudgetStatus: mocks.computeBudgetStatus,
  computeProjectBudgetStatus: mocks.computeProjectBudgetStatus,
}));

vi.mock("@/lib/datadog-server", () => ({
  initDatadogTracer: mocks.initDatadogTracer,
}));

import { isUsageSchedulerEnabled, register } from "@/instrumentation";
import {
  isSchedulerEnabled,
  resetSchedulerGateForTests,
} from "@/lib/runtime-health";

function clearInfisicalCredEnv() {
  for (const name of [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_AUTOMATION_CLIENT_ID",
    "INFISICAL_AUTOMATION_CLIENT_SECRET",
  ]) {
    delete process.env[name];
  }
}

describe("usage scheduler instrumentation", () => {
  beforeEach(() => {
    // The boot gate is recorded module-global state; each register() run in
    // this file must evaluate its own stubbed env, not the previous test's.
    resetSchedulerGateForTests();
    // init() resolves credentials from the ambient env when register() is
    // called without explicit creds: an exported credential in the shell
    // would flip the service into Infisical mode and take the gate off the
    // stubbed process.env.  Same hazard the app-settings suite guards.
    clearInfisicalCredEnv();
    mocks.startUsagePollingScheduler.mockReset();
    mocks.applySqliteNativeMemoryPragmas.mockClear();
    mocks.computeBudgetStatus.mockClear();
    mocks.computeBudgetStatus.mockResolvedValue({});
    mocks.computeProjectBudgetStatus.mockClear();
    mocks.computeProjectBudgetStatus.mockResolvedValue({});
    mocks.deactivateDecommissionedBuiltInProviders.mockClear();
    mocks.deactivateDecommissionedBuiltInProviders.mockResolvedValue(0);
    mocks.clearLlmMustKeepFundedFlags.mockClear();
    mocks.clearLlmMustKeepFundedFlags.mockResolvedValue(0);
    mocks.initDatadogTracer.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("defaults the scheduler on and recognizes only an explicit false value", () => {
    expect(isUsageSchedulerEnabled(undefined)).toBe(true);
    expect(isUsageSchedulerEnabled("")).toBe(true);
    expect(isUsageSchedulerEnabled("true")).toBe(true);
    expect(isUsageSchedulerEnabled(" FALSE ")).toBe(false);
  });

  it("starts polling in the Node runtime by default", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");

    await register();

    expect(mocks.startUsagePollingScheduler).toHaveBeenCalledOnce();
    expect(mocks.deactivateDecommissionedBuiltInProviders).toHaveBeenCalledOnce();
    expect(mocks.clearLlmMustKeepFundedFlags).toHaveBeenCalledOnce();
  });

  it("bounds native SQLite memory before deciding whether polling is enabled", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    // Applied even on the emergency-disabled path: HTTP requests still use
    // Prisma whether or not the polling scheduler itself is running.
    expect(mocks.applySqliteNativeMemoryPragmas).toHaveBeenCalledOnce();
    expect(mocks.deactivateDecommissionedBuiltInProviders).toHaveBeenCalledOnce();
  });

  it("does not import or start polling when the emergency gate is false", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
    expect(mocks.deactivateDecommissionedBuiltInProviders).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "[usage-scheduler] disabled by USAGE_SCHEDULER_ENABLED=false"
    );
  });

  it("pins the boot gate: a post-boot knob flip does not change the recorded answer", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");

    await register();
    expect(isSchedulerEnabled()).toBe(false);

    // Operator flips the knob post-boot; the recorded boot decision stands,
    // so /api/ready keeps agreeing with what the process actually did.
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "true");
    expect(isSchedulerEnabled()).toBe(false);
    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
  });

  it("does not start the Node scheduler or touch SQLite in non-Node runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "true");

    await register();

    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
    expect(mocks.applySqliteNativeMemoryPragmas).not.toHaveBeenCalled();
  });

  // Regression guard: register() must NOT warm the budget-status caches at
  // boot. A previous revision did (deferred setTimeout, warming both caches),
  // and it crash-looped production - warming computeProjectBudgetStatus runs
  // its internal Promise.all (computeBudgetStatus's ~336k-row groupBy AND the
  // attribution ~336k-row groupBy) concurrently, and two such aggregations at
  // once peaked past the 512MB instance limit and OOM-killed the box ~40-100s
  // into every boot. The SWR cache must stay lazily populated on first
  // request. Advancing timers here catches a re-introduced deferred warm-up,
  // not just a synchronous one.
  it("fails closed in production Node runtime when DD_SERVICE is missing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");

    await expect(register()).rejects.toThrow(/DD_SERVICE/);
    expect(mocks.startUsagePollingScheduler).not.toHaveBeenCalled();
  });

  it("starts in production when APM is complete and RUM is only labeled", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DD_SERVICE", "usage-monitor");
    vi.stubEnv("DD_ENV", "prod");
    vi.stubEnv("DD_SITE", "us5.datadoghq.com");
    vi.stubEnv("NEXT_PUBLIC_DD_SITE", "us5.datadoghq.com");
    vi.stubEnv("NEXT_PUBLIC_DD_SERVICE", "usage-monitor");
    vi.stubEnv("NEXT_PUBLIC_DD_ENV", "prod");

    await register();

    expect(mocks.initDatadogTracer).toHaveBeenCalledOnce();
    expect(mocks.startUsagePollingScheduler).toHaveBeenCalledOnce();
  });

  it("starts in production when APM is complete and one RUM intake var is set", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DD_SERVICE", "usage-monitor");
    vi.stubEnv("NEXT_PUBLIC_DD_APPLICATION_ID", "app-id");

    await register();

    expect(mocks.initDatadogTracer).toHaveBeenCalledOnce();
    expect(mocks.startUsagePollingScheduler).toHaveBeenCalledOnce();
  });

  it("does not warm the budget-status caches at boot (OOM'd the 512MB instance)", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "");

    await register();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.computeBudgetStatus).not.toHaveBeenCalled();
    expect(mocks.computeProjectBudgetStatus).not.toHaveBeenCalled();
  });
});
