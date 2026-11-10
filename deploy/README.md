# Deploy directory index

> **Owner:** CURSOR — health sweep 2026-09-18.  This index is the canonical
> entry point for everything under `deploy/`.  Earlier revisions of `DEPLOY.md`
> and `deploy/oracle/README.md` pointed at a "live" Oracle auto-deploy timer
> that has not been the live writer since the **Hetzner / Coolify cutover on
> 2026-08-07**; the two `retired/` subdirs are the only source of truth for
> the Oracle and Render eras.

## Live production (Hetzner + Coolify + GitHub Actions)

| Concern | Where it lives | Note |
|---|---|---|
| Canonical runbook | [`../DEPLOY.md`](../DEPLOY.md) | Sole-source-of-truth runbook for the Hetzner box. |
| Fleet ops map | `/Users/jay/apps/COOLIFY.md` and the private `jaywedgeworth22/fleet-ops:ATTACK-MAP.md` | Host IP, Tailscale mesh, container UUIDs. |
| Litestream replica heartbeat | [`coolify/usage-monitor-replica-status.{service,timer}`](coolify/) | Installed on the Hetzner box, not Oracle. |
| Deploy gate | GitHub Actions `verify` + `gitleaks` + `Analyze JavaScript and TypeScript` (`.github/workflows/ci.yml`) | Replaces the Oracle auto-deploy timer — there is **no per-minute GitHub poller** on Hetzner; Coolify + GitHub App auto-deploy does the merge-and-restart. |
| Infisical env sync | Installed on the Hetzner box from `coolify/usage-monitor-env-sync.{service,timer}` (added in this PR — see PR description) | Oracle's `deploy/oracle/infisical-env-sync.sh` script is the reference implementation, not the live binary on the Hetzner box. |

## Retired stacks (history only, do NOT redeploy)

| Dir | Era | Why retired | Status |
|---|---|---|---|
| `retired/oracle/` | 2024 - 2026-08-07 | Sole writer migrated to Hetzner/Coolify.  Oracle VM is preserved only for forensic restore; do not start the writer, do not re-enable the timer. | **Retained for forensics.**  Top-level banner warns on every entry point. |
| `retired/render/` | Pre-Oracle Render Blueprint era | Suspended Render service kept only as a fallback.  Do not resume — its SQLite lineage is stale the moment Hetzner is the sole writer. | **Retained as rollback host only.**  Top-level banner warns on every entry point. |
| `retired/garage/` | Hetzner/Coolify self-hosted S3 attempt (PR #869) | Replaced by Backblaze B2 (`jays-usage-monitor-eu`) + Cloudflare R2 weekly archive.  The compose file in that dir was **deployable as-is with `GARAGE_ALLOW_WORLD_READABLE_SECRETS=true`** — moved here 2026-09-18 to prevent the next ops sweep from accidentally `docker compose up`ing it. | **Retired + de-armed.**  The dangerous secret flag is gone; the file is here only so the diff against PR #869 is preserved. |

## What changed in this health sweep

- **`deploy/coolify/garage.compose.yaml` → `deploy/retired/garage/garage.compose.yaml`** with the
  `GARAGE_ALLOW_WORLD_READABLE_SECRETS=true` line removed (the de-armed copy is
  the only reference; the file no longer starts as-is, even by accident).
- **`deploy/oracle/` → `deploy/retired/oracle/`** with a `RETIRED.md` banner at
  the entry of every file that points operators at `systemctl enable
  usage-monitor-auto-deploy.timer`.  That timer is not the live deploy path.
- **`deploy/render/` → `deploy/retired/render/`** with a `RETIRED.md` banner
  and the inaccurate "Production runs on the Oracle A1 VM" sentence corrected
  to "Production runs on the **Hetzner + Coolify + GitHub Actions** stack".
- **`DEPLOY.md` invariant #4** rewritten to describe the Coolify + GitHub
  Actions auto-deploy path; the Oracle auto-deploy timer is now a single
  reference line in the "Live production" table above.
- **`DEPLOY.md` "Runtime env: Infisical is the source of truth"** updated to
  point at the **Hetzner-installed** sync binary, not `deploy/oracle/`.
- **`docs/litestream.md` "Backup monitoring"** link now points at
  `/Users/jay/apps/fleet-sentry-monitor/monitor.py` only — the Oracle
  mid-section is no longer referenced as a source of operational truth.

## Operator checklist

Before anyone touches anything under `deploy/`:

1. Confirm which stack is **live** via `curl -fsS https://usage.jays.services/api/health | jq .revision` — the revision must be a recent `origin/main` SHA on a Hetzner container.
2. Open `DEPLOY.md` first.  Anything it tells you to run that lives under `deploy/retired/` is wrong; that file's banner explains the alternative.
3. Never `docker compose up` anything under `deploy/retired/garage/` — even the de-armed copy is missing the `garage.toml` it expects, so it will fail closed; the secret-flag removal is the real fix.
