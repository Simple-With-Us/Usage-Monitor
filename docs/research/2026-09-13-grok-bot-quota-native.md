# Grok Bot native quota source

The installed `/Applications/Grok Bot.app` bundle identifies as `com.anysphere.sand` (version `0.47.0`).  Its bundled DashboardService protobuf defines `aiserver.v1.GetSandUsageStatusResponse` with `usage_percent`, `current_period_start`, `next_reset_timestamp_utc`, `has_non_zero_included_limit`, `uses_pooled_enterprise_allowance`, and optional `grok_plan_label`.

The first party read is a Connect JSON RPC:

`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus`

It uses the signed in Cursor account bearer token, `Content-Type: application/json`, `Accept: application/json`, `Connect-Protocol-Version: 1`, and body `{}`.  The Dashboard transport also sends `x-cursor-client-type: sand`, `x-cursor-client-version: 0.47.0`, `x-sand-box-namespace: prod`, and `x-ghost-mode: true`; it conditionally adds `x-cursor-checksum` from the local machine ID.  The native reader obtains that token from the exact read only SQLite query `ItemTable.key = cursorAuth/accessToken` in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`.

A bounded live request on 2026-09-13 returned HTTP 200 with the headers above (the optional checksum was omitted) and yielded only these allowlisted fields: `usagePercent=94.715881`, `hasNonZeroIncludedLimit=true`, `currentPeriodStart=2026-09-07T18:35:19.304Z`, and `nextResetTimestampUtc=2026-09-14T18:35:19.304Z`.  This confirms `api2.cursor.sh` for the installed app's production backend; no response body, token, account identifier, or billing detail was retained.

`usagePercent` is the used percentage of Grok Bot's separate weekly included allowance.  The reader reports `100 - usagePercent` as remaining and uses `nextResetTimestampUtc` as the explicit reset.  No absolute cap is exposed by this RPC, so the reader leaves absolute values unavailable.

Cursor's monthly model pools and the `GetCurrentPeriodUsage` response are separate evidence.  The native reader must not derive Grok Bot quota from Cursor model rows, including misleading `grok-bot-*` model breakdowns.  On demand fields and spend limits are billing data and are intentionally omitted.  `usesPooledEnterpriseAllowance=true` is omitted because it is a shared team allowance rather than a personal Grok Bot window.

The Grok Bot app's `sand-secrets.json` is encrypted with Electron `safeStorage`; native code does not attempt to decrypt it.  Root wiring should invoke `GrokBotQuotaReader().read()` alongside the existing readers and retain the `grok-bot` provider key so this weekly window remains distinguishable from the existing xAI/Grok CLI reader and Cursor's monthly usage.

Primary references: [Cursor plans and billing](https://prod.cursor.com/help/grok-bot/plans), [Cursor usage limits](https://prod.cursor.com/help/models-and-usage/usage-limits), and the installed bundle's `dist/electron-main/proto.cjs` / `main-app.cjs`.
