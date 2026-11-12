# 2026-09-13 — Read token cannot mutate alert routing

Boards `154b622e` `e93a83fe`.  Branch `fx/read-token-writes`.

`USAGE_READ_TOKEN` is documented read-only.  `PUT /api/settings` accepted it and wrote `ALERT_*` / Pushover keys into `process.env`.  PUT is now dashboard-session only.  GET still accepts the read token and omits email addresses.  `GET /api/apns/device-tokens` no longer returns the full device token.

Auto-merge workflows: `pull_request` plus same-repo guard on the shared-dependency job.
