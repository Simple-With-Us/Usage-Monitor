import crypto from "crypto";

export const SUBSCRIPTION_SOURCE_APP = "subscription";

export function subscriptionChargeIdempotencyKey(
  subscriptionId: string,
  periodStart: Date
): string {
  return crypto
    .createHash("sha256")
    .update(`subscription:${subscriptionId}:${periodStart.toISOString()}`)
    .digest("hex");
}
