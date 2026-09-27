import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildQuotaEvent,
  clampPercent,
  toIsoTimestamp,
  windowLabelFromSeconds,
} from "../lib/quota-event.mjs";
import {
  claudeWindowToken,
  parseClaudeUsage,
  parseCodexUsage,
  parseGrokBilling,
  parseMinimaxRemains,
  parseGbuJson,
} from "../lib/subscription-quota-parsers.mjs";
import {
  PROVIDERS,
  eventsForProvider,
  fetchJson,
  grokAuthRecord,
  hostOf,
  ingestTokenEnvNames,
  parseArgs,
  resolveCredentialField,
  runGbuJson,
  GBU_PRODUCER_ID,
} from "../subscription-quota-collector.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function byLabel(readings) {
  return Object.fromEntries(readings.map((r) => [r.label, r]));
}

describe("quota-event helpers", () => {
  it("derives the window token from seconds rather than a hard-coded slot name", () => {
    expect(windowLabelFromSeconds(18_000)).toBe("5h");
    expect(windowLabelFromSeconds(604_800)).toBe("weekly");
    expect(windowLabelFromSeconds(2_592_000)).toBe("monthly");
    expect(windowLabelFromSeconds(0)).toBeNull();
    expect(windowLabelFromSeconds("nonsense")).toBeNull();
    expect(windowLabelFromSeconds(40 * 86_400)).toBe("40d");
    expect(windowLabelFromSeconds(3_000)).toBe("1h");
    expect(windowLabelFromSeconds(86_400)).toBe("daily");
  });

  it("accepts ISO, epoch seconds and epoch milliseconds", () => {
    expect(toIsoTimestamp("2026-09-12T18:00:00Z")).toBe("2026-09-12T18:00:00.000Z");
    expect(toIsoTimestamp(1_789_236_000)).toBe(toIsoTimestamp(1_789_236_000_000));
    expect(toIsoTimestamp("not a date")).toBeNull();
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(new Date("not a date"))).toBeNull();
    expect(toIsoTimestamp({})).toBeNull();
    expect(toIsoTimestamp("   ")).toBeNull();
    expect(toIsoTimestamp("1789236000")).toBe(toIsoTimestamp(1_789_236_000));
  });

  it("clamps percentages into 0-100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent("62.514")).toBe(62.51);
    expect(clampPercent(undefined)).toBeNull();
  });

  it("emits the Antigravity-compatible quota shape: credits = remaining, limit = 100", () => {
    const event = buildQuotaEvent({
      provider: "anthropic",
      service: "claude-code",
      source: "api.anthropic.com",
      occurredAtIso: "2026-09-12T12:00:00.000Z",
      reading: {
        bucketId: "anthropic:five_hour",
        label: "5h window",
        quotaWindow: "5h",
        remainingPercent: 62.5,
        usedPercent: 37.5,
        resetAt: "2026-09-12T18:00:00.000Z",
        planType: "max_20x",
        modelId: null,
        remainingUnknown: false,
        isExhausted: false,
      },
    });
    expect(event.metricType).toBe("quota");
    expect(event.credits).toBe(62.5);
    expect(event.limit).toBe(100);
    expect(event.metadata.usedPercent).toBe(37.5);
    expect(event.metadata.quotaWindow).toBe("5h");
    expect(event.metadata.resetAt).toBe("2026-09-12T18:00:00.000Z");
    expect(event.metadata.source).toBe("api.anthropic.com");
    // eventId must include the observation time.  Ingest 409s when credits
    // change under the same (producerId, eventId); a reset-only key would
    // freeze remaining % after the first LaunchAgent tick.
    expect(event.eventId).toBe(
      "subq:anthropic:anthropic:five_hour:2026-09-12T18:00:00.000Z:2026-09-12T12:00:00.000Z",
    );
  });

  it("gives each 15-minute tick its own eventId so remaining % can advance", () => {
    const reading = {
      bucketId: "anthropic:five_hour",
      label: "5h window",
      quotaWindow: "5h",
      remainingPercent: 80,
      usedPercent: 20,
      resetAt: "2026-09-12T18:00:00.000Z",
      planType: "max_20x",
      modelId: null,
      remainingUnknown: false,
      isExhausted: false,
    };
    const first = buildQuotaEvent({
      provider: "anthropic",
      service: "claude-code",
      source: "api.anthropic.com",
      occurredAtIso: "2026-09-12T12:00:00.000Z",
      reading,
    });
    const later = buildQuotaEvent({
      provider: "anthropic",
      service: "claude-code",
      source: "api.anthropic.com",
      occurredAtIso: "2026-09-12T12:15:00.000Z",
      reading: { ...reading, remainingPercent: 65, usedPercent: 35 },
    });
    expect(first.eventId).not.toBe(later.eventId);
    expect(first.credits).toBe(80);
    expect(later.credits).toBe(65);
    expect(later.metadata.resetAt).toBe(first.metadata.resetAt);
  });
});

describe("parseClaudeUsage", () => {
  const readings = parseClaudeUsage(fixture("claude-oauth-usage.json"), { planType: "max_20x" });

  it("converts utilization (percent used) into percent remaining per window", () => {
    const rows = byLabel(readings);
    expect(rows["5h window"].remainingPercent).toBe(62.5);
    expect(rows["5h window"].usedPercent).toBe(37.5);
    expect(rows["7d window"].remainingPercent).toBe(18);
  });

  it("labels the per-model window and keeps its model id", () => {
    const rows = byLabel(readings);
    expect(rows["7d window (Opus)"].remainingPercent).toBe(4.5);
    expect(rows["7d window (Opus)"].modelId).toBe("opus");
    expect(rows["7d window (Opus)"].quotaWindow).toBe("7d");
  });

  it("carries resetAt and the plan type, and ignores non-window keys", () => {
    const rows = byLabel(readings);
    expect(rows["5h window"].resetAt).toBe("2026-09-12T18:00:00.000Z");
    expect(rows["5h window"].planType).toBe("max_20x");
    expect(readings).toHaveLength(3);
  });

  it("maps window names to tokens without hard-coding the full key list", () => {
    expect(claudeWindowToken("five_hour")).toBe("5h");
    expect(claudeWindowToken("seven_day")).toBe("7d");
    expect(claudeWindowToken("thirty_day")).toBe("30d");
    expect(claudeWindowToken("two_hour")).toBe("2h");
    expect(claudeWindowToken("totally_new")).toBeNull();
  });

  it("prefers remaining_percent when utilization is missing", () => {
    const readings = parseClaudeUsage({ five_hour: { remaining_percent: 81, resets_at: "2026-09-12T18:00:00Z" } });
    expect(readings[0].remainingPercent).toBe(81);
    expect(readings[0].usedPercent).toBeNull();
  });

  it("returns nothing for an unknown shape instead of inventing a number", () => {
    expect(parseClaudeUsage({ error: "unauthorized" })).toEqual([]);
    expect(parseClaudeUsage(null)).toEqual([]);
  });
});

describe("parseCodexUsage", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const readings = parseCodexUsage(fixture("codex-wham-usage.json"), { now });

  it("derives the window label from limit_window_seconds, not the slot name", () => {
    expect(readings.map((r) => r.quotaWindow)).toEqual(["5h", "weekly"]);
  });

  it("converts used_percent into remaining and resolves reset_after_seconds", () => {
    expect(readings[0].remainingPercent).toBe(87.5);
    expect(readings[0].resetAt).toBe("2026-09-12T13:00:00.000Z");
    expect(readings[1].remainingPercent).toBe(36);
    expect(readings[1].resetAt).toBe("2026-09-14T12:00:00.000Z");
  });

  it("carries the ChatGPT plan type", () => {
    expect(readings[0].planType).toBe("pro");
  });

  it("survives a missing rate_limit block", () => {
    expect(parseCodexUsage({ plan_type: "pro" })).toEqual([]);
    expect(parseCodexUsage(undefined)).toEqual([]);
  });

  it("accepts remaining_percent and window_minutes on a camelCase rateLimit block", () => {
    const readings = parseCodexUsage(
      {
        planType: "plus",
        rateLimit: {
          primaryWindow: { remainingPercent: 40, windowMinutes: 300 },
        },
      },
      { now: Date.parse("2026-09-12T12:00:00.000Z") },
    );
    expect(readings).toHaveLength(1);
    expect(readings[0].remainingPercent).toBe(40);
    expect(readings[0].quotaWindow).toBe("5h");
    expect(readings[0].planType).toBe("plus");
  });

  it("parses now from an ISO string and skips an empty primary window", () => {
    const readings = parseCodexUsage(
      {
        plan_type: "plus",
        rate_limits: {
          primary: { unused: true },
          secondary_window: {
            used_percent: 10,
            reset_after_seconds: 60,
            limit_window_seconds: 604_800,
          },
        },
      },
      { now: "2026-09-12T12:00:00.000Z" },
    );
    expect(readings).toHaveLength(1);
    expect(readings[0].quotaWindow).toBe("weekly");
    expect(readings[0].remainingPercent).toBe(90);
  });
});

describe("parseGrokBilling", () => {
  it("computes remaining from used/limit credit counts", () => {
    const [row] = parseGrokBilling(fixture("grok-billing-credits.json"));
    expect(row.remainingPercent).toBe(75);
    expect(row.usedPercent).toBe(25);
    expect(row.quotaWindow).toBe("weekly");
    expect(row.resetAt).toBe("2026-09-15T07:00:00.000Z");
    expect(row.planType).toBe("supergrok");
  });

  it("accepts an alternate percentage field name", () => {
    const [row] = parseGrokBilling({ usedPercent: 40, window: "monthly" });
    expect(row.remainingPercent).toBe(60);
    expect(row.quotaWindow).toBe("monthly");
  });

  it("marks the window remainingUnknown when no recognised field matches", () => {
    const [row] = parseGrokBilling(fixture("grok-billing-unknown-shape.json"));
    expect(row.remainingUnknown).toBe(true);
    expect(row.remainingPercent).toBeNull();
    expect(row.planType).toBe("supergrok");
  });

  it("computes remaining from remaining credits and a limit", () => {
    const [row] = parseGrokBilling({ remaining: 20, limit: 80, interval: "weekly" });
    expect(row.remainingPercent).toBe(25);
    expect(row.usedPercent).toBe(75);
    expect(row.quotaWindow).toBe("weekly");
  });

  it("accepts remainingPercent and a seconds window on the nested credits object", () => {
    const [row] = parseGrokBilling({
      credits: { remainingPercent: 12, limit_window_seconds: 86_400, resetsAt: "2026-09-13T00:00:00Z" },
    });
    expect(row.remainingPercent).toBe(12);
    expect(row.quotaWindow).toBe("daily");
  });

  it("reads live CLI config.creditUsagePercent as percent used", () => {
    const [row] = parseGrokBilling(fixture("grok-billing-config.json"));
    expect(row.remainingPercent).toBe(49);
    expect(row.usedPercent).toBe(51);
    expect(row.quotaWindow).toBe("weekly");
    expect(row.resetAt).toBe("2026-09-17T00:00:00.000Z");
    expect(row.remainingUnknown).toBe(false);
  });

  it("falls back to config billingPeriodStart/End when currentPeriod has no dates", () => {
    const [row] = parseGrokBilling({
      config: {
        creditUsagePercent: 25,
        billingPeriodStart: "2026-09-01T00:00:00Z",
        billingPeriodEnd: "2026-10-01T00:00:00Z",
      },
    });
    expect(row.remainingPercent).toBe(75);
    expect(row.usedPercent).toBe(25);
    expect(row.quotaWindow).toBe("monthly");
    expect(row.resetAt).toBe("2026-10-01T00:00:00.000Z");
    expect(row.label).toBe("monthly window");
  });

  it("labels a config window without dates as Subscription window", () => {
    const [row] = parseGrokBilling({
      config: { creditUsagePercent: 10 },
    });
    expect(row.label).toBe("Subscription window");
    expect(row.quotaWindow).toBeNull();
    expect(row.remainingPercent).toBe(90);
    expect(row.resetAt).toBeNull();
    expect(row.remainingUnknown).toBe(false);
  });
  it("labels a config period with no dates as Subscription window", () => {
    const [row] = parseGrokBilling({ config: { creditUsagePercent: 10 } });
    expect(row.remainingPercent).toBe(90);
    expect(row.label).toBe("Subscription window");
    expect(row.quotaWindow).toBeNull();
    expect(row.resetAt).toBeNull();
  });

  it("treats creditUsagePercent 0 as remaining 100 and derives monthly from dates", () => {
    const [row] = parseGrokBilling({
      config: {
        creditUsagePercent: 0,
        currentPeriod: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
      },
    });
    expect(row.remainingPercent).toBe(100);
    expect(row.usedPercent).toBe(0);
    expect(row.quotaWindow).toBe("monthly");
  });
});

describe("grokAuthRecord", () => {
  it("unwraps a single nested Grok CLI profile and prefers the key field", () => {
    const profile = grokAuthRecord({
      "https://auth.x.ai::fixture-id": { key: "nested-secret", expires_at: "2099-01-01T00:00:00Z" },
    });
    expect(resolveCredentialField(profile, ["key", "access_token"])).toEqual({
      key: "key",
      value: "nested-secret",
    });
  });

  it("leaves a flat auth.json unchanged", () => {
    const flat = { access_token: "flat-secret" };
    expect(grokAuthRecord(flat)).toBe(flat);
    expect(resolveCredentialField(flat, ["key", "access_token"])).toEqual({
      key: "access_token",
      value: "flat-secret",
    });
  });

  it("does not unwrap when two object profiles are present", () => {
    const auth = {
      "https://auth.x.ai::a": { key: "a-secret" },
      "https://auth.x.ai::b": { key: "b-secret" },
    };
    expect(grokAuthRecord(auth)).toEqual(auth);
    expect(resolveCredentialField(grokAuthRecord(auth), ["key"])).toBeNull();
  });

  it("ignores a lone array value instead of treating it as a profile", () => {
    const auth = { items: [{ key: "nope" }] };
    expect(grokAuthRecord(auth)).toEqual(auth);
  });

  it("returns an empty record for a non-object auth file", () => {
    expect(grokAuthRecord(null)).toEqual({});
    expect(grokAuthRecord("not-json-object")).toEqual({});
  });
});

describe("fetchJson error wrapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps TimeoutError to timeout from host", async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    vi.stubGlobal("fetch", async () => {
      throw err;
    });
    await expect(fetchJson("https://cli-chat-proxy.grok.com/v1/billing")).rejects.toThrow(
      "timeout from cli-chat-proxy.grok.com",
    );
  });

  it("surfaces ETIMEDOUT cause codes on a generic fetch failure", async () => {
    const err = new Error("fetch failed");
    err.cause = { code: "ETIMEDOUT" };
    vi.stubGlobal("fetch", async () => {
      throw err;
    });
    await expect(fetchJson("https://api.minimax.io/v1/x")).rejects.toThrow(
      "fetch failed from api.minimax.io (ETIMEDOUT)",
    );
  });

  it("omits a cause code when the thrown value has none", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(fetchJson("https://api.anthropic.com/api/oauth/usage")).rejects.toThrow(
      "fetch failed from api.anthropic.com",
    );
  });

  it("keeps an unparseable URL as the host label", () => {
    expect(hostOf("not a url")).toBe("not a url");
    expect(hostOf("https://cli-chat-proxy.grok.com/v1/billing")).toBe("cli-chat-proxy.grok.com");
  });
});

describe("Grok fetch credential skips", () => {
  afterEach(() => {
    delete process.env.GROK_HOME;
  });

  async function writeGrokHome(auth) {
    const dir = await mkdtemp(join(tmpdir(), "grok-auth-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
    process.env.GROK_HOME = dir;
    return dir;
  }

  it("skips when the nested Grok CLI token is expired", async () => {
    const dir = await writeGrokHome({
      "https://auth.x.ai::fixture-id": {
        key: "nested-secret",
        expires_at: "2020-01-01T00:00:00Z",
      },
    });
    try {
      await expect(PROVIDERS.grok.fetch({ debug: false })).resolves.toEqual({
        skipped: "Grok CLI access token is expired; skipping this tick",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Grok CLI credential is present", async () => {
    const dir = await writeGrokHome({ empty: true });
    try {
      await expect(PROVIDERS.grok.fetch({ debug: false })).resolves.toEqual({
        skipped: "no Grok CLI credential found",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not unwrap when more than one nested profile exists", () => {
    const auth = { a: { key: "one" }, b: { key: "two" } };
    expect(grokAuthRecord(auth)).toBe(auth);
    expect(resolveCredentialField(grokAuthRecord(auth), ["key"])).toBeNull();
  });

  it("returns an empty record for missing auth.json", () => {
    expect(grokAuthRecord(null)).toEqual({});
    expect(resolveCredentialField(grokAuthRecord(null), ["key"])).toBeNull();
  });
});

describe("parseMinimaxRemains", () => {
  const readings = parseMinimaxRemains(fixture("minimax-coding-plan-remains.json"));

  it("computes remaining percent per model from the interval counts", () => {
    const rows = byLabel(readings);
    expect(rows["MiniMax-M2 (daily window)"].remainingPercent).toBe(80);
    expect(rows["MiniMax-Text-01 (daily window)"].remainingPercent).toBe(90);
  });

  it("does not invent a plan-wide headline by summing per-model counts", () => {
    expect(readings.some((r) => r.label === "Coding plan (all models)")).toBe(false);
    expect(readings).toHaveLength(2);
  });

  it("prefers remaining_percent over misleading count fields (live API shape)", () => {
    const live = parseMinimaxRemains(fixture("minimax-coding-plan-remains-live.json"));
    const rows = byLabel(live);
    expect(live[0].label).toBe("Coding plan (all models)");
    expect(live[0].remainingPercent).toBe(97);
    expect(rows["general (daily window)"].remainingPercent).toBe(97);
    expect(rows["general (weekly window)"].remainingPercent).toBe(92);
    expect(rows["general (weekly window)"].resetAt).toBe("2026-10-03T00:00:00.000Z");
    expect(rows["video (daily window)"].remainingPercent).toBe(100);
    expect(rows["video (weekly window)"].remainingPercent).toBe(100);
  });

  it("returns nothing when base_resp reports a failure", () => {
    expect(parseMinimaxRemains({ base_resp: { status_code: 1004 }, model_remains: [] })).toEqual([]);
  });

  it("emits remainingUnknown for a model row without counts", () => {
    const readings = parseMinimaxRemains({
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: "MiniMax-M2" }],
    });
    expect(readings).toHaveLength(1);
    expect(readings[0].remainingUnknown).toBe(true);
    expect(readings[0].remainingPercent).toBeNull();
  });

  it("accepts camelCase MiniMax remains and skips a non-array modelRemains", () => {
    const readings = parseMinimaxRemains({
      baseResp: { statusCode: 0 },
      modelRemains: [
        {
          modelName: "MiniMax-M2",
          currentIntervalUsageCount: 2,
          currentIntervalTotalCount: 10,
        },
      ],
    });
    expect(readings[0].remainingPercent).toBe(80);
    expect(parseMinimaxRemains({ base_resp: { status_code: 0 }, model_remains: { nope: true } })).toEqual([]);
  });
});

describe("collector wiring", () => {
  it("builds Antigravity-compatible events for every provider fixture", () => {
    const cases = [
      ["claude", "claude-oauth-usage.json", "anthropic", 3],
      ["codex", "codex-wham-usage.json", "openai", 2],
      ["grok", "grok-billing-credits.json", "xai", 1],
      ["grok", "grok-billing-config.json", "xai", 1],
      ["minimax", "minimax-coding-plan-remains.json", "minimax", 2],
    ];
    for (const [providerKey, file, provider, count] of cases) {
      const events = eventsForProvider(providerKey, fixture(file), {
        occurredAtIso: "2026-09-12T12:00:00.000Z",
      });
      expect(events).toHaveLength(count);
      for (const event of events) {
        expect(event.provider).toBe(provider);
        expect(event.metricType).toBe("quota");
        expect(event.limit).toBe(100);
        expect(typeof event.metadata.source).toBe("string");
      }
    }
  });

  it("drops a window it could not read rather than posting a misleading zero", () => {
    // parseGrokBilling still reports the window so a human can see it failed,
    // but the collector must not post it: the read path would score a missing
    // remaining percent as "exhausted" and tell the owner the plan is used up.
    const readings = parseGrokBilling(fixture("grok-billing-unknown-shape.json"));
    expect(readings).toHaveLength(1);
    expect(readings[0].remainingUnknown).toBe(true);
    expect(
      eventsForProvider("grok", fixture("grok-billing-unknown-shape.json"), {}),
    ).toEqual([]);
  });

  it("parses CLI flags and rejects an unknown provider", () => {
    const args = parseArgs(["node", "s.mjs", "--provider", "claude", "--dry-run", "--redacted"]);
    expect(args.providers).toEqual(["claude"]);
    expect(args.dryRun).toBe(true);
    expect(args.redacted).toBe(true);
    expect(parseArgs(["node", "s.mjs"]).providers).toEqual([
      "claude",
      "codex",
      "grok",
      "minimax",
      "grok-bot",
    ]);
    expect(() => parseArgs(["node", "s.mjs", "--provider", "gemini"])).toThrow(/Unknown --provider/);
    expect(() => parseArgs(["node", "s.mjs", "--fixture", "x.json"])).toThrow(/single --provider/);
  });

  it("resolves a credential by key NAME and never returns the name alone", () => {
    expect(resolveCredentialField({ accessToken: "x" }, ["access_token", "accessToken"])).toEqual({
      key: "accessToken",
      value: "x",
    });
    expect(
      resolveCredentialField({ tokens: { access_token: "y" } }, ["token", "tokens.access_token"]),
    ).toEqual({ key: "tokens.access_token", value: "y" });
    expect(resolveCredentialField({ nothing: 1 }, ["token"])).toBeNull();
    expect(resolveCredentialField(null, ["token"])).toBeNull();
  });
});

describe("shared-contract compliance", () => {
  it("every fixture event validates against the v2 ingest event schema", async () => {
    // A batch that fails the shared schema is rejected server-side with no
    // dashboard change to notice, so prove the shape here rather than on the Mac.
    const { UsageTelemetryV2EventSchema } = await import("@jaywedgeworth22/congress-trading-shared");
    const cases = [
      ["claude", "claude-oauth-usage.json"],
      ["codex", "codex-wham-usage.json"],
      ["grok", "grok-billing-credits.json"],
      ["grok", "grok-billing-config.json"],
      ["minimax", "minimax-coding-plan-remains.json"],
    ];
    for (const [providerKey, file] of cases) {
      for (const event of eventsForProvider(providerKey, fixture(file), {})) {
        const parsed = UsageTelemetryV2EventSchema.safeParse(event);
        expect(
          parsed.success,
          `${providerKey}/${event.label}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
        ).toBe(true);
      }
    }
  });
});

describe("per-producer ingest tokens", () => {
  it("looks up each provider's scoped token before the collector-wide fallbacks", () => {
    expect(ingestTokenEnvNames(PROVIDERS.claude)).toEqual([
      "CLAUDE_CODE_INGEST_TOKEN",
      "SUBSCRIPTION_QUOTA_INGEST_TOKEN",
      "USAGE_INGEST_TOKEN",
    ]);
    expect(ingestTokenEnvNames(PROVIDERS.codex)[0]).toBe("CODEX_INGEST_TOKEN");
    expect(ingestTokenEnvNames(PROVIDERS.grok)[0]).toBe("GROK_INGEST_TOKEN");
    expect(ingestTokenEnvNames(PROVIDERS.minimax)[0]).toBe("MINIMAX_INGEST_TOKEN");
  });

  it("gives every provider a distinct token name", () => {
    const names = Object.values(PROVIDERS).map((definition) => definition.tokenEnv);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});


describe("parseGbuJson", () => {
  it("maps weeklyUsagePercent to remaining and keeps absolutes in metadataExtras", () => {
    const readings = parseGbuJson(fixture("gbu-json.json"));
    expect(readings).toHaveLength(1);
    const [row] = readings;
    expect(row.bucketId).toBe("gbu-weekly");
    expect(row.quotaWindow).toBe("weekly");
    expect(row.label).toBe("Grok Bot weekly");
    expect(row.remainingPercent).toBe(14.63);
    expect(row.usedPercent).toBe(85.37);
    expect(row.resetAt).toBe("2026-09-28T18:35:19.304Z");
    expect(row.planType).toBe("Grok Bot Plan");
    expect(row.isExhausted).toBe(false);
    expect(row.remainingUnknown).toBe(false);
    expect(row.metadataExtras.includedSpend).toBe(33262);
    expect(row.metadataExtras.includedLimit).toBe(40000);
    expect(row.metadataExtras.includedRemaining).toBe(6738);
    expect(row.metadataExtras.onDemandUsed).toBe(0);
    expect(row.metadataExtras.email).toBe("mail@example.com");
  });

  it("marks unavailable accounts exhausted", () => {
    const readings = parseGbuJson({
      active: "a@example.com",
      accounts: [
        {
          account: "a@example.com",
          email: "a@example.com",
          active: true,
          weeklyUsagePercent: 100,
          available: false,
          resetsAt: "2026-09-28T18:35:19.304Z",
          planLabel: "Grok Bot Plan",
        },
      ],
    });
    expect(readings[0].remainingPercent).toBe(0);
    expect(readings[0].isExhausted).toBe(true);
  });

  it("gives non-active accounts a distinct bucketId so they do not collapse", () => {
    const readings = parseGbuJson({
      active: "a@example.com",
      accounts: [
        {
          account: "a@example.com",
          email: "a@example.com",
          active: true,
          weeklyUsagePercent: 10,
          available: true,
          resetsAt: "2026-09-28T18:35:19.304Z",
        },
        {
          account: "b@example.com",
          email: "b@example.com",
          active: false,
          weeklyUsagePercent: 50,
          available: true,
          resetsAt: "2026-09-28T18:35:19.304Z",
        },
      ],
    });
    expect(readings.map((r) => r.bucketId)).toEqual(["gbu-weekly", "gbu-weekly:b@example.com"]);
  });
});

describe("grok-bot provider wiring", () => {
  it("classifies an execFile timeout as a timeout, not a generic failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "gbu-timeout-"));
    const bin = join(home, "gbu");
    try {
      await writeFile(bin, "#!/bin/sh\nexit 0\n");
      await chmod(bin, 0o755);
      const error = Object.assign(new Error("Command failed"), { code: null, signal: "SIGTERM", killed: true });
      await expect(runGbuJson({ env: { HOME: home, GBU_BIN: bin }, execFileImpl: async () => { throw error; } }))
        .rejects.toThrow("gbu --json timed out");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not mistake an ordinary SIGTERM for a timeout", async () => {
    const home = await mkdtemp(join(tmpdir(), "gbu-signal-"));
    const bin = join(home, "gbu");
    try {
      await writeFile(bin, "#!/bin/sh\nexit 0\n");
      await chmod(bin, 0o755);
      const error = Object.assign(new Error("Command failed"), { code: null, signal: "SIGTERM", killed: false });
      await expect(runGbuJson({ env: { HOME: home, GBU_BIN: bin }, execFileImpl: async () => { throw error; } }))
        .rejects.toThrow(/^gbu --json failed:/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("is registered with producer gbu and source gbu", () => {
    expect(PROVIDERS["grok-bot"].provider).toBe("grok-bot");
    expect(PROVIDERS["grok-bot"].service).toBe("gbu");
    expect(PROVIDERS["grok-bot"].producerId).toBe(GBU_PRODUCER_ID);
    expect(PROVIDERS["grok-bot"].defaultSource).toBe("gbu");
    expect(ingestTokenEnvNames(PROVIDERS["grok-bot"])[0]).toBe("GBU_INGEST_TOKEN");
  });

  it("builds an ingest event with bucketId gbu-weekly and metadata.source gbu", () => {
    const events = eventsForProvider("grok-bot", fixture("gbu-json.json"), {
      source: "gbu",
      occurredAtIso: "2026-09-26T04:00:00.000Z",
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.provider).toBe("grok-bot");
    expect(event.service).toBe("gbu");
    expect(event.credits).toBe(14.63);
    expect(event.metadata.bucketId).toBe("gbu-weekly");
    expect(event.metadata.quotaWindow).toBe("weekly");
    expect(event.metadata.source).toBe("gbu");
    expect(event.metadata.includedSpend).toBe(33262);
    expect(event.metadata.includedLimit).toBe(40000);
    expect(event.metadata.includedRemaining).toBe(6738);
    expect(event.eventId).toContain("subq:grok-bot:gbu-weekly:");
  });

  it("accepts --provider grok-bot", () => {
    expect(parseArgs(["--provider", "grok-bot"]).providers).toEqual(["grok-bot"]);
  });
});
