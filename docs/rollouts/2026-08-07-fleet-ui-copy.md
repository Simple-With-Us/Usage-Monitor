# 2026-08-07 — Fleet UI copy conventions (Usage Monitor)

## Objective
Adopt fleet-wide owner copy rules (see `docs/FLEET-UI-COPY.md`).

## Changes
- `NOT_REPORTED` / CostCoverageLegend: **not reported** (value casing).
- iOS `CurrencyFormat.compactUSD`: `$1.2k` / `$3.4m` / `$1.1b` (lowercase).
- `formatCompactNumber` post-processes Intl compact to lowercase KMB.
- Local iOS: force `.navigationBarTitleDisplayMode(.inline)` on remaining roots; Title Case section labels.
- AGENTS.md points at fleet copy canon.
