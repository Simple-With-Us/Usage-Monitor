import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getUsageReadTokenReadiness,
  isUsageReadAuthorized,
  resolveUsageReadToken,
} from "@/lib/ingest-auth";

function readRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://usage.jays.services/api/subscriptions", {
    method: "GET",
    headers,
  });
}

describe("isUsageReadAuthorized header names (X3)", () => {
  beforeEach(() => {
    vi.stubEnv("USAGE_READ_TOKEN", "read-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the canonical x-usage-read-token header", () => {
    expect(
      isUsageReadAuthorized(readRequest({ "x-usage-read-token": "read-secret" }))
    ).toBe(true);
  });

  it("still accepts the legacy x-usage-ingest-token header-name alias", () => {
    expect(
      isUsageReadAuthorized(readRequest({ "x-usage-ingest-token": "read-secret" }))
    ).toBe(true);
  });

  it("accepts Authorization: Bearer and rejects wrong/missing tokens", () => {
    expect(
      isUsageReadAuthorized(readRequest({ authorization: "Bearer read-secret" }))
    ).toBe(true);
    expect(
      isUsageReadAuthorized(readRequest({ "x-usage-read-token": "wrong" }))
    ).toBe(false);
    expect(
      isUsageReadAuthorized(readRequest({ "x-usage-ingest-token": "wrong" }))
    ).toBe(false);
    expect(isUsageReadAuthorized(readRequest({}))).toBe(false);
  });

  it("prefers the Bearer credential over either header", () => {
    expect(
      isUsageReadAuthorized(
        readRequest({
          authorization: "Bearer read-secret",
          "x-usage-read-token": "wrong",
        })
      )
    ).toBe(true);
    expect(
      isUsageReadAuthorized(
        readRequest({
          authorization: "Bearer wrong",
          "x-usage-read-token": "read-secret",
        })
      )
    ).toBe(false);
  });
});

describe("resolveUsageReadToken (C10)", () => {
  it("prefers USAGE_READ_TOKEN when set", () => {
    expect(
      resolveUsageReadToken({
        USAGE_READ_TOKEN: "read-secret",
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBe("read-secret");
  });

  it("denies ingest fallback in production by default", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toBeUndefined();
  });

  it("allows ingest fallback outside production", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });

  it("allows explicit production fallback opt-in", () => {
    expect(
      resolveUsageReadToken({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
        USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK: "true",
      } as NodeJS.ProcessEnv)
    ).toBe("ingest-secret");
  });
});

describe("getUsageReadTokenReadiness", () => {
  it("flags a fully configured production deployment", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_READ_TOKEN: "read-secret",
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: true,
      breakGlassFallback: false,
      readsAuthorized: true,
    });
  });

  it("flags the production misconfiguration monitors must alert on", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: false,
    });
  });

  it("treats break-glass fallback as authorized but not dedicated", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "production",
        USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK: "true",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: true,
      dedicated: false,
      breakGlassFallback: true,
      readsAuthorized: true,
    });
  });

  it("is not required outside production, where the fallback is allowed", () => {
    expect(
      getUsageReadTokenReadiness({
        USAGE_INGEST_TOKEN: "ingest-secret",
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: false,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: true,
    });
  });

  it("reports unauthorized when no token resolves at all", () => {
    expect(
      getUsageReadTokenReadiness({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      required: false,
      dedicated: false,
      breakGlassFallback: false,
      readsAuthorized: false,
    });
  });
});
