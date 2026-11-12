import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../route";

describe("GET /api/datadog-public-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns configured:false when no RUM public vars are set", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ configured: false });
  });

  it("fails closed with 503 when only one public RUM var is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_DD_APPLICATION_ID", "app-id");
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.configured).toBe(false);
    expect(body.missing).toEqual(["NEXT_PUBLIC_DD_CLIENT_TOKEN"]);
    expect(JSON.stringify(body)).not.toContain("app-id");
  });

  it("returns the public RUM config when both existing public vars are set", async () => {
    vi.stubEnv("NEXT_PUBLIC_DD_APPLICATION_ID", "app-id");
    vi.stubEnv("NEXT_PUBLIC_DD_CLIENT_TOKEN", "pub-token");
    vi.stubEnv("NEXT_PUBLIC_DD_SITE", "us5.datadoghq.com");
    vi.stubEnv("DD_SERVICE", "usage-monitor");
    vi.stubEnv("DD_ENV", "prod");
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.applicationId).toBe("app-id");
    expect(body.clientToken).toBe("pub-token");
    expect(body.sessionReplaySampleRate).toBe(0);
    expect(body.site).toBe("us5.datadoghq.com");
  });
});
