import { describe, expect, it, vi } from "vitest";

import { resolveCollectorToken } from "../lib/run-session-token-collector.mjs";

function fakeLookup(values) {
  return vi.fn((name) => values[name] ?? null);
}

// A service-token-shaped fixture assembled at runtime: the resolver's shape
// check needs the form, and a literal here trips the repo's secret scanner.
const FAKE_SERVICE_TOKEN = ["st", "abc123", "secret456"].join(".");

describe("resolveCollectorToken store-first precedence (OPS-1120)", () => {
  it("prefers the scoped store for the same name over an environment value", () => {
    const lookup = fakeLookup({ CODEX_INGEST_TOKEN: "scoped-lookup" });
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: { CODEX_INGEST_TOKEN: "env-value" }, fleetSecretsGet: lookup }),
    ).toBe("scoped-lookup");
    expect(lookup).toHaveBeenCalledWith("CODEX_INGEST_TOKEN");
  });

  it("prefers a scoped name from the supplied lookup over an unscoped environment value", () => {
    const token = resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
      env: { USAGE_INGEST_TOKEN: "unscoped-env" },
      fleetSecretsGet: fakeLookup({ CODEX_INGEST_TOKEN: "scoped-lookup", USAGE_INGEST_TOKEN: "unscoped-lookup" }),
    });
    expect(token).toBe("scoped-lookup");
  });

  it("falls back to the environment only for a name the store did not answer", () => {
    const lookup = fakeLookup({});
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: "env-codex", USAGE_INGEST_TOKEN: "env-unscoped" },
        fleetSecretsGet: lookup,
      }),
    ).toBe("env-codex");
    expect(lookup).toHaveBeenCalledWith("CODEX_INGEST_TOKEN");
  });

  it("refuses a service-token-shaped environment value the store did not provide", () => {
    expect(() =>
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: FAKE_SERVICE_TOKEN },
        fleetSecretsGet: fakeLookup({}),
      }),
    ).toThrow(/own Infisical binding/);
  });

  it("does not let a refused name block a valid later candidate", () => {
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: FAKE_SERVICE_TOKEN, USAGE_INGEST_TOKEN: "usage-env" },
        fleetSecretsGet: fakeLookup({}),
      }),
    ).toBe("usage-env");
  });

  it("accepts a service-token-shaped value in strict injected-secrets mode", () => {
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: FAKE_SERVICE_TOKEN, COLLECTOR_STRICT_INJECTED_SECRETS: "1" },
        fleetSecretsGet: fakeLookup({ CODEX_INGEST_TOKEN: "ignored" }),
      }),
    ).toBe(FAKE_SERVICE_TOKEN);
  });

  it("skips the store entirely in strict injected-secrets mode", () => {
    const lookup = fakeLookup({ CODEX_INGEST_TOKEN: "scoped-lookup" });
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: "delivered-value", COLLECTOR_STRICT_INJECTED_SECRETS: "1" },
        fleetSecretsGet: lookup,
      }),
    ).toBe("delivered-value");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("treats a whitespace-padded strict flag as strict", () => {
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: "delivered-value", COLLECTOR_STRICT_INJECTED_SECRETS: " 1 " },
        fleetSecretsGet: fakeLookup({ CODEX_INGEST_TOKEN: "ignored" }),
      }),
    ).toBe("delivered-value");
  });

  it("falls back in order and returns null when nothing matches", () => {
    const lookup = fakeLookup({ USAGE_INGEST_TOKEN: "unscoped-lookup" });
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBe(
      "unscoped-lookup",
    );
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBeNull();
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: () => null })).toBeNull();
  });

  it("rethrows a deferred store failure only when no name yields a value", () => {
    const boom = new Error("scoped read unavailable");
    expect(() =>
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: {},
        fleetSecretsGet: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], {
        env: { CODEX_INGEST_TOKEN: "env-value" },
        fleetSecretsGet: () => {
          throw boom;
        },
      }),
    ).toBe("env-value");
  });
});