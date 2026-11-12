# Usage compliance & OpenRouter classifier metadata — cross-repo initiative

**Date:** 2026-07-19 · **Seat:** CLAUDE (pickup of MONET's paused work) · **Repos:** `congress-trading-shared`, `Usage-Monitor`, `Congress.Trade`, `Socratic.Trade`

Source handoff: `/Users/jay/apps/HANDOFF-usage-compliance-classifier-MONET.md`
Authoritative design: `/Users/jay/apps/DESIGN-usage-compliance-classifier.md` (amended twice during this work — see below)

---

## What the initiative does

Three workstreams, built together per the owner's locked decisions:

1. **Universal ingestion** — every app reliably pushes usage telemetry to the monitor.
2. **Reconciliation / compliance** — the monitor compares each app's *self-reported* usage against *provider-verified* usage wherever ground truth exists, and flags drift. Where no ground truth exists, it says so explicitly.
3. **Classifier metadata** — every OpenRouter call carries `sourceApp/environment/service/feature/keyRef/gitSha` for forensics, and its generation id flows back to the monitor for per-call cost verification.

The guiding rule throughout: **a provider we cannot verify must never render as "OK"** — it must be labelled `unverifiable`.

---

## What shipped

| Wave | Repo | PR | Merged as |
|---|---|---|---|
| 1a — classifier contract | congress-trading-shared | #197 | `904ea96` (tag `v1.10.0`) |
| 1b — schema + ingest | Usage-Monitor | #581 | `fbf73f14` |
| 2 — CT metadata + generation id | Congress.Trade | #626 | `a562c00` |
| 2 — ST gaps + metadata | Socratic.Trade | #1820 | *open, CI queued* |
| 3 — verification + reconciliation backend | Usage-Monitor | #617 | `47be3dba` |
| 3 — compliance UI | Usage-Monitor | #619 | *open* |

### Wave 1a — the shared contract
`buildCallClassifier` / `openrouterRequestEnrichment` / `telemetryEventClassifier`, plus optional `providerRequestId` on `UsageTelemetryEventSchema`. The idempotency-key derivation is **byte-identical** to before (re-derived independently; 7/7 hash vectors matched externally computed values) — `providerRequestId` is deliberately NOT one of its inputs, so a replay carrying a different generation id still dedupes.

### Wave 1b — schema + ingest
Additive only: `ExternalUsageEvent` gains `providerRequestId` + `verifiedCostUsd/verifiedAt/verificationStatus/verifiedSource` + 2 indexes; new `ProviderUsageReconciliation` model. **Producers can never self-verify** — a payload claiming `verificationStatus: "match"` still persists `null`, enforced at the parse, persist, and replay layers with a real-route integration test.

### Wave 2 — the apps
CT injects enrichment at its single `callOpenRouter` choke point and threads the generation id into pushed telemetry. ST closes three previously-unmetered paid-call paths (`market-signals/massive.ts`, `rag/query-deconstruct.ts`, `rag/search-fusion.ts`) and threads enrichment across its LLM/RAG call sites.

### Wave 3 — verification, reconciliation, UI
A bounded per-pass worker calls OpenRouter `get-generation`, stores the authoritative cost, and marks each event `match`/`discrepancy`. Period reconciliation upserts one row per provider-period comparing pushed telemetry against the provider's own month-to-date cost. The provider page shows a compliance badge, verified-coverage %, and the signed dollar difference.

---

## Design corrections made during the build

Both were caught by adversarial review **before** merge and are amended in the design doc:

1. **OpenRouter enrichment shape.** The design specified `trace: { metadata: {...} }`. That is wrong — OpenRouter's Broadcast docs treat `trace` itself as the arbitrary-metadata object ("any additional keys in `trace` are passed as trace metadata"), and `environment` is a reserved `trace` key. With the nested shape the individual classifier fields would never become filterable attributes, defeating the purpose. **Shipped shape: classifier keys FLAT under `trace`**, `user`/`session_id` capped at 128 chars.
2. **`ProviderUsageReconciliation.keyRef` nullability.** The design specified `keyRef?`. SQLite treats every NULL as distinct in a unique index and Prisma cannot target a NULL member of a compound unique, so a nullable column made the period upsert unenforceable. **Shipped as `String @default("")`** — `""` means provider-wide. Also corrected: the design's due-scan predicate `verificationStatus IN (NULL,'pending','error')` never matches NULL in SQL; the shipped predicate is `(verificationStatus IS NULL OR verificationStatus IN ('pending','error'))`.

---

## Defects found and fixed in previously-merged work

PR #590 had already landed a Wave-3 implementation inline in `usage-maintenance.ts`. Reading it against `main` before building on top revealed it was **non-functional in production**; #617 replaces it. All confirmed by reading the merged code, not inferred:

1. **Dead code.** It selected events on `keyRef startsWith "gen-"`, but the generation id lives in `providerRequestId`; `keyRef` holds the API-key reference (CT pushes `keyRef: apiKeyName`). It matched zero real rows and always returned 0. Its test passed only because the fixture wrote the generation id *into* `keyRef` — encoding the bug rather than the producer contract.
2. **It never verified cost.** It compared `payload.id` to the id it had just queried (an echo check) and never wrote `verifiedCostUsd`/`verifiedAt`/`verifiedSource`. No drift could ever be detected.
3. **Undefined status vocabulary** (`verified`/`failed` vs the schema's `match`/`discrepancy`/`error`/`unverifiable`).
4. **No retries** — the scan matched only `verificationStatus: null`, so anything it wrote was permanently excluded.
5. **Destructive reconciliation** — `deleteMany` + `create` with `periodEnd = now`. A moving `periodEnd` defeats the unique key that #581 deliberately made upsertable; non-atomic, and it destroyed row history every pass.
6. **Silent skips** — providers with `metadata|manual|none` visibility were skipped rather than labelled `unverifiable`.
7. **Writer lock held across network I/O** — all HTTP calls ran inside `withInternalUsageWriteAdmission`, blocking ingest on the single SQLite writer.

Adversarial review of the **replacement** then caught two more defects, neither visible to typecheck or the mocked single-pass tests:

- **Exhausted-event loop.** Parking a retry-exhausted event as `"error"` — a *retryable* status the due-scan selects — combined with an exhausted marker that parsed the attempt counter back to 0, produced a permanent 1→5 cycle. Since the scan is oldest-first, a pile of permanently dead generation ids would fill every 25-slot batch forever, burn 25 API calls per pass, and **starve all newly-ingested events**, disguised as an ordinary backlog by `truncated: true`. Fixed by parking exhausted events in the terminal `"unverifiable"` status.
- **Multi-provider-row double count.** Pushed cost is bucketed by canonical key while the loop iterates Provider *rows*, and `Provider.name` has no unique constraint. Two active same-key rows (e.g. two OpenAI accounts at $60/$40 against a $100 pushed total) would **each** claim the full total and **both** report a discrepancy on a perfectly reconciled month. Fixed by resolving exactly one owner row per canonical key via the repo's existing `resolveProviderIdentity` tie-break (deterministic, verified non-flapping; single-provider behavior byte-identical), with siblings recorded honestly as `unverifiable`.

Also hardened: `isUsageMaintenanceHealthy` now accounts for `openrouterVerification.degraded`, so a 401/403 key can no longer silently disable the audit layer while maintenance reports healthy.

---

## Constraints honored throughout

- `budget-status.ts` `max()` spend logic **untouched** — reconciliation is a separate audit layer beside it, never an input to it.
- No unbounded boot-time work (the documented boot-OOM incident came from two concurrent ~336k-row aggregations at startup); the month-to-date aggregation runs **once per maintenance pass**, never per provider.
- Additive migrations only; no new **required** env vars (tolerances are optional overrides).
- Any key rendered on screen uses `buildKeyPreview` (first 6 + last 4) — standing owner rule.

---

## Open items

1. **Oracle auto-deploy is wedged** (pre-existing, unrelated to this work, needs Oracle root). The box's post-live acceptance gate rolled back `bf7b67e2` and `fbf73f14`, and its circuit breaker has blocked further attempts; production has been serving `c747e892` since. The GitHub "Oracle Production Deploy" workflow is only a *first-sighting observer*, so its green runs do not prove a revision stuck. Diagnosis: `sudo cat /var/lib/usage-monitor-deploy/{current.json,blocked-sha,failure-state}` and `journalctl -u usage-monitor-auto-deploy.service`, fix the failing gate, then `usage-monitor-auto-deploy --retry-blocked`. **Merged Wave 1b/3 code is therefore not yet live.**
2. **ST PR #1820** — built and pushed; its CI has been queued for hours behind saturated self-hosted runners. Needs its gate to finish, then adversarial review before merge (ST auto-deploys on merge).
3. **Multi-account reconciliation nuance** (reviewer-flagged, non-blocking, no budget impact): in a multi-row canonical key the owner row is credited the *combined* pushed bucket but compared against its *own* snapshot, so a genuine two-account split can still show one false discrepancy. Strictly better than the previous behavior (two false discrepancies, with the sibling silently wrong). The fully-honest alternative marks every row in a multi-row key `unverifiable`, at the cost of losing reconciliation for the common stale-duplicate-row case — decide once real multi-account data exists.
4. **Empirical `trace` acceptance check** against the live OpenRouter Activity dashboard was not run (it needs a real paid call plus dashboard access). The shape is docs-verified and confirmed by the repo's own review bot, but the end-to-end confirmation remains open.
