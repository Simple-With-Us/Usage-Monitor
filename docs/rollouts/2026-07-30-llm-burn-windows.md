# 2026-07-30 — LLM burn windows (ccusage blocks, generalized to all platforms)

Owner directive: take the deferred ccusage 5-hour billing-block follow-up from
`2026-07-29-open-source-lessons.md` (item 3) and "do so for all llm platforms
and not just claude."

## What shipped

- **`src/lib/llm-burn.ts`** — pure report builder (rows in, report out, no
  I/O). Per provider:
  - **Trailing-window burn** (default 5h — ccusage's block length — clamped
    to 1–24h): typed token totals (input/output/cacheRead/cacheCreation/
    unknown), derived cost = tokens × bundled LiteLLM catalog, reported cost
    = producer cost events + usage events carrying `costUsd`.
  - **Burn rate**: window totals ÷ elapsed activity (first window event →
    now), clamped to ≥ 15 min so one fresh event can't read as an absurd
    hourly rate, and ≤ the window length so idle time decays the rate.
  - **Budget pace**: month-to-date estimate vs
    `ProviderPlan.monthlyBudgetUsd` prorated to the elapsed UTC-month
    fraction (`paceRatio` 1.0 = exactly on pace; chips on-pace / watch ≥
    1.0 / over-pace ≥ 1.1) plus a **linear month-end projection**, withheld
    in the first ~2% of a month where the tiny denominator makes it noise.
  - **Quiet providers**: MTD estimate > 0 but no window activity — listed in
    the card footer instead of hidden.
- **`GET /api/llm-burn?hours=5`** — dashboard-session gated (no middleware
  exclusion; owner read, not a producer endpoint). All aggregation in SQLite
  via six bounded `groupBy`s (provider × model × token-type cardinality,
  never raw rows — the budget-status OOM lesson). Budgets come from
  `Provider.name` + `plan.monthlyBudgetUsd`, matched case-insensitively in
  JS (Prisma `mode:"insensitive"` is Postgres-only; SQLite here).
- **`src/components/LlmBurnCard.tsx`** — dashboard card in the Portfolio
  detail section above `ClaudeCostCheckCard`. Per-provider rows: window
  tokens, window est. cost, burn/hr ($ and tokens), MTD est., pace chip +
  projected-vs-budget line. Refreshes every 2 minutes (rates are
  time-sensitive); renders nothing without LLM telemetry.
- **Tests**: `src/lib/__tests__/llm-burn.test.ts` — 15 tests over UTC month
  boundaries, label→token-type extraction, per-platform pricing (Anthropic,
  OpenAI prefix-stripped, DeepSeek floor), recorded-wins max(), rate clamps,
  unpriced/unknown-type incomplete flags, pace bands, early-month projection
  withholding, active/quiet partitioning, defensive non-positive skips.

## Design decisions (and why)

- **Generalization of the 5-hour block.** Claude's subscription block is one
  instance of "how fast am I burning right now, and what does that pace
  imply?" We have no per-plan window-limit config for non-Claude platforms,
  so a *trailing* window answers the universal question honestly for every
  provider instead of faking block semantics only Anthropic actually bills
  by. The window defaults to 5h so Claude users still get ccusage's exact
  frame.
- **Data-driven provider set.** Any provider with token-unit usage events or
  cost events participates — claude-code OTLP (anthropic), generic pushed
  telemetry (openai, xai, deepseek, gemini, …), and anything future
  producers add. No provider allowlist to rot.
- **Recorded-wins cost basis** (`estimate = max(reported, derived)`),
  ccusage's ordering, so the two signals never double count. Unknown token
  types (generic producers without `token:<type>` labels) price at the
  model's input rate as a floor and flag the row derivation-incomplete —
  same never-over-estimate contract as `derive-ingest-cost.ts`.
- **Analytics-only, again.** Both cost figures are API-equivalent estimates.
  Cash spend still comes from receipts/subscriptions/poll snapshots
  (`budget-status.ts`); nothing here feeds budget math, alerts, or the
  pushed-cash pool. The card says so in its footer.

## Verify

- `npx vitest run src/lib/__tests__/llm-burn.test.ts` — 15/15.
- `npx tsc --noEmit`, `npx eslint` on touched files — clean.
- Full sharded vitest + hosted verify/CodeQL/gitleaks on the PR.
