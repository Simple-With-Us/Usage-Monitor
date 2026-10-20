# CodeCaps Remote Push

Usage Monitor owns the APNs sender, but CodeCaps devices and alerts have a separate table, topic, and contract.  The CodeCaps rows never enter the existing `ApnsDeviceToken` channel, which remains scoped to Usage Monitor alerts.

## Configuration

Add `CODECAPS_PUSH_REGISTRATION_TOKEN` to the Usage Monitor `prod` environment at the Infisical project root, then let the existing env sync deliver it to the server.  This credential must be supplied to the owner through the CodeCaps Settings secure field and stored in Keychain; never compile it into the app, use `USAGE_READ_TOKEN`, or use it as the alert producer credential.

The existing `APNS_KEY_ID`, `APNS_TEAM_ID`, and `.p8` key must be present in the same environment.  The APNs key must authorize the `com.simplewithus.codecaps.ios` topic.  CodeCaps uses that topic explicitly; the existing `APNS_BUNDLE_ID` and Usage Monitor topic behavior remain unchanged.

The CodeCaps iOS target also needs its APNs capability and matching provisioning profile before remote registration can succeed.  Until the secret sync, APNs topic authorization, schema push, and signed app profile are in place, these endpoints return `503` when server-side registration or delivery configuration is absent, or APNs registration fails on device.

## Device Registration

`POST /api/codecaps/push/devices` registers or updates one installation.  `DELETE` on the same path deactivates that installation.  Both require `Authorization: Bearer <CODECAPS_PUSH_REGISTRATION_TOKEN>`; read and ingest tokens are rejected.

The strict registration body is:

```json
{
  "installationId": "stable UUID",
  "generation": 1,
  "deviceToken": "64 to 512 hexadecimal characters",
  "environment": "sandbox or production",
  "preferences": {
    "options": {
      "anomaly": { "enabled": true, "notification": true, "popup": true, "sound": "system.default" },
      "runaway": { "enabled": true, "notification": true, "popup": true, "sound": "Glass" },
      "vendorReset": { "enabled": true, "notification": true, "popup": true, "sound": "Submarine" },
      "quotaReset": { "enabled": true, "notification": true, "popup": true, "sound": "Frog" },
      "quotaExhaustion": { "enabled": true, "notification": true, "popup": true, "sound": "silent" }
    }
  }
}
```

The token table is separate from Usage Monitor's token table and keyed by the stable installation UUID.  The raw device token is not returned.  The client increments and persists `generation` before every registration or removal request; the server atomically applies only a newer generation, or an equal generation when replaying an active registration/removal.  DELETE creates an inactive tombstone even when it arrives before the first POST, so a delayed older or same-generation POST cannot re-enroll the installation.  Removal clears the token but retains the tombstone and alert receipt history.  Registration requires both the dedicated registration token and a complete APNs provider configuration; otherwise it returns `503` without storing the device.

## Alert Ingest

`POST /api/codecaps/push/alerts` uses the existing usage-ingest credential.  A scoped token must be authorized for producer `codecaps`; an unscoped token follows the existing `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` policy.  The strict request is `{ "alerts": [ ... ] }` with up to 50 entries, each containing `id`, `kind`, `providerKey`, `providerTitle`, `windowLabel`, `summary`, and ISO-8601 `occurredAt`.

Accepted kinds are `anomaly`, `runaway`, `vendorReset`, `quotaReset`, and `quotaExhaustion`.  The server rejects observations older than 15 minutes or more than one minute in the future.  The stable alert ID is the durable deduplication key; duplicate posts do not create another occurrence.  A repeated ID must match its original payload and can retry only pending, retryable, or APNs-authentication-failed device receipts, with a three-attempt limit and an atomic five-minute send lease.  Retryable and APNs-authentication failures return `503` so the producer retries; successful receipts are never resent.  Receipt rows and per-device outcomes are retained for 30 days, then pruned on a later alert ingest.

Delivery requires both `enabled` and `notification` for the alert kind.  `sound` maps `system.default` to APNs default, named sounds to the matching bundled `alarm-*.wav`, and `silent` to an omitted `aps.sound`.  `popup` controls Mac windows and does not mute iPhone notifications.  APNs uses ordinary active alerts so the selected sound remains eligible to play; iOS still applies the user's system notification settings.  [Apple documents passive alerts as silent](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/passive).

Each delivered alert carries `alertId`, `kind`, `providerKey`, and the Overview tab route data.  Dead APNs device tokens are deactivated.  Before claiming each send, the server re-reads current device activity, token, and preferences so queued sends respect a recent disable or preference change.  Dead-token cleanup compares the captured token and registration generation to avoid deactivating a newly rotated token.  Delivery failures are recorded per alert and installation and are returned as counts only; device tokens and APNs error bodies are not returned.

## Database Application

The schema adds only the `CodeCapsPushDevice`, `CodeCapsPushAlert`, and `CodeCapsPushAlertDelivery` tables.  Production applies additive schema changes through the existing guarded `migrate-safe` / `prisma db push --skip-generate` deployment path; no live database or credentials were accessed while implementing this contract.
