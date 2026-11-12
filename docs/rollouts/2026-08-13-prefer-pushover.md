# 2026-08-13 — Prefer Pushover over Resend

Owner: Pushover, not email, because Resend costs money.

`readAlertDeliveryConfig` and `deliverProviderAlerts` now drop the email channel whenever Pushover is configured.  Slack, webhook, and PagerDuty are unchanged.  Any remaining email still ends with `(sent by Usage Monitor)`.
