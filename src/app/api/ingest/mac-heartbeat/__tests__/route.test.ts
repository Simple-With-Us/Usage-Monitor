import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const recordMacHeartbeat = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mac-health", () => ({ recordMacHeartbeat }));

import { POST } from "../route";

function heartbeat(token?: string): NextRequest {
  return new NextRequest("https://usage.jays.services/api/ingest/mac-heartbeat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ host: "test-mac" }),
  });
}

describe("POST /api/ingest/mac-heartbeat", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    recordMacHeartbeat.mockReset();
    recordMacHeartbeat.mockResolvedValue({ recorded: true });
    vi.stubEnv("USAGE_INGEST_TOKEN", "unscoped-token");
    vi.stubEnv("USAGE_INGEST_PRODUCER_TOKENS", "mac-host:heartbeat-token,codecaps:caps-token");
  });

  it("rejects a missing token", async () => {
    expect((await POST(heartbeat())).status).toBe(401);
    expect(recordMacHeartbeat).not.toHaveBeenCalled();
  });

  it("accepts the mac-host scoped token", async () => {
    const res = await POST(heartbeat("heartbeat-token"));
    expect(res.status).toBe(200);
    expect(recordMacHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("refuses a token scoped to another producer", async () => {
    const res = await POST(heartbeat("caps-token"));
    expect(res.status).toBe(403);
    expect(recordMacHeartbeat).not.toHaveBeenCalled();
  });

  it("accepts the unscoped token only while scoped tokens are optional", async () => {
    expect((await POST(heartbeat("unscoped-token"))).status).toBe(200);
    vi.stubEnv("USAGE_INGEST_REQUIRE_SCOPED_TOKENS", "true");
    expect((await POST(heartbeat("unscoped-token"))).status).toBe(401);
    expect((await POST(heartbeat("heartbeat-token"))).status).toBe(200);
  });
});
