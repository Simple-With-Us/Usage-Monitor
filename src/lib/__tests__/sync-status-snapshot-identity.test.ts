import { beforeEach, describe, expect, it } from "vitest";

import { hashProviderBillingAccountId } from "@/lib/provider-billing-account";
import { resolveStatusSnapshotProvider } from "@/lib/external-usage-events";

describe("resolveStatusSnapshotProvider", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "11".repeat(32);
  });

  const openaiA = {
    id: "prov-a",
    name: "OpenAI",
    groupId: "key-a",
    billingAccountIdentity: null as string | null,
  };
  const openaiB = {
    id: "prov-b",
    name: "openai",
    groupId: "key-b",
    billingAccountIdentity: null as string | null,
  };

  it("prefers keyRef over ambiguous same-name providers", () => {
    const matched = resolveStatusSnapshotProvider(
      { provider: "openai", keyRef: "key-b" },
      [openaiA, openaiB]
    );
    expect(matched?.id).toBe("prov-b");
  });

  it("matches billing account identity when keyRef is absent", () => {
    const accountId = "org_exact_primary";
    const identity = hashProviderBillingAccountId("OpenAI", accountId);
    const providers = [
      { ...openaiA, billingAccountIdentity: identity },
      { ...openaiB, billingAccountIdentity: hashProviderBillingAccountId("openai", "org_other") },
    ];
    const matched = resolveStatusSnapshotProvider(
      {
        provider: "openai",
        metadata: { _billingAccountRef: accountId },
      },
      providers
    );
    expect(matched?.id).toBe("prov-a");
  });

  it("fails closed when duplicate names lack keyRef and billing identity", () => {
    const matched = resolveStatusSnapshotProvider(
      { provider: "openai" },
      [openaiA, openaiB]
    );
    expect(matched).toBeNull();
  });

  it("allows unique name match when only one provider exists", () => {
    const matched = resolveStatusSnapshotProvider(
      { provider: "OpenAI" },
      [openaiA]
    );
    expect(matched?.id).toBe("prov-a");
  });

  it("allows unique canonical alias when names differ but map to one row", () => {
    const matched = resolveStatusSnapshotProvider(
      { provider: "claude" },
      [
        {
          id: "anth",
          name: "Anthropic",
          groupId: null,
          billingAccountIdentity: null,
        },
      ]
    );
    expect(matched?.id).toBe("anth");
  });
});
