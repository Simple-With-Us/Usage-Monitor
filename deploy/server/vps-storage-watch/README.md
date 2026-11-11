# vps-storage-watch

The fleet server's storage watch.  Every 15 minutes it records the size of the three production SQLite databases (Socratic.Trade, Congress.Trade and Usage Monitor) and the free space on `/`, `/tmp` and `/dev/shm`, then writes `/root/vps-storage-status.json` for HogHunter and Usage Monitor to read over SSH.

It alerts on database growth only:

| Database | 24-hour growth | 1-hour growth |
|---|---|---|
| Socratic.Trade | over 1 GiB | over 200 MiB |
| Congress.Trade | over 512 MiB | over 100 MiB |
| Usage Monitor | over 512 MiB | over 100 MiB |

Each alert posts to `#Alerts-Log` › `vps-storage` as the Operator and tags both Housekeepers and Jay (owner, Oct 29, 2026:  every resource alert tags the Housekeepers and Jay).  Each threshold waits six hours before it can alert again.  It posts to #Alerts-Log, not #Alerts, because #Alerts holds only the alert ingress's standing status blocks (owner, Oct 29, 2026).

## Files

| File | Installed as |
|---|---|
| `vps-storage-watch.sh` | `/root/vps-storage-watch.sh`, the watch and the alerts |
| `vps-storage-watch.cron` | `/etc/cron.d/vps-storage-watch` |
| `vps-storage-watch.env.example` | the template for `/etc/vps-storage-watch.env` |

The schedule runs `/root/vps-storage-watch-with-metrics.sh`, which holds one lock while it runs this watch and then `/root/vps-status-supplement.py`.  Both of those belong to HogHunter (`scripts/server-status/run-watch.sh` and `supplement.py`), so they are installed from there, never from this repo.

The database paths are host inventory, so they are not in this public repo.  They live in `/etc/vps-storage-watch.env` (root, mode 0600), and `install.sh` refuses to run until all three are set.  If one goes missing later, the watch skips only that database (its snapshot size is `null`, never a made-up zero) and keeps the rest running.  The Operator's Zulip login is `/root/.zuliprc-operator`, which the watch reads at run time and this repo never holds.

## Install

From a checkout of `main` on the server:

```bash
sudo bash deploy/server/vps-storage-watch/install.sh
```

It copies the files above into place, keeps a dated backup of any file it replaces, and refuses to run until `/etc/vps-storage-watch.env` exists.

## Test

```bash
bash deploy/server/vps-storage-watch/test.sh
```

It runs offline against temporary files, with curl replaced by a recorder.  CI runs it in the `verify` job.
