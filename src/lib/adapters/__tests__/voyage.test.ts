import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../voyage";

describe("Voyage adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never sends a billable inference probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
