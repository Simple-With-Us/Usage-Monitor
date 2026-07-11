import { describe, expect, it } from "vitest";
import { BoundedLogOnce } from "../bounded-log-once";

describe("BoundedLogOnce", () => {
  it("suppresses repeats while evicting the oldest key at capacity", () => {
    const cache = new BoundedLogOnce(2);

    expect(cache.remember("first")).toBe(true);
    expect(cache.remember("second")).toBe(true);
    expect(cache.remember("first")).toBe(false);
    expect(cache.size).toBe(2);

    expect(cache.remember("third")).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.remember("first")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("rejects invalid capacities", () => {
    expect(() => new BoundedLogOnce(0)).toThrow(/positive safe integer/);
    expect(() => new BoundedLogOnce(Number.POSITIVE_INFINITY)).toThrow(
      /positive safe integer/
    );
  });
});
