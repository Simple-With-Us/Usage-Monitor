# Render runbook — RETIRED 2026-08-07 (Hetzner/Coolify cutover)

> **DO NOT resume this service.**  Production moved to the Hetzner + Coolify
> + GitHub Actions host on 2026-08-07, after a single-host Oracle VM
> migration in between.  `RETIRED-rollback.md` (in this directory) is the
> pre-Oracle Render-era runbook and is preserved verbatim only as a
> forensic record.  The Rollback section's wording
> "Production runs on the Oracle A1 VM" was inaccurate even when it was
> written (Oracle was already retired by 2026-08-07) — see "Correction"
> below.

## Correction (2026-09-18 health sweep)

The original `RETIRED-rollback.md` says "Production runs on the Oracle A1
VM".  That was already wrong at the time the file was last updated: the
Hetzner/Coolify host has been the sole writer since 2026-08-07.  Production
runs on the Hetzner + Coolify + GitHub Actions stack; see `DEPLOY.md` and
`deploy/README.md` for the canonical current path.  The literal sentence is
left untouched below so the diff against the historical record is preserved;
the canonical-correct statement is the one above.

## What is preserved

- `RETIRED-rollback.md` — the pre-Oracle Render runbook, in full.  Read it as
  history only; every command inside it now references a retired host.

## What is NOT preserved here

Anything new since 2026-08-07 belongs in `deploy/coolify/` (Hetzner) or in
`deploy/README.md` (canonical index).

## Decision authority

Same owner directive as `retired/oracle/RETIRED.md`: the docs hygiene half
of the 2026-09-18 health sweep is satisfied by moving Render-era files
under `retired/` with a banner at every entry point.
