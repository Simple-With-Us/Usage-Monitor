# 2026-08-27 — Litestream B2 multipart fix: part-size 10MB + concurrency 2

## Context & Objective

Usage-Monitor's Litestream L1 compaction against Backblaze B2 was wedged in a retry
storm: 119 "compaction failed" errors between 03:34Z and 05:35Z on 2026-08-27 (one every
~61s), each a large multipart upload dying with `read multipart upload data failed ...
checksum mismatch` around part 14 and restarting the whole multipart from scratch.  That
storm — not any app's steady-state sync cadence — is what burned through the Backblaze
daily transaction caps the owner observed.  Socratic.Trade hit the identical failure
class on 2026-08-07 and 2026-08-22 (mega L1→L2 catch-up multiparts dying against B2) and
fixed it with `part-size: 10MB` + `concurrency: 2` in its `litestream.coolify.yml`; that
fix was never ported here.

## Changes Made

- `litestream.yml` — replica block: added `part-size: 10MB` (was the failing 5MB
  default) and raised `concurrency` 1 → 2, with a comment recording the failure
  signature and the ST precedent.

## Decisions & Trade-offs

- Mirrored ST's proven values rather than inventing new ones.  Larger parts cut the
  per-compaction request count (fewer chances for B2's checksum flake, fewer Class C
  transactions); concurrency 2 keeps container memory modest on the shared box.
- Deliberately did NOT change `sync-interval` (1h is already conservative), `snapshot`
  retention, or endpoint addressing (`force-path-style` not needed — L0 sync works).

## Verification State

- YAML-only change; `npm run verify` run per repo gate.
- Post-deploy check (the real proof): tail the usage-monitor container logs and confirm
  no new `compaction failed` / `checksum mismatch` lines plus at least one successful
  `compaction complete level=1` entry, the same way the ST 2026-08-22 unwedge was
  verified.

## Next Steps & Blockers

- After merge + deploy, watch logs for one clean L1 compaction (see above).
- Owner question (cross-fleet): confirm whether ST/CT/UM's three B2 buckets share ONE
  Backblaze account.  If shared, the daily cap is fleet-wide — consider raising it (or
  converting to a generous dollar cap): legitimate ops (e.g. the 2026-08-17 ST restore
  drill, ~10GB download in a day) already exceed free-tier allowances, and a hard cap
  risks silent multi-day backup gaps.
- Congress.Trade's `app/litestream.yml` also lacks `part-size` (concurrency 1) —
  same exposure, port the same pair there.
