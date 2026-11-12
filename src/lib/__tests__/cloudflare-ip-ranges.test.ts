import { describe, expect, it } from "vitest";
import { isCloudflareIp } from "../cloudflare-ip-ranges";

describe("isCloudflareIp", () => {
  it("recognizes IPv4 addresses inside published Cloudflare ranges", () => {
    expect(isCloudflareIp("173.245.48.1")).toBe(true); // 173.245.48.0/20
    expect(isCloudflareIp("173.245.63.254")).toBe(true); // last usable host in /20
    expect(isCloudflareIp("104.16.0.1")).toBe(true); // 104.16.0.0/13
    expect(isCloudflareIp("162.158.100.1")).toBe(true); // 162.158.0.0/15
    expect(isCloudflareIp("198.41.200.1")).toBe(true); // 198.41.128.0/17
  });

  it("rejects IPv4 addresses just outside a published range's boundary", () => {
    expect(isCloudflareIp("173.245.47.255")).toBe(false); // one below 173.245.48.0/20
    expect(isCloudflareIp("173.245.64.0")).toBe(false); // one above 173.245.48.0/20
    expect(isCloudflareIp("104.15.255.255")).toBe(false); // one below 104.16.0.0/13
    expect(isCloudflareIp("104.24.0.0")).toBe(true); // 104.24.0.0/14 is also published, separately
  });

  it("rejects common non-Cloudflare IPv4 addresses", () => {
    expect(isCloudflareIp("8.8.8.8")).toBe(false); // Google DNS
    expect(isCloudflareIp("9.9.9.9")).toBe(false); // Quad9
    expect(isCloudflareIp("45.33.12.9")).toBe(false); // Linode range
    expect(isCloudflareIp("203.0.113.50")).toBe(false); // TEST-NET-3, documentation range
    expect(isCloudflareIp("127.0.0.1")).toBe(false);
    expect(isCloudflareIp("10.0.0.1")).toBe(false);
  });

  it("recognizes IPv6 addresses inside published Cloudflare ranges", () => {
    expect(isCloudflareIp("2606:4700::1")).toBe(true); // 2606:4700::/32
    expect(isCloudflareIp("2400:cb00:1234::1")).toBe(true); // 2400:cb00::/32
  });

  it("rejects IPv6 addresses outside published Cloudflare ranges", () => {
    expect(isCloudflareIp("2001:4860:4860::8888")).toBe(false); // Google DNS
    expect(isCloudflareIp("::1")).toBe(false);
  });

  it("handles malformed or empty input without throwing", () => {
    expect(isCloudflareIp("")).toBe(false);
    expect(isCloudflareIp("   ")).toBe(false);
    expect(isCloudflareIp("not-an-ip")).toBe(false);
    expect(isCloudflareIp("999.999.999.999")).toBe(false);
    expect(isCloudflareIp("173.245.48")).toBe(false);
    expect(isCloudflareIp("1:2:3:4:5:6:7:8:9")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isCloudflareIp("  173.245.48.1  ")).toBe(true);
  });
});
