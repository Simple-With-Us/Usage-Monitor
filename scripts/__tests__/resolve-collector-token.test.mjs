import { describe, expect, it, vi } from "vitest";

import { resolveCollectorToken } from "../lib/run-session-token-collector.mjs";

function fakeLookup(values) {
  return vi.fn((name) => values[name] ?? null);
}

describe("resolveCollectorToken injected lookup compatibility", () => {
  it("prefers a scoped name from the supplied lookup over an unscoped environment value", () => {
    const token = resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
      env: { USAGE_INGEST_TOKEN: "unscoped-env" },
      fleetSecretsGet: fakeLookup({ CODEX_INGEST_TOKEN: "scoped-lookup", USAGE_INGEST_TOKEN: "unscoped-lookup" }),
    });
    expect(token).toBe("scoped-lookup");
  });

  it("prefers the environment for the same name without invoking the supplied lookup", () => {
    const lookup = fakeLookup({ CODEX_INGEST_TOKEN: "scoped-lookup" });
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: { CODEX_INGEST_TOKEN: "scoped-env" }, fleetSecretsGet: lookup }),
    ).toBe("scoped-env");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back in order and returns null when nothing matches", () => {
    const lookup = fakeLookup({ USAGE_INGEST_TOKEN: "unscoped-lookup" });
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBe(
      "unscoped-lookup",
    );
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBeNull();
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: () => null })).toBeNull();
  });
});
