import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson } from "@/lib/adapters/helpers";
import { fetchDatadogUsage, isDatadogUsageConfigured } from "@/lib/datadog-usage";

const fetchJsonMock = vi.mocked(fetchJson);

function queryResponse(value: number) {
  return {
    ok: true,
    status: 200,
    data: { status: "ok", series: [{ pointlist: [[Date.now(), value]] }] },
    headers: new Headers({ "content-type": "application/json" }),
  };
}

describe("fetchDatadogUsage", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    fetchJsonMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is unconfigured without both keys", () => {
    expect(isDatadogUsageConfigured()).toBe(false);
    vi.stubEnv("DD_API_KEY", "api");
    expect(isDatadogUsageConfigured()).toBe(false);
    vi.stubEnv("DD_APP_KEY", "app");
    expect(isDatadogUsageConfigured()).toBe(true);
  });

  it("returns last points from estimated_usage queries", async () => {
    vi.stubEnv("DD_API_KEY", "api");
    vi.stubEnv("DD_APP_KEY", "app");
    vi.stubEnv("DD_SITE", "us5.datadoghq.com");
    fetchJsonMock
      .mockResolvedValueOnce(queryResponse(2))
      .mockResolvedValueOnce(queryResponse(9))
      .mockResolvedValueOnce(queryResponse(100))
      .mockResolvedValueOnce(queryResponse(50));

    const result = await fetchDatadogUsage();
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.hosts).toBe(2);
      expect(result.containers).toBe(9);
      expect(result.logsIngestedEvents).toBe(100);
      expect(result.apmIngestedSpans).toBe(50);
      expect(result.site).toBe("us5.datadoghq.com");
    }
    expect(fetchJsonMock).toHaveBeenCalledTimes(4);
    const firstUrl = String(fetchJsonMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("api.us5.datadoghq.com/api/v1/query");
    expect(firstUrl).toContain("datadog.estimated_usage.hosts");
  });
});
