import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MUSE_CODE_PRODUCER_ID,
  collectMuseCode,
  fetchMuseCodeKey,
  quotaEventsFromMuseCode,
  quotaReadingsFromMuseCode,
  readMuseCodeAccessTokenFromKeychain,
} from "../muse-code-usage-collector.mjs";

const OBSERVED = new Date("2026-09-15T12:00:00.000Z");
const OBSERVED_ISO = OBSERVED.toISOString();

function goodPayload(overrides = {}) {
  return {
    is_subs_active: true,
    subs_usage: {
      window: {
        used_percent: 25,
        // 1_758_990_000 -> 2025-09-27T16:20:00.000Z
        resets_at: 1_758_990_000,
        window_duration_mins: 300,
      },
      weekly: {
        used_percent: 60,
        // 1_759_248_000 -> 2025-10-01T08:00:00.000Z
        resets_at: 1_759_248_000,
      },
    },
    ...overrides,
  };
}

describe("quotaReadingsFromMuseCode", () => {
  it("returns both windows with remaining = 100 - used and ISO resetAt from epoch seconds", () => {
    const readings = quotaReadingsFromMuseCode(goodPayload(), { observedAt: OBSERVED });
    expect(readings).toHaveLength(2);

    const fiveHour = readings.find((r) => r.bucketId === "rolling-5h");
    expect(fiveHour).toBeDefined();
    expect(fiveHour.label).toBe("5h window");
    expect(fiveHour.quotaWindow).toBe("5h");
    expect(fiveHour.remainingPercent).toBe(75);
    expect(fiveHour.usedPercent).toBe(25);
    expect(fiveHour.resetAt).toBe("2025-09-27T16:20:00.000Z");
    expect(fiveHour.remainingUnknown).toBe(false);

    const weekly = readings.find((r) => r.bucketId === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly.label).toBe("weekly");
    expect(weekly.quotaWindow).toBe("weekly");
    expect(weekly.remainingPercent).toBe(40);
    expect(weekly.usedPercent).toBe(60);
    expect(weekly.resetAt).toBe("2025-09-30T16:00:00.000Z");
  });

  it("emits zero events when is_subs_active is false (no fake 0%)", () => {
    const readings = quotaReadingsFromMuseCode(
      goodPayload({ is_subs_active: false }),
      { observedAt: OBSERVED },
    );
    expect(readings).toEqual([]);
  });

  it("passes the payload's own is_subs_active through instead of hardcoding true", () => {
    const payload = goodPayload();
    delete payload.is_subs_active;
    const readings = quotaReadingsFromMuseCode(payload, { observedAt: OBSERVED });
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect("is_subs_active" in (reading.metadataExtras ?? {})).toBe(true);
      expect(reading.metadataExtras.is_subs_active).toBeUndefined();
    }
    const withTrue = quotaReadingsFromMuseCode(goodPayload({ is_subs_active: true }), {
      observedAt: OBSERVED,
    });
    for (const reading of withTrue) {
      expect(reading.metadataExtras.is_subs_active).toBe(true);
    }
  });

  it("skips cleanly when subs_usage is missing entirely (no throw, no events)", () => {
    const readings = quotaReadingsFromMuseCode({ is_subs_active: true }, { observedAt: OBSERVED });
    expect(readings).toEqual([]);
  });

  it("skips cleanly when subs_usage is null", () => {
    const readings = quotaReadingsFromMuseCode(
      { is_subs_active: true, subs_usage: null },
      { observedAt: OBSERVED },
    );
    expect(readings).toEqual([]);
  });

  it("skips cleanly when neither window block has a finite used_percent", () => {
    const readings = quotaReadingsFromMuseCode(
      {
        is_subs_active: true,
        subs_usage: {
          window: { used_percent: "nope", resets_at: 1 },
          weekly: { used_percent: null, resets_at: 1 },
        },
      },
      { observedAt: OBSERVED },
    );
    expect(readings).toEqual([]);
  });

  it("emits one window when only the rolling block is present", () => {
    const readings = quotaReadingsFromMuseCode(
      {
        is_subs_active: true,
        subs_usage: {
          window: { used_percent: 10, resets_at: 1_758_990_000 },
        },
      },
      { observedAt: OBSERVED },
    );
    expect(readings).toHaveLength(1);
    expect(readings[0].bucketId).toBe("rolling-5h");
    expect(readings[0].remainingPercent).toBe(90);
  });

  it("clamps remaining into 0-100 (e.g. used=147 invalidates)", () => {
    const readings = quotaReadingsFromMuseCode(
      goodPayload({
        subs_usage: {
          window: { used_percent: 147, resets_at: 1_758_990_000 },
          weekly: { used_percent: 60, resets_at: 1_759_248_000 },
        },
      }),
      { observedAt: OBSERVED },
    );
    const fiveHour = readings.find((r) => r.bucketId === "rolling-5h");
    expect(fiveHour.remainingPercent).toBe(0);
    expect(fiveHour.isExhausted).toBe(true);
  });
});

describe("quotaEventsFromMuseCode (canonical event shape)", () => {
  it("emits Antigravity-compatible events with credits=remaining, limit=100", () => {
    const events = quotaEventsFromMuseCode(goodPayload(), OBSERVED);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.metricType).toBe("quota");
      expect(event.provider).toBe("muse-code");
      expect(event.service).toBe("muse-code");
      expect(event.limit).toBe(100);
      expect(event.billingMode).toBe("actual");
      expect(event.confidence).toBe("actual");
      expect(event.occurredAt).toBe(OBSERVED_ISO);
      expect(event.metadata.source).toBe("api.meta.ai");
      expect(event.metadata.scale).toBe("percent_0_100");
      // Owner scope note (2026-10-05): is_subs_active is the only tier
      // signal the reversed /muse-code/key payload exposes, and it MUST
      // survive into the emitted event's metadata on both windows.
      expect(event.metadata.is_subs_active).toBe(true);
    }
    const fiveHour = events.find((e) => e.label === "5h window");
    expect(fiveHour.credits).toBe(75);
    expect(fiveHour.metadata.usedPercent).toBe(25);
    expect(fiveHour.metadata.quotaWindow).toBe("5h");
    expect(fiveHour.metadata.resetAt).toBe("2025-09-27T16:20:00.000Z");
    const weekly = events.find((e) => e.label === "weekly");
    expect(weekly.credits).toBe(40);
    expect(weekly.metadata.usedPercent).toBe(60);
    expect(weekly.metadata.quotaWindow).toBe("weekly");
    expect(weekly.metadata.resetAt).toBe("2025-09-30T16:00:00.000Z");
  });

  it("returns an empty event list for an inactive subscription", () => {
    expect(
      quotaEventsFromMuseCode(goodPayload({ is_subs_active: false }), OBSERVED),
    ).toEqual([]);
  });
});

describe("fetchMuseCodeKey (HTTP shape)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the exact URL with the required headers, redirect:'manual', and body '{}'", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(goodPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchMuseCodeKey("dummy-token", { fetchImpl });

    expect(result.is_subs_active).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://api.meta.ai/muse-code/key");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBe("{}");

    const headers = init.headers;
    expect(headers["x-api-version"]).toBe("1.0.0");
    expect(headers.accept).toBe("application/json");
    expect(headers["content-type"]).toBe("application/json");
    // Presence-only assertion: we never want to log/assert the bearer value
    expect(headers.authorization).toBe("Bearer dummy-token");
    // The string "dummy-token" must NOT appear anywhere outside the bearer header,
    // because that's exactly how accidental logging starts.
    expect(init.body).not.toContain("dummy-token");
  });

  it("throws (does NOT follow) on a 3xx redirect", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 302,
      type: "opaqueredirect",
      ok: false,
      json: async () => {
        throw new Error("should not be read on redirect");
      },
    }));

    await expect(fetchMuseCodeKey("dummy-token", { fetchImpl })).rejects.toThrow(
      /unexpected redirect/i,
    );
  });

  it("throws on non-2xx status and never touches the body for the error message", async () => {
    let bodyRead = false;
    const fetchImpl = vi.fn(async () => ({
      status: 401,
      ok: false,
      // `body` carries the API key id and account email; we must never read
      // it into an error message that could end up in logs.
      json: async () => {
        bodyRead = true;
        return { api_key: "ak_live_REDACTED", email: "test@example.com" };
      },
    }));

    try {
      await expect(fetchMuseCodeKey("dummy-token", { fetchImpl })).rejects.toThrow(
        /HTTP 401 from api\.meta\.ai/,
      );
    } finally {
      expect(bodyRead).toBe(false);
    }
  });
});

describe("readMuseCodeAccessTokenFromKeychain", () => {
  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns the access_token when the keychain JSON parses on darwin", async () => {
    const stdout = JSON.stringify({ access_token: "tk_live_FIXTURE" });
    const execFileImpl = vi.fn(async () => ({ stdout }));
    const token = await readMuseCodeAccessTokenFromKeychain({ execFileImpl, platform: "darwin" });
    expect(token).toBe("tk_live_FIXTURE");
    const [bin, args] = execFileImpl.mock.calls[0];
    expect(bin).toBe("security");
    expect(args).toEqual(["find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"]);
  });

  it("logs the Always-Allow message and returns null when execFile rejects with SIGTERM (keychain ACL timeout)", async () => {
    const error = new Error("killed");
    error.killed = true;
    error.signal = "SIGTERM";
    const execFileImpl = vi.fn(async () => {
      throw error;
    });
    const token = await readMuseCodeAccessTokenFromKeychain({
      execFileImpl,
      platform: "darwin",
      timeoutMs: 9_000,
    });
    expect(token).toBeNull();
    // Verify the explicit message that Jay will see in launchd logs.
    const lines = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(lines).toMatch(/Always Allow/);
    expect(lines).toMatch(/ai\.meta\.dev\.credentials/);
    expect(lines).toMatch(/Skipping this run \(exit 0, zero events\)/);
    expect(lines).not.toContain("tk_live_FIXTURE");
  });

  it("logs the Always-Allow message and returns null when execFile rejects with a non-zero exit (e.g. ACL denied rc=36)", async () => {
    const error = new Error("security: SecKeychainSearchCopyNext");
    error.code = 36;
    const execFileImpl = vi.fn(async () => {
      throw error;
    });
    const token = await readMuseCodeAccessTokenFromKeychain({
      execFileImpl,
      platform: "darwin",
    });
    expect(token).toBeNull();
    const lines = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(lines).toMatch(/Always Allow/);
    expect(lines).toMatch(/ai\.meta\.dev\.credentials/);
  });

  it("returns null and logs the non-darwin hint on a non-darwin platform", async () => {
    const execFileImpl = vi.fn();
    const token = await readMuseCodeAccessTokenFromKeychain({
      execFileImpl,
      platform: "linux",
    });
    expect(token).toBeNull();
    expect(execFileImpl).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(lines).toMatch(/not on macOS/i);
    expect(lines).toMatch(/ai\.meta\.dev\.credentials/);
  });

  it("returns null when stdout is empty", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "  " }));
    expect(await readMuseCodeAccessTokenFromKeychain({ execFileImpl, platform: "darwin" })).toBeNull();
  });

  it("returns null and logs a hint when stdout is non-JSON", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "not json at all" }));
    const token = await readMuseCodeAccessTokenFromKeychain({
      execFileImpl,
      platform: "darwin",
    });
    expect(token).toBeNull();
    const lines = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(lines).toMatch(/non-JSON content/);
  });

  it("returns null when JSON has no access_token string", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: JSON.stringify({ other: "field" }) }));
    expect(
      await readMuseCodeAccessTokenFromKeychain({ execFileImpl, platform: "darwin" }),
    ).toBeNull();
  });
});

describe("collectMuseCode wiring", () => {
  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns status=skipped when the keychain is unavailable (no fetch, no events)", async () => {
    const execFileImpl = vi.fn();
    const fetchImpl = vi.fn();
    const result = await collectMuseCode({
      execFileImpl,
      fetchImpl,
      platform: "linux",
      now: OBSERVED,
    });
    expect(result.status).toBe("skipped");
    expect(result.events).toEqual([]);
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches /muse-code/key once and emits both windows when the keychain works", async () => {
    const execFileImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ access_token: "tk_live_FIXTURE" }),
    }));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(goodPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await collectMuseCode({
      execFileImpl,
      fetchImpl,
      platform: "darwin",
    });
    expect(result.status).toBe("ok");
    expect(result.events).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://api.meta.ai/muse-code/key");
    // Bearer value never appears in the body — that is how accidental
    // logging of the access token starts.
    expect(init.body).toBe("{}");
    expect(init.body).not.toContain("tk_live_FIXTURE");
  });

  it("emits zero events when the payload reports is_subs_active=false", async () => {
    const execFileImpl = vi.fn(async () => ({
      stdout: JSON.stringify({ access_token: "tk_live_FIXTURE" }),
    }));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(goodPayload({ is_subs_active: false })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await collectMuseCode({
      execFileImpl,
      fetchImpl,
      platform: "darwin",
    });
    expect(result.status).toBe("skipped");
    expect(result.events).toEqual([]);
  });
});

describe("shared-contract compliance", () => {
  it("every event validates against the v2 ingest event schema", async () => {
    const { UsageTelemetryV2EventSchema } = await import("@jaywedgeworth22/congress-trading-shared");
    for (const event of quotaEventsFromMuseCode(goodPayload(), OBSERVED)) {
      const parsed = UsageTelemetryV2EventSchema.safeParse(event);
      expect(
        parsed.success,
        `${event.label}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
      ).toBe(true);
    }
  });

  it("uses the muse-code producer id consistently with the rest of the collector", () => {
    expect(MUSE_CODE_PRODUCER_ID).toBe("muse-code");
    for (const event of quotaEventsFromMuseCode(goodPayload(), OBSERVED)) {
      expect(event.provider).toBe("muse-code");
      expect(event.service).toBe("muse-code");
    }
  });
});