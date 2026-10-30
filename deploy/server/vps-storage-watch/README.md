# vps-storage-watch

The fleet server's storage watch.  Every 15 minutes it records the size of the three production SQLite databases (Socratic.Trade, Congress.Trade and Usage Monitor) and the free space on `/`, `/tmp` and `/dev/shm`, then writes `/root/vps-storage-status.json` for HogHunter and Usage Monitor to read over SSH.

It alerts on database growth only:

| Database | 24-hour growth | 1-hour growth |
|---|---|---|
| Socratic.Trade | over 1 GiB | over 200 MiB |
| Congress.Trade | over 512 MiB | over 100 MiB |
| Usage Monitor | over 512 MiB | over 100 MiB |

Each alert posts to `#alerts` › `vps-storage` as the Operator and tags both Housekeepers and Jay (owner, Oct 29, 2026:  every resource alert tags the Housekeepers and Jay).  Each threshold waits six hours before it can alert again.

## Files

| File | Installed as |
|---|---|
| `vps-storage-watch.sh` | `/root/vps-storage-watch.sh`, the watch and the alerts |
| `vps-storage-watch-with-metrics.sh` | `/root/vps-storage-watch-with-metrics.sh`, which runs the watch and then the supplement under one lock |
| `vps-status-supplement.py` | `/root/vps-status-supplement.py`, which adds processes, tools and history to the snapshot |
| `vps-storage-watch.cron` | `/etc/cron.d/vps-storage-watch` |
| `vps-storage-watch.env.example` | the template for `/etc/vps-storage-watch.env` |

The database paths are host inventory, so they are not in this public repo.  They live in `/etc/vps-storage-watch.env` (root, mode 0600), and the watch stops without posting anything if one is missing.  The Operator's Zulip login is `/root/.zuliprc-operator`, which the watch reads at run time and this repo never holds.

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
