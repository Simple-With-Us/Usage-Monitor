# 2026-09-04 — Litestream Product Compaction L1-Only

Board `d784035ed4c24a43a74565323cc8e152`.  Issue #1416.  Branch
`grok/litestream-l1-only`.  Worktree `~/apps/usage-grok-litestream-l1`.

## Context & Objective

Housekeeper already disabled Usage-Monitor L2/L3 live via a volume overlay
plus cron.  Repo `litestream.yml` still omitted `levels:`, so Litestream
`DefaultConfig()` starts L1 (30s) / L2 (5m) / L3 (1h).  The next image bake
would copy that file in and re-enable L2/L3.  Socratic.Trade already bakes
`levels: [{interval: 30s}]` in `litestream.coolify.yml`.

This PR is product config only.  Do not merge from this note.  Do not touch
Coolify live overlays.  Do not bounce services.  Do not mint.  Do not
`--force-ship`.

## Changes Made

- `litestream.yml` — top-level `levels:` with a single YAML-list entry
  `interval: 30s`, placed before `dbs:` like ST.  `Config.Levels`
  `MaxLevel() == 1`, so L2/L3 monitors never start.  Snapshot `24h` /
  `24h`, replica `sync-interval: 1h`, `part-size: 10MB`, and
  `concurrency: 2` stay.  Backup health-check wiring is untouched.
- No Coolify/variant litestream yml exists on main (only `litestream.yml`).
- `docs/litestream.md` — brief L1-only / L2/L3-off note mirroring ST.
- This rollout note.

## Decisions & Trade-offs

**Bake the off switch into the image.**  The live overlay is ops.  The
checked-in file is what the next Coolify bake will run.

**One `levels:` entry, not a longer L2 interval.**  0.5.x can omit L2/L3.
A longer L2 interval would still mega-upload after a stall.  PITR to the
last 24h snapshot plus remaining L0/L1 is enough for this DR-only app.

**Keep backup probes listing 0–3 + 9.**  Leftover replica objects stay
visible.  Listing them is not the same as starting L2/L3 monitors.

## Verification State

- YAML parse: `python3 -c "import yaml; yaml.safe_load(open('litestream.yml'))"`
  confirms a one-item `levels` list with `interval: 30s` before `dbs:`.
- Replica snapshot / part-size / concurrency / sync-interval unchanged.
- No Coolify API, no service bounce, no live overlay edit.

## Next Steps & Blockers

- After this PR is reviewed and merged (not this session): the next image
  bake keeps L1-only without relying on the Housekeeper overlay.
- Do not bounce Coolify from this lane.
