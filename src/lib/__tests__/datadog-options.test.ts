import { afterEach, describe, expect, it } from "vitest";

import {
  DatadogConfigError,
  DEFAULT_DD_SERVICE,
  DEFAULT_DD_SITE,
  PRODUCTION_TRACE_SAMPLE_RATE,
  assertDatadogRuntimeConfig,
  datadogBrowserIntakeOrigins,
  datadogConnectSrcOrigins,
  getDatadogReadiness,
  parseDatadogSite,
  parseSampleRate,
  parseTraceAgentPort,
  resolveDatadogRumConfig,
  resolveDatadogServerConfig,
} from "../datadog-options";

describe("datadog-options", () => {
  afterEach(() => {
    // Pure functions take an env map; nothing to restore.
  });

  it("is a no-op outside production when no Datadog vars are set", () => {
    const server = resolveDatadogServerConfig({ NODE_ENV: "test" });
    const rum = resolveDatadogRumConfig({ NODE_ENV: "test" });
    expect(server.enabled).toBe(false);
    expect(server.required).toBe(false);
    expect(rum.enabled).toBe(false);
  });

  it("stays dark in production runtime when no Datadog vars are set", () => {
    const server = resolveDatadogServerConfig({ NODE_ENV: "production" });
    expect(server.enabled).toBe(false);
    expect(server.required).toBe(false);
  });

  it("fails closed when DD_REQUIRE=1 and DD_SERVICE is missing", () => {
    expect(() =>
      resolveDatadogServerConfig({ NODE_ENV: "production", DD_REQUIRE: "1" })
    ).toThrow(DatadogConfigError);
    try {
      resolveDatadogServerConfig({ NODE_ENV: "production", DD_REQUIRE: "1" });
    } catch (error) {
      expect(error).toBeInstanceOf(DatadogConfigError);
      expect((error as DatadogConfigError).missing).toEqual(["DD_SERVICE"]);
      expect((error as DatadogConfigError).message).not.toMatch(/[a-f0-9]{32}/);
    }
  });

  it("does not fail production during a Next.js build phase", () => {
    const server = resolveDatadogServerConfig({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    });
    expect(server.enabled).toBe(false);
    expect(server.required).toBe(false);
  });

  it("keeps the build phase exempt even with DD_REQUIRE=1", () => {
    const server = resolveDatadogServerConfig({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      DD_REQUIRE: "1",
    });
    expect(server.enabled).toBe(false);
    expect(server.required).toBe(false);
  });

  it("fails closed on a partial APM signal without DD_SERVICE", () => {
    expect(() =>
      resolveDatadogServerConfig({
        NODE_ENV: "test",
        DD_AGENT_HOST: "172.17.0.1",
      })
    ).toThrow(/DD_SERVICE/);
  });

  it("enables APM from existing fleet vars without inventing secrets", () => {
    const server = resolveDatadogServerConfig({
      NODE_ENV: "production",
      DD_SERVICE: "usage-monitor",
      DD_ENV: "prod",
      DD_SITE: "us5.datadoghq.com",
      DD_AGENT_HOST: "172.17.0.1",
      SOURCE_COMMIT: "abc123",
    });
    expect(server).toMatchObject({
      enabled: true,
      required: false,
      service: "usage-monitor",
      env: "production",
      site: "us5.datadoghq.com",
      hostname: "172.17.0.1",
      port: 8126,
      version: "abc123",
      sampleRate: PRODUCTION_TRACE_SAMPLE_RATE,
      logInjection: true,
      runtimeMetrics: true,
    });
  });

  it("canonicalizes Coolify DD_ENV=prod to production", () => {
    const server = resolveDatadogServerConfig({
      NODE_ENV: "production",
      DD_SERVICE: "usage-monitor",
      DD_ENV: "prod",
      DD_SITE: "us5.datadoghq.com",
      DD_AGENT_HOST: "127.0.0.1",
    });
    expect(server.env).toBe("production");
  });

  it("honors an explicit throwaway opt-out even in production", () => {
    const server = resolveDatadogServerConfig({
      NODE_ENV: "production",
      DD_TRACE_ENABLED: "false",
    });
    expect(server.enabled).toBe(false);
    expect(server.required).toBe(false);
  });

  it("fails closed when only one RUM public var is set", () => {
    expect(() =>
      resolveDatadogRumConfig({
        NEXT_PUBLIC_DD_APPLICATION_ID: "app-id",
      })
    ).toThrow(/NEXT_PUBLIC_DD_CLIENT_TOKEN/);
  });

  it("keeps RUM dark when only site/service/env labels are set", () => {
    const rum = resolveDatadogRumConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_DD_SITE: "us5.datadoghq.com",
      NEXT_PUBLIC_DD_SERVICE: "usage-monitor",
      NEXT_PUBLIC_DD_ENV: "prod",
      DD_SITE: "us5.datadoghq.com",
      DD_SERVICE: "usage-monitor",
      DD_ENV: "prod",
    });
    expect(rum.enabled).toBe(false);
  });

  it("does not abort APM boot when RUM labels are set without tokens", () => {
    const { server, rum } = assertDatadogRuntimeConfig({
      NODE_ENV: "production",
      DD_SERVICE: "usage-monitor",
      DD_ENV: "prod",
      DD_SITE: "us5.datadoghq.com",
      NEXT_PUBLIC_DD_SITE: "us5.datadoghq.com",
      NEXT_PUBLIC_DD_SERVICE: "usage-monitor",
      NEXT_PUBLIC_DD_ENV: "prod",
    });
    expect(server.enabled).toBe(true);
    expect(rum.enabled).toBe(false);
  });

  it("does not abort APM boot when only one RUM intake var is set", () => {
    const { server, rum } = assertDatadogRuntimeConfig({
      NODE_ENV: "production",
      DD_SERVICE: "usage-monitor",
      NEXT_PUBLIC_DD_APPLICATION_ID: "app-id",
    });
    expect(server.enabled).toBe(true);
    expect(rum.enabled).toBe(false);
  });

  it("enables RUM only when both existing public vars are present", () => {
    const rum = resolveDatadogRumConfig({
      NEXT_PUBLIC_DD_APPLICATION_ID: "app-id",
      NEXT_PUBLIC_DD_CLIENT_TOKEN: "pub-token",
      DD_SERVICE: "usage-monitor",
      DD_ENV: "prod",
      DD_SITE: "us5.datadoghq.com",
    });
    expect(rum.enabled).toBe(true);
    expect(rum.applicationId).toBe("app-id");
    expect(rum.clientToken).toBe("pub-token");
    expect(rum.sessionReplaySampleRate).toBe(0);
    expect(rum.site).toBe("us5.datadoghq.com");
    expect(rum.service).toBe("usage-monitor");
  });

  it("rejects an unknown Datadog site instead of inventing an intake host", () => {
    expect(() => parseDatadogSite("made-up.datadoghq.com", DEFAULT_DD_SITE)).toThrow(
      DatadogConfigError
    );
    expect(() =>
      resolveDatadogServerConfig({
        DD_SERVICE: "usage-monitor",
        DD_SITE: "not-a-site",
      })
    ).toThrow(/unknown DD_SITE/);
  });

  it("rejects a garbage trace-agent port (fail closed)", () => {
    expect(() => parseTraceAgentPort("nope", 8126)).toThrow(/TCP port/);
    expect(() => parseSampleRate("2", 0.2)).toThrow(/0 and 1/);
  });

  it("maps US5 to the existing account intake origin", () => {
    expect(datadogBrowserIntakeOrigins("us5.datadoghq.com")).toEqual([
      "https://browser-intake-us5-datadoghq.com",
    ]);
  });

  it("adds RUM intake hosts to connect-src only when RUM is fully configured", () => {
    expect(datadogConnectSrcOrigins({ NODE_ENV: "test" })).toEqual([]);
    expect(
      datadogConnectSrcOrigins({
        NEXT_PUBLIC_DD_APPLICATION_ID: "app-id",
        NEXT_PUBLIC_DD_CLIENT_TOKEN: "pub-token",
        NEXT_PUBLIC_DD_SITE: "us5.datadoghq.com",
      })
    ).toEqual(["https://browser-intake-us5-datadoghq.com"]);
  });

  it("reports secret-free readiness and never echoes key values", () => {
    const ready = getDatadogReadiness({
      NODE_ENV: "production",
      DD_REQUIRE: "1",
      DD_API_KEY: "super-secret-api-key-value",
      DD_AGENT_HOST: "127.0.0.1",
    });
    expect(ready.required).toBe(true);
    expect(ready.apmConfigured).toBe(false);
    expect(ready.missing).toEqual(["DD_SERVICE"]);
    expect(JSON.stringify(ready)).not.toContain("super-secret-api-key-value");
  });

  it("assertDatadogRuntimeConfig returns both sides when APM is complete and RUM is absent", () => {
    const { server, rum } = assertDatadogRuntimeConfig({
      NODE_ENV: "production",
      DD_SERVICE: DEFAULT_DD_SERVICE,
    });
    expect(server.enabled).toBe(true);
    expect(rum.enabled).toBe(false);
  });
});
