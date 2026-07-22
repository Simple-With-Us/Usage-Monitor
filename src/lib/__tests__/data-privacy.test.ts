import { describe, expect, it } from "vitest";
import { redactProviderRawData } from "../data-privacy";

describe("redactProviderRawData (Wave H / E10)", () => {
  it("strips custom adapter bodies to metadata only", () => {
    const result = redactProviderRawData("custom", "my-hook", {
      email: "user@example.com",
      token: "secret",
      __apiUsageMonitor: { partialFailure: { retryable: true } },
    }) as Record<string, unknown>;

    expect(result.email).toBeUndefined();
    expect(result.token).toBeUndefined();
    expect(result.__apiUsageMonitor).toMatchObject({
      partialFailure: { retryable: true },
      privacy: { strategy: "strip_all", redacted: true },
    });
  });

  it("allowlists built-in money fields and drops PII-shaped keys", () => {
    const result = redactProviderRawData("builtin", "openai", {
      totalCost: 12.5,
      costScope: "calendar_month_to_date",
      userEmail: "alice@example.com",
      rawUpstream: { authorization: "Bearer sk-..." },
      __apiUsageMonitor: { note: "keep" },
    }) as Record<string, unknown>;

    expect(result.totalCost).toBe(12.5);
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(result.userEmail).toBeUndefined();
    expect(result.rawUpstream).toBeUndefined();
    expect(result.__apiUsageMonitor).toMatchObject({
      note: "keep",
      privacy: {
        strategy: "allowlist",
        redacted: true,
      },
    });
    const privacy = (result.__apiUsageMonitor as { privacy: { droppedFields: string[] } })
      .privacy;
    expect(privacy.droppedFields).toEqual(
      expect.arrayContaining(["userEmail", "rawUpstream"])
    );
  });
});
