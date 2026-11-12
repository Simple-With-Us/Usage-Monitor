import type {
  GeminiBillingStatus,
  GeminiKeyStatus,
} from "@/lib/gemini-key-status";

const GOOGLE_CLOUD_BILLING_SOURCE = "google-cloud-billing-export";
const GOOGLE_GEMINI_RATE_LIMIT_SOURCE = "google-gemini-rate-limits";

/**
 * ProviderExternalBilling rows do not carry the billing-config fingerprint.
 * A successful `ready` sync is authoritative and reconciles the source in the
 * same transaction as its fingerprinted snapshot. Until then, hide only the
 * unbound Google billing rows while preserving unrelated provider records.
 */
export function projectGeminiExternalBillingForClient<
  T extends { source: string },
>(
  records: readonly T[],
  billingStatus: GeminiBillingStatus | null,
  keyStatus: GeminiKeyStatus | null
): T[] {
  if (billingStatus == null && keyStatus == null) {
    return [...records];
  }

  return records.filter((record) => {
    if (
      record.source === GOOGLE_CLOUD_BILLING_SOURCE &&
      billingStatus?.state !== "ready"
    ) {
      return false;
    }
    if (
      record.source === GOOGLE_GEMINI_RATE_LIMIT_SOURCE &&
      keyStatus?.state !== "valid"
    ) {
      return false;
    }
    return true;
  });
}
