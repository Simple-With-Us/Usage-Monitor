import crypto from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionToken,
  isCsrfSafeRequest,
  verifyPassword,
  verifySessionToken,
} from "../auth";

const ORIGINAL_PASSWORD = process.env.DASHBOARD_PASSWORD;
const ORIGINAL_SESSION_SECRET = process.env.SESSION_SECRET;

function restoreEnv() {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = ORIGINAL_PASSWORD;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SESSION_SECRET;
}

afterEach(() => {
  restoreEnv();
});

describe("verifyPassword", () => {
  afterEach(() => restoreEnv());

  it("returns false when DASHBOARD_PASSWORD is not configured", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(verifyPassword("anything")).toBe(false);
  });

  it("accepts the exact configured password and rejects others", () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    expect(verifyPassword("correct-horse-battery-staple")).toBe(true);
    expect(verifyPassword("wrong")).toBe(false);
  });

  it("rejects length-mismatched candidates without throwing (hash-then-compare)", () => {
    // safeEqual hashes both sides before timingSafeEqual, so candidates whose
    // byte length differs from the configured password must return false —
    // never throw (raw timingSafeEqual throws on unequal lengths) and never
    // short-circuit on length before the constant-time compare.
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    expect(verifyPassword("")).toBe(false);
    expect(verifyPassword("c")).toBe(false);
    expect(verifyPassword("correct-horse-battery-staple-and-then-some")).toBe(false);
  });
});

describe("createSessionToken / verifySessionToken", () => {
  afterEach(() => restoreEnv());

  it("throws when SESSION_SECRET is not set", () => {
    delete process.env.SESSION_SECRET;
    expect(() => createSessionToken()).toThrow();
  });

  it("round-trips: a freshly created token verifies successfully", () => {
    process.env.SESSION_SECRET = "hunter2-hunter2";
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it("rejects malformed tokens", () => {
    process.env.SESSION_SECRET = "hunter2-hunter2";
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken(null)).toBe(false);
    expect(verifySessionToken("")).toBe(false);
    expect(verifySessionToken("no-dot-here")).toBe(false);
    expect(verifySessionToken("too.many.dots")).toBe(false);
    expect(verifySessionToken("not-a-number.deadbeef")).toBe(false);
  });

  it("rejects an expired token", () => {
    process.env.SESSION_SECRET = "hunter2-hunter2";
    const expiresAt = Date.now() - 1000;
    const token = `${expiresAt}.deadbeef`;
    expect(verifySessionToken(token)).toBe(false);
  });

  it("rejects a token with a tampered signature", () => {
    process.env.SESSION_SECRET = "hunter2-hunter2";
    const token = createSessionToken();
    const [expiresAt] = token.split(".");
    const tampered = `${expiresAt}.${"0".repeat(64)}`;
    expect(verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a token signed under a different SESSION_SECRET", () => {
    process.env.SESSION_SECRET = "password-one";
    const token = createSessionToken();

    process.env.SESSION_SECRET = "password-two";
    expect(verifySessionToken(token)).toBe(false);
  });

  it("does not key the HMAC on the plaintext secret directly", () => {
    process.env.SESSION_SECRET = "hunter2-hunter2";
    const token = createSessionToken();
    const [expiresAt, sig] = token.split(".");

    const naiveSig = crypto
      .createHmac("sha256", process.env.SESSION_SECRET)
      .update(expiresAt)
      .digest("hex");

    expect(sig).not.toBe(naiveSig);
  });
});

describe("isCsrfSafeRequest", () => {
  it("allows safe GET/HEAD requests regardless of Origin or Sec-Fetch-Site", () => {
    expect(
      isCsrfSafeRequest({
        method: "GET",
        headers: new Headers({ origin: "https://evil.jays.services", host: "usage.jays.services" }),
      })
    ).toBe(true);
  });

  it("allows same-origin POST requests matching host", () => {
    expect(
      isCsrfSafeRequest({
        method: "POST",
        headers: new Headers({
          origin: "https://usage.jays.services",
          host: "usage.jays.services",
          "sec-fetch-site": "same-origin",
        }),
      })
    ).toBe(true);
  });

  it("rejects POST requests with sibling-subdomain or cross-site Sec-Fetch-Site", () => {
    expect(
      isCsrfSafeRequest({
        method: "POST",
        headers: new Headers({
          origin: "https://evil.jays.services",
          host: "usage.jays.services",
          "sec-fetch-site": "same-site",
        }),
      })
    ).toBe(false);
  });

  it("rejects POST requests with mismatched Origin host", () => {
    expect(
      isCsrfSafeRequest({
        method: "POST",
        headers: new Headers({
          origin: "https://evil.jays.services",
          host: "usage.jays.services",
        }),
      })
    ).toBe(false);
  });

  it("rejects POST requests with null Origin string", () => {
    expect(
      isCsrfSafeRequest({
        method: "POST",
        headers: new Headers({
          origin: "null",
          host: "usage.jays.services",
        }),
      })
    ).toBe(false);
  });

  it("allows header-absent POST requests (iOS URLSession client regression guard)", () => {
    expect(
      isCsrfSafeRequest({
        method: "POST",
        headers: new Headers({ host: "usage.jays.services" }),
      })
    ).toBe(true);
  });
});
