# Rollout: rename compose project oracle → usage-monitor

**Date:** 2026-08-06  
**Why:** Container names `oracle-app-1` / `oracle-caddy-1` looked like unrelated
Oracle/Coolify leftovers (and sat next to unmanaged noise like `epic_jackson`).
The app is Usage Monitor; names should say so.

## Changes

| Before | After |
|--------|--------|
| compose project `oracle` | `usage-monitor` |
| `oracle-app-1` | `usage-monitor-app-1` |
| `oracle-caddy-1` | `usage-monitor-caddy-1` |
| network `oracle_internal` | `usage-monitor_internal` |

Files: `deploy/oracle/compose.production.yaml`, `usage-monitor.service`,
`deploy-production.sh` (with rename cutover + legacy retirement),
`auto-deploy.sh`, `replica-status-probe.sh`, tests, ops docs.

Directory `deploy/oracle/` stays (host is still Oracle Cloud Always Free); only
the **Docker compose project / container** names change.

## Cutover

First production deploy after merge:

1. Detects live writer under project `oracle` if not yet renamed.
2. Stops that writer for the usual SQLite cutover.
3. Starts candidate as project **`usage-monitor`**.
4. Removes leftover `oracle` project containers (e.g. old caddy).

Host unit `/etc/systemd/system/usage-monitor.service` is updated when the
installed deploy artifacts are refreshed (same path as other unit/script
updates).

## One-shot tool containers (was `epic_jackson`)

Offline Litestream LTX used to `docker run` **without `--name`**. If the process
was killed before `--rm` cleaned up, Docker left a random name (`epic_jackson`)
visible as Coolify **unmanaged**. All one-shots now use:

`usage-monitor-<kind>-<pid>` via `run_usage_monitor_oneshot`  
(e.g. `usage-monitor-ltx-l4-12345`, `usage-monitor-preflight-12345`).

## Verify

```bash
docker ps --filter name=usage-monitor --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
curl -fsS https://usage.jays.services/api/health
# expect: usage-monitor-app-1 healthy; no oracle-app-1; no random adjective_noun leftovers
```
