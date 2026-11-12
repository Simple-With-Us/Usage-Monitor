import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractNamecheapErrors,
  fetchUsage,
  parseBalancesXml,
  parseDomainsXml,
  validateNamecheapBaseUrl,
} from "../namecheap";
import { redactProviderRawData } from "../../data-privacy";

const SAMPLE_BALANCES_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
  <CommandResponse Type="namecheap.users.getBalances">
    <UserGetBalancesResult Currency="USD" AvailableBalance="48.50" AccountBalance="48.50" EarnedAmount="0.00" WithdrawableAmount="48.50" FundsRequiredForAutoRenew="12.00" />
  </CommandResponse>
  <Server>SERVER-NAME</Server>
  <GMTTimeDifference>--5:00</GMTTimeDifference>
  <ExecutionTime>0.05</ExecutionTime>
</ApiResponse>`;

const SAMPLE_DOMAINS_PAGE1_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getList</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1001" Name="jays.services" User="jaywedgeworth" Created="01/15/2024" Expires="01/15/2027" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" />
      <Domain ID="1002" Name="socratictrade.com" User="jaywedgeworth" Created="02/10/2024" Expires="02/10/2026" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" />
    </DomainGetListResult>
    <Paging>
      <TotalItems>3</TotalItems>
      <CurrentPage>1</CurrentPage>
      <PageSize>2</PageSize>
    </Paging>
  </CommandResponse>
  <Server>SERVER-NAME</Server>
  <GMTTimeDifference>--5:00</GMTTimeDifference>
  <ExecutionTime>0.08</ExecutionTime>
</ApiResponse>`;

const SAMPLE_DOMAINS_PAGE2_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getList</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1003" Name="congress.trade" User="jaywedgeworth" Created="03/12/2024" Expires="03/12/2026" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" />
    </DomainGetListResult>
    <Paging>
      <TotalItems>3</TotalItems>
      <CurrentPage>2</CurrentPage>
      <PageSize>2</PageSize>
    </Paging>
  </CommandResponse>
  <Server>SERVER-NAME</Server>
  <GMTTimeDifference>--5:00</GMTTimeDifference>
  <ExecutionTime>0.08</ExecutionTime>
</ApiResponse>`;

const SAMPLE_ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors>
    <Error Number="1011150">Parameter ApiKey is invalid</Error>
    <Error Number="1011151">Client IP is not whitelisted</Error>
  </Errors>
  <Warnings />
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
  <Server>SERVER-NAME</Server>
</ApiResponse>`;

describe("namecheap adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses balance XML attributes correctly", () => {
    const balances = parseBalancesXml(SAMPLE_BALANCES_XML);
    expect(balances).toEqual({
      currency: "USD",
      availableBalance: 48.5,
      accountBalance: 48.5,
      earnedAmount: 0,
      withdrawableAmount: 48.5,
      fundsRequiredForAutoRenew: 12,
    });
  });

  it("parses domain list XML correctly", () => {
    const { domains, totalItems } = parseDomainsXml(SAMPLE_DOMAINS_PAGE1_XML);
    expect(totalItems).toBe(3);
    expect(domains).toHaveLength(2);
    expect(domains[0]).toMatchObject({
      id: "1001",
      name: "jays.services",
      user: "jaywedgeworth",
      autoRenew: true,
      isExpired: false,
    });
  });

  it("extracts error messages from Namecheap XML responses", () => {
    const errors = extractNamecheapErrors(SAMPLE_ERROR_XML);
    expect(errors).toEqual([
      "Parameter ApiKey is invalid",
      "Client IP is not whitelisted",
    ]);
  });

  it("validates baseUrl strictly to official Namecheap endpoints", () => {
    expect(validateNamecheapBaseUrl()).toBe("https://api.namecheap.com/xml.response");
    expect(validateNamecheapBaseUrl("https://api.sandbox.namecheap.com/xml.response")).toBe(
      "https://api.sandbox.namecheap.com/xml.response"
    );
    expect(() => validateNamecheapBaseUrl("http://api.namecheap.com/xml.response")).toThrow(
      /must use HTTPS/
    );
    expect(() => validateNamecheapBaseUrl("https://www.namecheap.com/xml.response")).toThrow(
      /must be an official Namecheap endpoint/
    );
    expect(() => validateNamecheapBaseUrl("https://malicious-host.com/xml.response")).toThrow(
      /must be an official Namecheap endpoint/
    );
  });

  it("sets retryable on rate limit or 5xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("Too Many Requests", {
            status: 429,
            headers: { "content-type": "text/plain" },
          })
        )
      )
    );

    try {
      await fetchUsage("mock-key", {
        apiUser: "jaywedgeworth",
        clientIp: "99.44.91.248",
      });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("HTTP_ERROR");
      expect(err.status).toBe(429);
    }
  });

  it("requires valid non-loopback client IP", async () => {
    await expect(
      fetchUsage("mock-key", { apiUser: "jaywedgeworth", clientIp: "127.0.0.1" })
    ).rejects.toThrow(/clientIp.*required/);

    await expect(
      fetchUsage("mock-key", { apiUser: "jaywedgeworth", clientIp: "" })
    ).rejects.toThrow(/clientIp.*required/);
  });

  it("rejects XML error envelopes on balance request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("namecheap.users.getBalances")) {
          return Promise.resolve(
            new Response(SAMPLE_ERROR_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        return Promise.resolve(
          new Response(SAMPLE_DOMAINS_PAGE1_XML, {
            status: 200,
            headers: { "content-type": "text/xml" },
          })
        );
      })
    );

    await expect(
      fetchUsage("mock-key", {
        apiUser: "jaywedgeworth",
        clientIp: "99.44.91.248",
      })
    ).rejects.toThrow(/Parameter ApiKey is invalid/);
  });

  it("rejects XML error envelopes on domain list request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("namecheap.users.getBalances")) {
          return Promise.resolve(
            new Response(SAMPLE_BALANCES_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        return Promise.resolve(
          new Response(SAMPLE_ERROR_XML, {
            status: 200,
            headers: { "content-type": "text/xml" },
          })
        );
      })
    );

    await expect(
      fetchUsage("mock-key", {
        apiUser: "jaywedgeworth",
        clientIp: "99.44.91.248",
      })
    ).rejects.toThrow(/Parameter ApiKey is invalid/);
  });

  it("fetches multiple pages of domain inventory across pagination", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        requestedUrls.push(url);
        if (url.includes("namecheap.users.getBalances")) {
          return Promise.resolve(
            new Response(SAMPLE_BALANCES_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        if (url.includes("Page=2")) {
          return Promise.resolve(
            new Response(SAMPLE_DOMAINS_PAGE2_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        if (url.includes("namecheap.domains.getList")) {
          return Promise.resolve(
            new Response(SAMPLE_DOMAINS_PAGE1_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      })
    );

    const result = await fetchUsage("mock-key", {
      apiUser: "jaywedgeworth",
      clientIp: "99.44.91.248",
    });

    expect(result.balance).toBe(48.5);
    expect(result.totalRequests).toBe(3);
    expect(result.credits).toBe(48.5);
    const raw = result.rawData as any;
    expect(raw.domains).toHaveLength(3);
    expect(raw.domains.map((d: any) => d.name)).toEqual([
      "jays.services",
      "socratictrade.com",
      "congress.trade",
    ]);

    // Verify pagination requests
    expect(requestedUrls.some((u) => u.includes("Page=1"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("Page=2"))).toBe(true);
  });

  it("retains Namecheap domain and renewal metadata in redactProviderRawData", () => {
    const rawData = {
      balances: {
        currency: "USD",
        availableBalance: 48.5,
        accountBalance: 48.5,
        earnedAmount: 0,
        withdrawableAmount: 48.5,
        fundsRequiredForAutoRenew: 12,
      },
      domains: [
        { id: "1001", name: "jays.services", autoRenew: true, expires: "01/15/2027" },
      ],
      totalDomains: 1,
      apiUser: "jaywedgeworth",
      unwantedField: "secret",
    };

    const redacted = redactProviderRawData("namecheap", "Namecheap", rawData) as any;
    expect(redacted.balances).toEqual(rawData.balances);
    expect(redacted.domains).toEqual(rawData.domains);
    expect(redacted.totalDomains).toBe(1);
    expect(redacted.apiUser).toBe("jaywedgeworth");
    expect(redacted.unwantedField).toBeUndefined();
  });
});
