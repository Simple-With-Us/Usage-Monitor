import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, isAllowedPineconeIndexHost } from "../pinecone";

describe("Pinecone discovered-host security", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows only Pinecone-controlled service hosts", () => {
    expect(isAllowedPineconeIndexHost("idx-project.svc.us-east-1-aws.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("idx-project.svc.aped-1234.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("pinecone.io.attacker.example")).toBe(false);
    expect(isAllowedPineconeIndexHost("127.0.0.1")).toBe(false);
  });

  it("does not forward the API key to an untrusted discovered host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ indexes: [{ name: "bad", host: "metadata.google.internal" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("secret-key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.rawData)).toContain("outside the allowed");
  });
});
