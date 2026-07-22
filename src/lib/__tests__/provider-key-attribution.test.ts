import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  displayProviderKeyFingerprint,
  fingerprintProviderReportedKeyId,
  parseAttributionDate,
  resolveProviderKeyAttribution,
  type AttributionBinding,
  type AttributionIdentity,
} from "@/lib/provider-key-attribution";

const ORIGINAL_HMAC_KEY = process.env.ATTRIBUTION_IDENTITY_HMAC_KEY;
const ORIGINAL_PREVIOUS_HMAC_KEYS = process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS;
const identities: AttributionIdentity[] = [
  {
    id: "identity-a",
    providerId: "provider-a",
    providerName: "openai",
    status: "active",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    retiredAt: null,
    providerReportedKeyIdFingerprint: null,
  },
  {
    id: "identity-b",
    providerId: "provider-a",
    providerName: "openai",
    status: "active",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    retiredAt: null,
    providerReportedKeyIdFingerprint: null,
  },
];

function binding(overrides: Partial<AttributionBinding> = {}): AttributionBinding {
  return {
    id: "binding-a",
    identityId: "identity-a",
    projectId: "project-a",
    projectName: "Congress.Trade",
    producerId: "congress-trade",
    producerKeyRef: "configured-openai-primary",
    providerConnectionRef: "openai-org-primary",
    billingAccountRef: "openai-billing-primary",
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    providerName: "openai",
    producerId: "congress-trade",
    producerKeyRef: "configured-openai-primary",
    providerConnectionRef: "openai-org-primary",
    billingAccountRef: "openai-billing-primary",
    occurredAt: new Date("2026-07-22T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = "test-attribution-key-material-longer-than-32-characters";
});

afterEach(() => {
  if (ORIGINAL_HMAC_KEY == null) delete process.env.ATTRIBUTION_IDENTITY_HMAC_KEY;
  else process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = ORIGINAL_HMAC_KEY;
  if (ORIGINAL_PREVIOUS_HMAC_KEYS == null) {
    delete process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS;
  } else {
    process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS = ORIGINAL_PREVIOUS_HMAC_KEYS;
  }
});

describe("provider key identity fingerprints", () => {
  it("is deterministic, provider-scoped, and never exposes the raw opaque ID", () => {
    const raw = "key_provider_opaque_123";
    const first = fingerprintProviderReportedKeyId("provider-a", raw);
    expect(first).toBe(fingerprintProviderReportedKeyId("provider-a", raw));
    expect(first).not.toBe(fingerprintProviderReportedKeyId("provider-b", raw));
    expect(first).not.toContain(raw);
    expect(displayProviderKeyFingerprint(first)).toMatch(/^hmac:[a-f0-9]{12}$/);
  });

  it("keeps old fingerprints resolvable while an HMAC key is rotated", () => {
    const raw = "provider-key-id-before-rotation";
    const oldKey = "old-attribution-key-material-longer-than-32-characters";
    const newKey = "new-attribution-key-material-longer-than-32-characters";
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = oldKey;
    const oldFingerprint = fingerprintProviderReportedKeyId("provider-a", raw);
    process.env.ATTRIBUTION_IDENTITY_HMAC_KEY = newKey;
    process.env.ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS = oldKey;
    const result = resolveProviderKeyAttribution(
      observation({ producerKeyRef: null, providerReportedKeyId: raw }),
      [{ ...identities[0], providerReportedKeyIdFingerprint: oldFingerprint }],
      []
    );
    expect(result).toMatchObject({ status: "matched", identityId: "identity-a" });
  });
});

describe("resolveProviderKeyAttribution", () => {
  it("matches only an exact effective producer binding and returns its project", () => {
    expect(resolveProviderKeyAttribution(observation(), identities, [binding()])).toEqual({
      status: "matched",
      identityId: "identity-a",
      bindingId: "binding-a",
      projectId: "project-a",
      projectName: "Congress.Trade",
      matchedBy: "producer_key_ref",
    });
  });

  it("keeps similar labels and wrong provider context explicitly unattributed", () => {
    expect(
      resolveProviderKeyAttribution(
        observation({ producerKeyRef: "configured-openai-primary-copy" }),
        identities,
        [binding()]
      )
    ).toEqual({ status: "unattributed", reason: "no_effective_binding" });
    expect(
      resolveProviderKeyAttribution(
        observation({ providerConnectionRef: "another-org" }),
        identities,
        [binding()]
      )
    ).toEqual({ status: "unattributed", reason: "no_effective_binding" });
  });

  it("uses half-open effective periods without rewriting historical attribution", () => {
    const cutoff = new Date("2026-07-15T00:00:00.000Z");
    const oldBinding = binding({ effectiveTo: cutoff });
    const newBinding = binding({
      id: "binding-b",
      identityId: "identity-b",
      projectId: "project-b",
      effectiveFrom: cutoff,
    });
    expect(
      resolveProviderKeyAttribution(
        observation({ occurredAt: new Date("2026-07-14T23:59:59.999Z") }),
        identities,
        [oldBinding, newBinding]
      )
    ).toMatchObject({ identityId: "identity-a", projectId: "project-a" });
    expect(
      resolveProviderKeyAttribution(observation({ occurredAt: cutoff }), identities, [oldBinding, newBinding])
    ).toMatchObject({ identityId: "identity-b", projectId: "project-b" });
  });

  it("keeps pre-retirement history matched while refusing post-retirement attribution", () => {
    const retiredAt = new Date("2026-07-20T00:00:00.000Z");
    const retiredIdentities = identities.map((identity, index) =>
      index === 0 ? { ...identity, status: "retired", retiredAt } : identity
    );
    expect(
      resolveProviderKeyAttribution(
        observation({ occurredAt: new Date("2026-07-19T00:00:00.000Z") }),
        retiredIdentities,
        [binding()]
      )
    ).toMatchObject({ status: "matched", identityId: "identity-a" });
    expect(
      resolveProviderKeyAttribution(
        observation({ occurredAt: new Date("2026-07-21T00:00:00.000Z") }),
        retiredIdentities,
        [binding()]
      )
    ).toEqual({ status: "unattributed", reason: "no_effective_binding" });
  });

  it("fails open to unattributed when bindings are ambiguous", () => {
    expect(
      resolveProviderKeyAttribution(observation(), identities, [
        binding(),
        binding({ id: "binding-b", identityId: "identity-b", providerConnectionRef: null }),
      ])
    ).toEqual({ status: "unattributed", reason: "ambiguous_binding" });
  });

  it("matches an exact provider-reported opaque ID and rejects an unknown one", () => {
    const providerReportedKeyId = "provider-key-id-a";
    const withFingerprint = identities.map((identity, index) => ({
      ...identity,
      providerReportedKeyIdFingerprint:
        index === 0
          ? fingerprintProviderReportedKeyId(identity.providerId, providerReportedKeyId)
          : identity.providerReportedKeyIdFingerprint,
    }));
    expect(
      resolveProviderKeyAttribution(
        observation({ producerKeyRef: null, providerReportedKeyId }),
        withFingerprint,
        []
      )
    ).toMatchObject({ status: "matched", identityId: "identity-a", matchedBy: "provider_reported_key_id" });
    expect(
      resolveProviderKeyAttribution(
        observation({ producerKeyRef: providerReportedKeyId }),
        withFingerprint,
        []
      )
    ).toEqual({ status: "unattributed", reason: "no_effective_binding" });
    expect(
      resolveProviderKeyAttribution(
        observation({ producerKeyRef: null, providerReportedKeyId: "unknown" }),
        withFingerprint,
        []
      )
    ).toEqual({ status: "unattributed", reason: "unknown_provider_key" });
  });

  it("does not retroactively match a provider ID before the identity was registered", () => {
    const providerReportedKeyId = "provider-key-id-a";
    const withFingerprint = identities.map((identity, index) => ({
      ...identity,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      providerReportedKeyIdFingerprint:
        index === 0
          ? fingerprintProviderReportedKeyId(identity.providerId, providerReportedKeyId)
          : identity.providerReportedKeyIdFingerprint,
    }));
    expect(
      resolveProviderKeyAttribution(
        observation({
          producerKeyRef: null,
          providerReportedKeyId,
          occurredAt: new Date("2026-07-14T23:59:59.999Z"),
        }),
        withFingerprint,
        []
      )
    ).toEqual({ status: "unattributed", reason: "unknown_provider_key" });
  });

  it("requires timezone-qualified ISO effective dates", () => {
    expect(() => parseAttributionDate("July 22, 2026", "effectiveFrom")).toThrow(
      "effectiveFrom must be an ISO date-time with a timezone"
    );
    expect(parseAttributionDate("2026-07-22T12:00:00-05:00", "effectiveFrom").toISOString()).toBe(
      "2026-07-22T17:00:00.000Z"
    );
  });
});
