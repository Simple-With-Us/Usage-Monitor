# Oracle A1 deployment — RETIRED 2026-08-07 (Hetzner/Coolify cutover)

> **DO NOT deploy this stack.**  Production moved to the Hetzner + Coolify
> + GitHub Actions host on 2026-08-07.  These files are preserved here only
> for forensic restore of the Oracle lineage and as the historical reference
> for the deploy script + Litestream host patterns.  The Hetzner box runs
> `coolify/usage-monitor-{env-sync,auto-deploy,replica-status}.{service,timer}`
> — those are the live units, **not** the `usage-monitor-auto-deploy.timer`
> referenced by `README.md` below.

## What is preserved

- `README.md` — historical Oracle install + runbook.  Replaced in spirit by `DEPLOY.md`.
- `usage-monitor.service`, `usage-monitor-auto-deploy.{service,timer}` — Oracle systemd units.  These are **not installed on the Hetzner box**.
- `infisical-env-sync.sh` — the reference shell implementation of the env sync.  The Hetzner box runs the same script from `coolify/` (or this one — they are byte-identical).
- `Caddyfile`, `compose.production.yaml`, `compose.yaml` — Oracle-era reverse-proxy + compose configs.  Hetzner runs `coolify/coolify.compose.yaml` instead.
- `replica-status-probe.sh` — the Litestream heartbeat script.  The Hetzner box runs the same script from `coolify/replica-status-probe.sh`.
- `render-retired.production.json`, `render-retired.production.json` — kept for forensic render-suspension proof.

## What is NOT preserved here

Anything new since 2026-08-07 belongs in `deploy/coolify/` (for the Hetzner box) or in `deploy/README.md` (for the canonical index).  If you find yourself editing a file in this directory, stop and ask whether the change belongs on the Hetzner box instead.

## Decision authority

Owner directive, 2026-09-18 (this health sweep): "Ensure this app is working
properly and that all issues on mac board and github issues and effort log
are properly addressed/resolved and all identifiable improvements made."  The
docs hygiene half of that directive is satisfied by moving the Oracle stack
under `retired/` with this banner at every entry point, so the next agent
that runs `git log --oneline` and `grep -r auto-deploy` cannot accidentally
re-enable the Oracle timer.
