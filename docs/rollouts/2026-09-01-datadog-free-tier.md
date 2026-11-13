# 2026-09-01 — Datadog estimated-usage card (Grok, `grok/datadog-free-tier`)

Usage Monitor watches Datadog as a customer of the API.  It still does not ship its own logs into Datadog.

- Default `DD_ENV` is `production`.  Coolify `prod` canonicalizes.
- Platforms observability probe `datadog` plus dashboard **Datadog Free Usage** card (`/api/datadog-usage`).
- Reads `datadog.estimated_usage.hosts / containers / logs.ingested_events / apm.ingested_spans`.
- Configured only when `DD_API_KEY` and `DD_APP_KEY` are both present.  Hosts > 5 is degraded.
