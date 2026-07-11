import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  isSessionAuthConfigured,
  verifySessionToken,
} from "../auth";

const CURRENT_SECRET = "current-session-secret-0123456789abcdef";
const PREVIOUS_SECRET = "previous-session-secret-0123456789abcdef";

describe("dashboard session signing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    process.env.SESSION_SECRET = CURRENT_SECRET;
    process.env.SESSION_VERSION = "1";
    delete process.env.SESSION_SECRET_PREVIOUS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET_PREVIOUS;
    delete process.env.SESSION_VERSION;
  });

  it("uses a distinct random session secret and nonce", () => {
    expect(isSessionAuthConfigured()).toBe(true);
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first.startsWith("v1.1.")).toBe(true);
    expect(verifySessionToken(first)).toBe(true);
    expect(verifySessionToken(second)).toBe(true);
  });

  it("fails closed when the signing secret is missing or too short", () => {
    process.env.SESSION_SECRET = "short";
    expect(isSessionAuthConfigured()).toBe(false);
    expect(() => createSessionToken()).toThrow(/SESSION_SECRET/);
    expect(verifySessionToken("v1.1.1.nonce.signature")).toBe(false);
  });

  it("supports graceful secret rotation without accepting unrelated secrets", () => {
    process.env.SESSION_SECRET = PREVIOUS_SECRET;
    const previousToken = createSessionToken();

    process.env.SESSION_SECRET = CURRENT_SECRET;
    process.env.SESSION_SECRET_PREVIOUS = PREVIOUS_SECRET;
    expect(verifySessionToken(previousToken)).toBe(true);

    delete process.env.SESSION_SECRET_PREVIOUS;
    expect(verifySessionToken(previousToken)).toBe(false);
  });

  it("invalidates every cookie when the session version changes", () => {
    const token = createSessionToken();
    process.env.SESSION_VERSION = "2";
    expect(verifySessionToken(token)).toBe(false);
  });

  it("fails closed instead of falling back when the session version is invalid", () => {
    const token = createSessionToken();
    process.env.SESSION_VERSION = "2!";

    expect(isSessionAuthConfigured()).toBe(false);
    expect(() => createSessionToken()).toThrow(/SESSION_VERSION/);
    expect(verifySessionToken(token)).toBe(false);
  });

  it("rejects expired and implausibly long-lived tokens", () => {
    const token = createSessionToken();
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1_000);
    expect(verifySessionToken(token)).toBe(false);

    const [format, version, , nonce] = token.split(".");
    const forged = `${format}.${version}.${Date.now() + 365 * 24 * 60 * 60 * 1_000}.${nonce}.invalidsignaturevalueinvalidsignaturevalue`;
    expect(verifySessionToken(forged)).toBe(false);
  });
});
