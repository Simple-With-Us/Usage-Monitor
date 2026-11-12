# Open-source lessons applied — 2026-07-29

Survey of open-source repos adjacent to Usage Monitor (LLM cost tracking,
usage metering/billing, OTLP ingestion, retention rollups, subscription
tracking), what we compared against, and what we adopted. Repo facts (stars,
activity, licenses) verified live on GitHub on 2026-07-29.

## Adopted in this change

### 1. LiteLLM pricing catalog (BerriAI/litellm, 55k★)

**Lesson:** don't hand-maintain model pricing; consume a community-maintained
catalog — but bundle it, never fetch it at runtime.

**Implemented:**
- `scripts/update-model-pricing.mjs` (`npm run pricing:update`) — fetches
  LiteLLM's `model_prices_and_context_window.json`, keeps only the cost fields
  we read, canary-checks known models (`claude-sonnet-4-5`, `gpt-4o`) so an
  upstream format change fails loudly, and writes a provenance-stamped
  snapshot (source URL, fetch time, upstream sha256).
- `src/lib/pricing/model-pricing.snapshot.json` — bundled catalog (~2,500
  priced models). Pricing changes land as reviewable diffs.
- `src/lib/pricing/model-pricing.ts` — deterministic lookup (exact →
  lowercased → progressive provider-prefix stripping → bounded longest-prefix
  fuzzy for date/alias suffixes) plus `deriveTokenCostUsd` covering all four
  Claude token types (input/output/cacheRead/cacheCreation), with a
  `complete` flag when a present token type has no catalog rate so a partial
  derivation is never mistaken for a full one. `>200k`-context premium tiers
  are supported via an explicit opt-in flag; OTLP points don't carry context
  size, so the default is base rates (same caveat ccusage documents).

### 2. ccusage comparison + cost cross-check (ccusage/ccusage, 17.5k★)

**Their cost model** (verified against repo docs/code): prefer recorded
actual cost, then recorded estimated cost, then derive from token counts ×
LiteLLM pricing; unknown model ⇒ $0.00; pricing is a *locked* LiteLLM
snapshot refreshed explicitly; provider-prefixed model-name candidates;
cache-token accounting; reasoning tokens priced as output.

**Our model before this change:** we ingested Claude Code's own
`claude_code.cost.usage` OTLP metric and trusted it as the only
API-equivalent estimate. No independent derivation existed, so a Claude Code
cost bug, a pricing change, or an unpriced new model would silently distort
every analytics number downstream.

**Gap closed:**
- `src/lib/claude-cost-check.ts` — pure aggregation that re-derives
  API-equivalent cost from the already-ingested `token.usage` rows (model ×
  token type × catalog price) and diffs it per-model against the summed
  `cost.usage` estimate. Derivation happens at **read time**, so it works
  retroactively on all historical rows and never touches the ingest/money
  path.
- `GET /api/claude-cost-check?days=30` — dashboard-session-gated; aggregates
  in SQLite via `groupBy` (bounded by model cardinality, not event volume —
  the #392 OOM lesson).
- `ClaudeCostCheckCard.tsx` on the dashboard — per-model tokens / derived /
  reported / drift table with status chips (in agreement < 5%, drifting <
  15%, diverged ≥ 15%, unpriced/partial when derivation is incomplete) and
  the pricing-snapshot date in the footer.

**Deliberate difference from ccusage:** they use derived cost as a *fallback
source of truth*; we use it purely as a **drift detector**. Both figures stay
analytics-only API-equivalent estimates — cash spend still comes from
receipts/subscriptions, unchanged.

### 3. Helicone / codeburn UI lessons (Helicone/helicone 6k★, getagentseal/codeburn 9k★)

- Helicone: per-model cost breakdown as a first-class table → adopted in the
  cross-check card. Their "cost next to coverage" presentation was already
  our convention (`CostCoverageLegend`, `costCoverageHelpText`).
- codeburn: per-project attribution across many agent tools → we already
  have `projectId` + OTLP `project` resource attributes; their multi-tool
  normalization validates our `sourceApp` discriminator design. Their
  "unknown tool ⇒ $0 with visible gap" pattern → adopted as the explicit
  `unpriced` chip instead of a silent $0.

## Assessed, already aligned (no change needed)

### Langfuse (langfuse/langfuse, 32k★)

License verified: **MIT Expat** outside `ee/` directories — patterns are free
to borrow. Their ingestion API (`POST /api/public/ingestion`) is a versioned
batch envelope with per-event IDs and per-event success/error statuses.
Assessment: our v2 telemetry contract (`@jaywedgeworth22/congress-trading-shared`,
the wire authority) already provides the equivalent — durable `eventId`s,
explicit ACK counts (`received/persisted/duplicates/pruned/rejected`), and
typed retry/error responses. Tightening per-event error detail is a
**shared-package** decision, not a monitor-local one, so nothing was changed
here. Their worker-side "calculate cost from pricing when not provided"
pattern is noted as a deferred option (see below).

### OpenMeter / Lago / Meteroid (2.2k★ / 10k★ / 1.2k★)

- OpenMeter's event-sourcing + dedupe-key + replay semantics ≈ our
  `producerId + eventId` length-prefixed SHA-256 idempotency and retention
  tombstones. Aligned.
- Lago's period-anchored, idempotent charge materialization ≈ our
  subscription materializer (`(subscriptionId, periodStart)` hash +
  `lastChargedPeriodStart` watermark). Aligned.
- Meteroid's subscription lifecycle states ≈ our
  `active | paused | canceled | considering` with DB-level filtering of
  non-charging statuses. Aligned.

### Infra patterns

- **opentelemetry-collector:** accept unknown metrics, tally, log once,
  never 500 — already our OTLP mapper contract. Their batch-retry guidance
  is why our OTLP idempotency hash includes the point's time window + value.
- **Prometheus/VictoriaMetrics:** rollup groupKeys freeze at aggregation
  time; historical rollups don't merge after a key change — the exact
  trade-off already documented for the `projectId` groupKey rehash in
  `data-retention.ts`.
- **Wallos (8k★):** subscription-tracker UX (renewal countdowns,
  monthly-equivalent normalization) — already covered by the Subscriptions
  tab and `forecastSubscriptionRenewals`.

### 4. Ingest-time pricing of generic unpriced events (follow-up, same day)

The one deferred Langfuse pattern, implemented behind **default-off**
`INGEST_COST_DERIVATION_ENABLED` after owner sign-off:

- `src/lib/pricing/derive-ingest-cost.ts` — stamps `_derivedCostUsd` +
  provenance keys (`_derivedCostPricingKey`, `_derivedCostSnapshot`,
  `_derivedCostIncomplete`) into **metadata only** for unpriced
  `metricType="usage"`/`unit="token"` events whose `keyRef` resolves in the
  bundled snapshot. `costUsd` stays null: the pushed-cash pool
  (`usagePushed` → budget spend) and priced/unpriced coverage counts are
  byte-for-byte untouched, because producers' own costUsd (including their
  `billingMode="estimated"`) is the only cost that enters that pool. The four
  keys are reserved in `usage-telemetry.ts` so producers cannot forge them.
- Token-rate selection: `metadata.tokenType` (input/output/cacheRead/
  cacheCreation) picks the matching rate; absent it, the INPUT rate is a
  documented floor flagged `_derivedCostIncomplete` (output usually costs
  more — the floor under-estimates, never over).
- Visibility: `GET /api/usage-events` and the dashboard telemetry panel
  surface `derivedCostEstimateUsd` / event count as a separate
  "Monitor-estimated" figure via one bounded `json_extract` aggregate scan
  (raw window only; rollups pre-date the stamps). The scan is skipped
  entirely when the flag is off, and the summary memo key carries the flag
  bit so a same-day flip can't serve stale totals.

## Deferred (deliberately not done)

1. **>200k-context premium auto-detection.** Needs per-request context size;
   not present in OTLP points. Base rates are used (documented in
   `model-pricing.ts`).
2. **Per-event ingest error detail** in the v2 ACK — belongs in
   `congress-trading-shared`, not here.
3. ~~**5-hour billing-block windows**~~ — **SHIPPED 2026-07-30**, generalized
   to every LLM platform per owner directive: `GET /api/llm-burn` +
   `LlmBurnCard` (trailing-window burn, live burn rate, MTD budget pace +
   linear projection). See `docs/rollouts/2026-07-30-llm-burn-windows.md`.

## Ops

- Refresh pricing: `npm run pricing:update` (commit the snapshot diff).
  Cadence suggestion: monthly, or whenever a new model shows up as
  `unpriced` in the cross-check card.
- Endpoint: `GET /api/claude-cost-check?days=30` (dashboard session).
- Enable ingest derivation: `INGEST_COST_DERIVATION_ENABLED="true"` (see
  `.env.example`).
