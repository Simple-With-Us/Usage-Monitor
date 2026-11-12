import crypto from "crypto";

import { canonicalProviderKey } from "@/lib/provider-identity";

export type ProviderBillingAccountEvidence =
  | "explicit_account"
  | "shared_credential";

export interface ProviderBillingAccountMatch {
  /** Opaque only within one API response; never a credential/account digest. */
  matchKey: string;
  evidence: ProviderBillingAccountEvidence;
}

/** Select the credential that actually authorizes authoritative billing. */
export function authoritativeProviderBillingCredential(input: {
  providerName: string;
  primaryCredential: string | null;
  serverConfig: Record<string, unknown> | null;
}): string | null {
  if (canonicalProviderKey(input.providerName) === "openai") {
    // A null serverConfig means the encrypted config could not be read. We
    // cannot prove that no distinct Admin key exists, so falling back to the
    // operational key would be a money-path guess.
    if (input.serverConfig === null) return null;
    const adminApiKey = input.serverConfig?.adminApiKey;
    if (typeof adminApiKey === "string" && adminApiKey.trim()) {
      return adminApiKey.trim();
    }
  }
  return input.primaryCredential;
}

const STORED_IDENTITY_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;

function identityKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return Buffer.from(value, "hex");
}

function keyedIdentity(
  namespace: "explicit-account" | "credential",
  providerName: string,
  value: string
): string {
  const provider = canonicalProviderKey(providerName);
  const digest = crypto
    .createHmac("sha256", identityKey())
    .update("usage-monitor-provider-billing-account\0")
    .update(namespace)
    .update("\0")
    .update(provider)
    .update("\0")
    .update(value)
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

/** Hash an operator-confirmed provider account/org identifier before storage. */
export function hashProviderBillingAccountId(
  providerName: string,
  accountId: string
): string {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("billingAccountId cannot be empty");
  return keyedIdentity("explicit-account", providerName, normalized);
}

function internalIdentity(input: {
  providerName: string;
  storedExplicitIdentity: string | null;
  decryptedCredential: string | null;
}): { identity: string; evidence: ProviderBillingAccountEvidence } | null {
  if (input.storedExplicitIdentity != null) {
    // Configured-but-malformed identity is evidence corruption, not absence.
    // Never fall back to a credential and silently change account semantics.
    if (!STORED_IDENTITY_PATTERN.test(input.storedExplicitIdentity)) return null;
    return {
      identity: input.storedExplicitIdentity,
      evidence: "explicit_account",
    };
  }
  if (input.decryptedCredential) {
    return {
      identity: keyedIdentity(
        "credential",
        input.providerName,
        input.decryptedCredential
      ),
      evidence: "shared_credential",
    };
  }
  return null;
}

/**
 * Project secret-bearing account evidence into response-local opaque keys.
 * Equal credentials prove that two rows use the same credential/account view;
 * unequal credentials deliberately do not prove distinct accounts.
 */
export function projectProviderBillingAccountMatches(
  providers: Array<{
    id: string;
    name: string;
    billingAccountIdentity: string | null;
    decryptedCredential: string | null;
  }>
): Map<string, ProviderBillingAccountMatch | null> {
  const internalByProvider = new Map<
    string,
    { identity: string; evidence: ProviderBillingAccountEvidence } | null
  >();
  for (const provider of providers) {
    internalByProvider.set(
      provider.id,
      internalIdentity({
        providerName: provider.name,
        storedExplicitIdentity: provider.billingAccountIdentity,
        decryptedCredential: provider.decryptedCredential,
      })
    );
  }

  const opaqueByIdentity = new Map<string, string>();
  for (const value of internalByProvider.values()) {
    if (value && !opaqueByIdentity.has(value.identity)) {
      // Deliberately response-local. A stable public pseudonym would become a
      // cross-response account tracking identifier even though it is not the
      // stored HMAC itself.
      opaqueByIdentity.set(value.identity, `billing-account-${crypto.randomUUID()}`);
    }
  }

  return new Map(
    [...internalByProvider.entries()].map(([providerId, value]) => [
      providerId,
      value
        ? {
            matchKey: opaqueByIdentity.get(value.identity)!,
            evidence: value.evidence,
          }
        : null,
    ])
  );
}
