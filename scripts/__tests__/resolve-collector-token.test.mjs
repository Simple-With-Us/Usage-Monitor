import { describe, expect, it, vi } from "vitest";

import { fleetSecretsGet, fleetSecretsNames, resetFleetSecretsCache } from "../lib/fleet-secrets.mjs";
import { resolveCollectorToken } from "../lib/run-session-token-collector.mjs";

function fakeFleet(values) {
  return vi.fn((name) => values[name] ?? null);
}

describe("resolveCollectorToken", () => {
  it("prefers a scoped name from fleet-secrets over an unscoped name in the environment", () => {
    const token = resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], {
      env: { USAGE_INGEST_TOKEN: "unscoped-env" },
      fleetSecretsGet: fakeFleet({ CODEX_INGEST_TOKEN: "scoped-fleet", USAGE_INGEST_TOKEN: "unscoped-fleet" }),
    });
    expect(token).toBe("scoped-fleet");
  });

  it("prefers the environment for the same name and never calls fleet-secrets", () => {
    const lookup = fakeFleet({ CODEX_INGEST_TOKEN: "scoped-fleet" });
    expect(
      resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: { CODEX_INGEST_TOKEN: "scoped-env" }, fleetSecretsGet: lookup }),
    ).toBe("scoped-env");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back in order and returns null when nothing matches", () => {
    const lookup = fakeFleet({ USAGE_INGEST_TOKEN: "unscoped-fleet" });
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBe(
      "unscoped-fleet",
    );
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: lookup })).toBeNull();
    expect(resolveCollectorToken(["CODEX_INGEST_TOKEN"], { env: {}, fleetSecretsGet: () => null })).toBeNull();
  });
});

describe("fleetSecretsGet", () => {
  const options = (exec) => ({ exec, binary: "/fake/fleet-secrets", useCache: false });

  it("returns the trimmed stdout of the root lookup", () => {
    const exec = vi.fn(() => "value-from-root\n");
    expect(fleetSecretsGet("USAGE_INGEST_TOKEN", options(exec))).toBe("value-from-root");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe("/fake/fleet-secrets");
    expect(exec.mock.calls[0][1]).toEqual(["get", "USAGE_INGEST_TOKEN", "--path", "/"]);
  });

  it("retries /global-api-keys when the key is absent at the root", () => {
    const exec = vi.fn((_bin, args) => {
      if (args.at(-1) === "/") throw Object.assign(new Error("absent"), { status: 3 });
      return "value-from-folder";
    });
    expect(fleetSecretsGet("USAGE_INGEST_TOKEN", options(exec))).toBe("value-from-folder");
    expect(exec.mock.calls.map((call) => call[1].at(-1))).toEqual(["/", "/global-api-keys"]);
  });

  it("returns null when the binary is missing or every lookup fails", () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    expect(fleetSecretsGet("USAGE_INGEST_TOKEN", options(exec))).toBeNull();
  });

  it("refuses a name that is not a plain env var name", () => {
    const exec = vi.fn(() => "x");
    expect(fleetSecretsGet("--path", options(exec))).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("caches per process", () => {
    resetFleetSecretsCache();
    const exec = vi.fn(() => "cached-value");
    const opts = { exec, binary: "/fake/fleet-secrets" };
    expect(fleetSecretsGet("CACHE_TEST_NAME", opts)).toBe("cached-value");
    expect(fleetSecretsGet("CACHE_TEST_NAME", opts)).toBe("cached-value");
    expect(exec).toHaveBeenCalledTimes(1);
    resetFleetSecretsCache();
  });
});

describe("fleetSecretsNames", () => {
  it("merges names from root and the folder and ignores junk lines", () => {
    const exec = vi.fn((_bin, args) =>
      args.at(-1) === "/" ? "ALPHA\nBETA\n\n" : "BETA\nGAMMA\nnot a name\n",
    );
    const names = fleetSecretsNames({ exec, binary: "/fake/fleet-secrets" });
    expect([...names].sort()).toEqual(["ALPHA", "BETA", "GAMMA"]);
  });

  it("returns an empty set when the binary fails", () => {
    const exec = vi.fn(() => {
      throw new Error("boom");
    });
    expect(fleetSecretsNames({ exec, binary: "/fake/fleet-secrets" }).size).toBe(0);
  });
});
