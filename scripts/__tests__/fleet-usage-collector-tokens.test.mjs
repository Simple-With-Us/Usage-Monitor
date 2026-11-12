import { describe, expect, it } from "vitest";

import { STATUSLINE_TOKEN_ENV_NAMES } from "../antigravity-session-collector.mjs";
import { fleetIngestJobs, fleetTokenEnvNames } from "../fleet-usage-collector.mjs";

describe("fleet collector scoped tokens", () => {
  it("resolves a producer-specific token before the unscoped fallback for every job", () => {
    const event = { eventId: "e1" };
    const jobs = fleetIngestJobs({
      quotaEvents: [event],
      sessionResults: {
        antigravity: [event],
        claude: [event],
        codex: [event],
        grok: [event],
        copilot: [event],
        deepseek: [event],
      },
    });
    expect(jobs).toHaveLength(7);
    for (const job of jobs) {
      const names = fleetTokenEnvNames(job.producerId);
      expect(names.length).toBeGreaterThan(1);
      expect(names.at(-1)).toBe("USAGE_INGEST_TOKEN");
    }
    expect(fleetTokenEnvNames("openai-codex")[0]).toBe("CODEX_INGEST_TOKEN");
    expect(fleetTokenEnvNames("claude-code")[0]).toBe("CLAUDE_CODE_INGEST_TOKEN");
  });

  it("gives distinct producers distinct first-choice token names", () => {
    const producers = [
      "antigravity-cli",
      "antigravity-statusline",
      "claude-code",
      "openai-codex",
      "grok-build",
      "github-copilot",
      "deepseek-dsh",
    ];
    const first = producers.map((p) => fleetTokenEnvNames(p)[0]);
    expect(new Set(first).size).toBe(producers.length);
  });

  it("never offers the antigravity-cli token to the status-line collector", () => {
    expect(STATUSLINE_TOKEN_ENV_NAMES).toEqual(["ANTIGRAVITY_STATUSLINE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
    expect(fleetTokenEnvNames("antigravity-statusline")).not.toContain("ANTIGRAVITY_INGEST_TOKEN");
  });
});
