import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("Sentry private client", () => {
  it("keeps feedback and Replay off with existing mailto fallback", () => {
    const src = readFileSync(
      join(import.meta.dirname, "instrumentation-client.ts"),
      "utf8"
    );
    expect(src).not.toContain("feedbackIntegration(");
    expect(src).toContain('integration.name !== "BrowserSession"');
    expect(src).toMatch(/replaysSessionSampleRate:\s*0/);
    expect(src).toMatch(/replaysOnErrorSampleRate:\s*0/);
    expect(src).not.toContain("Sentry.replayIntegration(");
    expect(src).toMatch(/export function openSentryFeedback\(\): boolean/);
    expect(src).not.toMatch(/return true;/);
    expect(src).toMatch(/return false;/);
  });
  it("filters the installed BrowserSession integration without removing other defaults", async () => {
    const init = vi.fn();
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://0123456789abcdef@o123.ingest.us.sentry.io/456");
    vi.doMock("@sentry/nextjs", () => ({ init, captureRouterTransitionStart: vi.fn() }));
    vi.doMock("@/lib/datadog-options", () => ({ resolveDatadogRumConfig: () => ({ enabled: false }) }));
    vi.doMock("@/lib/datadog-rum-client", () => ({ startDatadogRum: vi.fn() }));
    try {
      await import("./instrumentation-client");
      const configure = init.mock.calls[0][0].integrations;
      const existing = { name: "GlobalHandlers" };
      expect(configure([existing, { name: "BrowserSession" }]).map((x: { name: string }) => x.name)).toEqual(["GlobalHandlers", "UsageMonitorPrivacy"]);
      expect(configure([existing]).map((x: { name: string }) => x.name)).toEqual(["GlobalHandlers", "UsageMonitorPrivacy"]);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("@sentry/nextjs"); vi.doUnmock("@/lib/datadog-options"); vi.doUnmock("@/lib/datadog-rum-client");
      vi.resetModules();
    }
  });

});
