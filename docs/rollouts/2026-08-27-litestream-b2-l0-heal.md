# 2026-08-27 — Litestream B2 L0 corrupt-object heal (retry storm cleared)

## Context & Objective

After #1368 (part-size 10MB + concurrency 2) deployed, the L1-compaction retry storm
against B2 continued unchanged: `compaction failed ... close reader 14: file checksum
mismatch` every ~30-60s, input range pinned at `26848-27dfc`.  The deterministic
"reader 14" proved the failure was not upload flakiness but a **corrupt source
object**: the 14th L0 file (`0000000000026855`) failed its checksum on every read, so
level-1 compaction could never complete, L0 accumulated 5,557 objects (~1.0 GB) over
~2.2 days, and each retry re-read the whole input set from B2 — the traffic that blew
the shared Backblaze daily transaction caps.  Same wedge class Socratic.Trade healed on
2026-08-22.

## Changes Made (ops action — no product code)

- Ran `scripts/litestream-b2-snapshot-boundary-heal.py` (committed here) on
  `fleet-hetzner-nbg1`, credentials read in-process from the live litestream process
  environ (never printed), bucket asserted to `jays-usage-monitor-eu` only.
- Boundary rule: the newest L9 snapshot (`0000000000000001-0000000000027bc7`, 392.9 MB)
  embeds everything up to txid `27bc7`, so every object wholly below that boundary is
  superseded for restore purposes.  Deleted **4,994 objects (~1.0 GB)**: 4,991 L0 files
  plus the three stale pre-wedge singletons at L1/L2/L3 (`2681c-26847`).  Kept the
  566-file L0 suffix `27bc7-27dfc` — verified **zero gaps** before applying — plus the
  snapshot.  Touched nothing else (no L9, no other prefix, no other bucket).

## Decisions & Trade-offs

- PITR points below the snapshot boundary are gone — but they were **already
  unrestorable**: any restore walking the chain would have hit the same corrupt L0
  object.  The heal removed nothing usable.  UM's documented backup philosophy is
  disaster-recovery-only.
- Chose the snapshot-boundary rule over ST's keep-newest-48 heuristic: it is strictly
  safer (supersession is provable from the snapshot's txid range).

## Verification State

- 06:20:32Z: `compaction complete level=1 txid.min=27bc7 txid.max=27dfc size=22149069`.
- Zero `compaction failed` lines after it (previously one every ~30-60s).
- Host scratch files removed after the run.

## Next Steps & Blockers

- The `[replica-status-heartbeat] newest LTX is …s old` alert should clear on its next
  600s tick; if it still reports days-old after an hour, the heartbeat probe is looking
  at the wrong level (separate known probe issues — see the 2026-08-26 replica-status
  fixes).
- Owner (fleet-wide): confirm whether ST/CT/UM B2 buckets share ONE Backblaze account,
  and consider raising the daily cap — this storm burned the shared caps for ~2 days.
- If this recurs: rerun the committed heal script (`--inventory` dry-run first, then
  `--apply`); update the container name constant first.
