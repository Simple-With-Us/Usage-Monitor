# 2026-08-25 — Datadog logs + APM + RUM on Usage Monitor

Existing fleet Datadog account only (US5, `https://us5.datadoghq.com`).  No new
org, no new paid product, no invented secrets in git.

## What was missing

Usage Monitor had Sentry (DSN-gated) and PagerDuty alerts.  It had **no**
Datadog SDK, no `DD_*` parsing, and no RUM.  The host agent on
`fleet-hetzner-nbg1` already ships container logs and host APM (`env:prod`).
App-level traces for `usage-monitor` did not exist.

## What this ships

- Fail-closed env parser (`src/lib/datadog-options.ts`) using the existing
  fleet names from `fleet-ops` (`DD_SERVICE`, `DD_ENV`, `DD_SITE`,
  `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`, `DD_API_KEY` on the agent,
  `NEXT_PUBLIC_DD_*` for RUM).
- Node APM via `dd-trace` in `register()`, plus `--require dd-trace/init`
  from `start-with-litestream.sh` when `DD_SERVICE` is set (Next.js loads
  before `instrumentation.ts`, which otherwise leaves the next plugin dark).
- Production runtime without `DD_SERVICE` refuses to start.  `next build`
  (`NEXT_PHASE=phase-production-build`) does not.  Partial keys always throw.
- Log injection so host-agent container logs correlate with traces.
- RUM + browser logs for the dashboard UI.  Session replay is hard `0`.
  The live org does **not** have RUM enabled — this code stays dark until
  the existing public application id + client token are set.  Do not enable
  RUM from this change.
- `GET /api/datadog-public-config` (public, secret-free except the public
  client token) and CSP `connect-src` for US5 intake.
- `checks.datadog` on `/api/ready` (observability only, never part of `ok`).
- Sentry and PagerDuty are unchanged.  Errors are not swallowed.

## Infisical / Coolify (names only)

Add to the existing `usage-monitor` Infisical project (do not mint new keys
in git):

- `DD_SERVICE=usage-monitor`
- `DD_ENV=prod` (matches the live host-agent tag)
- `DD_SITE=us5.datadoghq.com`
- `DD_AGENT_HOST` — host agent APM receiver as seen from the Coolify
  container (`127.0.0.1` if host-network; otherwise the docker bridge /
  existing `DD_AGENT_HOST`)
- `DD_TRACE_AGENT_PORT=8126`

`DD_API_KEY` stays on the host agent.  Optional RUM public pair:

- `NEXT_PUBLIC_DD_APPLICATION_ID`
- `NEXT_PUBLIC_DD_CLIENT_TOKEN`

Throwaway opt-out: `DD_TRACE_ENABLED=false`.

## Keepouts

No Designer UX.  No Oracle RAG.  No Datadog Platforms card.  No synthetics,
CI Visibility, or session replay.
