import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage as fetchAlphaVantage } from "../alphavantage";
import { fetchUsage as fetchFinnhub } from "../finnhub";
import { fetchUsage as fetchFmp } from "../fmp";
import { fetchUsage as fetchFred } from "../fred";
import { fetchUsage as fetchMarketstack } from "../marketstack";
import { fetchUsage as fetchMassive } from "../massive";
import { fetchUsage as fetchTiingo } from "../tiingo";

describe("blind provider adapters", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never consumes a billable/quota-bearing data request to observe billing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapters = [
      fetchAlphaVantage,
      fetchFinnhub,
      fetchFmp,
      fetchFred,
      fetchMarketstack,
      fetchMassive,
      fetchTiingo,
    ];

    const results = await Promise.allSettled(
      adapters.map((adapter) => adapter("key"))
    );

    expect(fetchMock).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "UNSUPPORTED" });
      }
    }
  });
});
