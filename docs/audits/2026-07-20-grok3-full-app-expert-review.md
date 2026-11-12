# Usage Monitor — multi-expert full-app review (GROK3)

**Date:** 2026-07-20  
**Owner:** GROK3 (read-only expert panel)  
**Worktree:** `/Users/jay/.grok/worktrees/code-usage-monitor/grok`  
**Method:** 14 specialist agents (UI/UX, iOS, responsive web, LLM cost, budgets/efficiency, alert storms, provider adapters, money-path subscriptions, security, OTLP, ops/deploy, cross-app contract, product IA, SQLite/perf). Static code review only — no prod mutations.

**Verdict:** The money path is carefully designed and largely fail-closed where it matters. Residual risk is concentrated in **trust presentation** (unknown as $0, dual fixed-fee models), **cross-app retry storms**, **iOS account-budget math**, and **ops observability lies** (ready/backup/deploy). The app is powerful for a power-user operator; it is not yet intuitive for “glance and trust the number.”

---

## Specialist lanes (14)

| Lane | Focus |
|------|--------|
| UI/UX | Dashboard hierarchy, spend trust, attention, density |
| iOS | Native app, widget, offline, parity |
| Responsive web | Desktop + iPhone Safari, extensions |
| LLM cost monitoring | Cash formula, dual channels, forecast, anomalies |
| API budgets & efficiency | Budget status consumers, poll loop, timeouts |
| Alert storms / coordination | Retry storms, admission, PD/Slack, ready lies |
| Provider adapters | Direct billing coverage gaps, Infisical wiring |
| Money-path subscriptions | Plan fixed vs Subscription, adoption, receipts |
| Security / auth | Tokens, rawData, extension residual |
| OTLP / Claude Code | Mapping, volume, double-count cash exclusion |
| Ops / deploy / SQLite | Oracle, Litestream, uptime, false-green |
| Cross-app telemetry | Shared package drift, idempotency, project |
| Product IA / Settings | Onboarding, mental model, breach workflow |
| Data retention / perf | MTD groupBy, tombstones, indexes |

---

## P0 — Fix first (trust, money, outage amplification)

### Money truth

1. **Portfolio / provider fallbacks can treat unknown cost as $0**  
   - Portfolio sum uses `spentUsd ?? 0` for exact families; incomplete paths can understate.  
   - `GET /api/providers` fallback: `spentUsd: canonicalBudget?.spentUsd ?? latestSnapshot?.totalCost ?? 0` and snapshot alone ⇒ `spendCoverage: "complete"`.  
   - **Files:** `src/lib/provider-money-aggregation.ts`, `src/app/api/providers/route.ts`, summary cards.

2. **Pie chart ≠ summary KPI**  
   Chart sums every row’s `projectedEomUsd` without family dedupe; summary uses family-safe aggregation.  
   - **File:** `src/components/DashboardCharts.tsx` vs `page.tsx` portfolio aggregate.

3. **`max(snapshot, push, receipt)` undercounts complementary channels; receipts inflate “spend”**  
   - Correct when one channel supersets another; understates disjoint slices.  
   - Prepaid receipt cash in `max()` can trip budgets on top-ups, not consumption.  
   - **File:** `src/lib/budget-status.ts` (~602–617).

4. **Plan fixed fee + Subscription events still both count in `spentUsd`**  
   - Conflict is warning-only; inventory UI can hide plan fixed while budget still adds it.  
   - “Plan price / mo” labeling invites double-count.  
   - **Files:** `budget-status.ts`, `AddProviderModal.tsx`, `billing-inventory.ts`, subscription POST (no plan-fixed guard).

5. **iOS Overview/widget mixes project budget with provider total spend**  
   - Server `totalBudgetUsd` / `overBudget` are project-scoped; `totalSpentUsd` is provider total.  
   - Hero meter can show “On track” with provider overages, or “no budget” when only provider budgets exist.  
   - Local project edit never hits the server (looks saved, vanishes on relaunch).  
   - Token remove does not clear cache/widget.  
   - **Files:** iOS `DashboardViewData.swift`, `ProjectBudgetEditing.swift`, `SettingsViewModel`.

### Storms / ops

6. **Cross-app producer retry storms remain the proven money-burn failure mode**  
   - Historical: OOM → clients ~35/s → bandwidth + CT D1 overage.  
   - Server still advertises short `Retry-After: 1` on some 429s; producers that spin on `accepted: 0` or ignore 202 can recreate.  
   - **Fix surface:** ST/CT/OTLP clients + longer server Retry-After + circuit breakers.

7. **Oracle auto-deploy can wedge while GH “deploy” observer goes green**  
   - Circuit breaker / blocked-sha; observer exit-0 on “superseded” without proving SHA live.  
   - Effort log already recorded ~24h false-green lag.  
   - **Files:** `deploy/oracle/auto-deploy.sh`, `.github/workflows/oracle-production-deploy.yml`.

8. **Backup “ok” on `/api/ready` is env-var (`LITESTREAM_ACTIVE`), not replica health**  
   - Silent Garage death while ready stays green. External Garage Sentry is the real backup signal.

---

## P1 — High impact (clarity, coverage, efficiency, security blast radius)

### UX / product

9. Dual density systems (global vs workspace) with opposite defaults.  
10. Critical money detail / Attention buried in closed “Portfolio detail”; Attention truncates at 8 with no “+N more”.  
11. Open Alerts “0” styled amber (false urgency).  
12. Multi-account families: no family budget; “known” suffix uses only first member’s coverage.  
13. Branding: “Usage Monitor” vs nav “API Monitor”.  
14. Dark mode incomplete on Projects / Attention / Sentry / dashboard chrome.  
15. iPhone login `text-sm` inputs → Safari zoom; undersized table action targets; Settings sticky offsets fragile; workspace filters not sticky on mobile.  
16. No in-product push/OTLP setup path; push-primary providers look “configured” while silent.  
17. Budget breach messages are diagnostic only — no edit-budget / pause / breakdown actions.  
18. `status` for App B throttle ignores EOM projection (ok until already ≥80% spend).

### Cost / providers / contract

19. Fixed-fee conflict + unlinked same-price fail-open double-count (operator-dependent).  
20. Blind/high-spend gaps: Anthropic individual, Voyage, Mistral cash null, Render no invoice, OpenRouter MTD estimate without caveat, Cloudflare PayGo often incomplete.  
21. Infisical maps primary keys but often not Admin/management money-path credentials (OpenAI Admin, Anthropic Admin, xAI team, CF/GH/Vercel).  
22. Shared package dual-schema (not a dep here) — no CI contract lock with `congress-trading-shared`.  
23. Coarse 5-field idempotency + random key when `occurredAt` missing → double-count on retry; non-normalized ISO strings re-key.  
24. Unknown project names never backfill after Project create without producer replay; rollups lose late projectId.  
25. Budget SWR 60s not busted by ingest; cold path ~11s full-month groupBy (×2 for projects).  
26. Poll: no failure/429 cross-tick backoff; timeout doesn’t cancel in-flight HTTP (quota still burns); OpenAI multi-endpoint fan-out every cycle.

### OTLP / security / ops

27. Cumulative zero-deltas + `system.*` host metrics (hardcoded `hetzner`) can flood SQLite if enabled.  
28. `OTLP_METRICS_INGEST_ENABLED` only honors exact `"false"`.  
29. Shared `USAGE_INGEST_TOKEN` = write any cost + often full budget/subscription read (no distinct `USAGE_READ_TOKEN` in prod blueprint).  
30. Built-in adapter `rawData` largely preserved at rest (disk/backup PII risk).  
31. Uptime probes `/api/ready` without `?strict=1` and weaker fields than deploy gates.  
32. iOS: background refresh ignores host override; widget placeholder shows fake money; alert notifications drop provider identity.

---

## P2 — Solidify (polish, perf, residual flaps)

- EOM forecast linear-only; series forecast implemented but unused.  
- Anomalies poll-snapshot-only (push-primary blind).  
- OpenRouter verification does not correct cash (audit-only); batch 25/tick.  
- Reconciliation compares push usage to whole snapshot (fixed-included noise).  
- The fleet-relay seeded Provider couples coordination into poller (inactive by design).  
- Ingest rate limit keyed on shared CF IP, not auth identity.  
- Tombstones never pruned (correct for money, unbounded growth).  
- VACUUM opt-in; freelist grows.  
- Materializer persist+watermark non-atomic (idempotent, still brittle).  
- Managed `autoRenew=false` under-projects future renewals.  
- Cloudflare handoff multi-tick by design.  
- CSP nonce not on layout density script (fails closed).  
- Safari extension scaffold incomplete; Chrome is launcher-only (good security).  
- ARCHITECTURE-CONTRACT.md iOS doc stale (features real, doc says placeholders).  
- No subscriptions UI on iOS despite API client method.  
- Login Suspense fallback null; mobile last-updated hidden.

---

## Ranked improvements (product + engineering)

### Trust the number (top)

1. Never coerce null/unknown spend to $0 in portfolio, providers API, or hero totals; show “priced / incomplete / excluded $”.  
2. One aggregation model for KPI + charts + family rows.  
3. Hard-block Plan price + active Subscription for same fee (or exclude plan fixed when events exist).  
4. Split prepaid funding vs consumption in budgets (default alerts on usage).  
5. Fix iOS account totals from **providers**; quarantine local project edit; clear cache on sign-out.

### Intuitive operator workflows

6. Attention always visible for critical; “+N more”; deep-link to edit budget.  
7. Unified density + product name “Usage Monitor”.  
8. Cost-coverage legend (Complete / Known / Not reported / Gap) not tooltip-only.  
9. Post-add connection checklist: poll? snapshot? cost channel? budget? next step for push-only.  
10. Push/OTLP setup card in Settings.  
11. Mobile: 16px inputs, 44pt actions, sticky filters, dark tokens on chrome.

### Efficiency & storm resistance

12. Producer circuit breakers + honor long Retry-After; bump server 429 Retry-After ≥5–30s.  
13. Abort adapter HTTP on provider timeout; failure backoff; skip known-blind without invoke.  
14. Incremental current-month MTD counters (kill 11s groupBy).  
15. Wire projected budget status for throttle consumers.  
16. Cap pathological pagination; short-circuit OpenAI legacy when Costs succeeds.

### Coverage & ops

17. Infisical Admin/management key wiring for money-path providers.  
18. OpenRouter estimate caveat; LlamaIndex doc fix.  
19. Alert deploy lag / blocked-sha / revision ≠ main.  
20. Uptime: `ready?strict=1` + deploy-grade fields.  
21. Cross-repo CI for shared telemetry vectors.  
22. Distinct `USAGE_READ_TOKEN` in production.

---

## What’s already strong (do not regress)

- Cash exclusion for Claude Code OTLP analytics (`sourceApp`+`service` = claude-code).  
- Ingest admission (reject-not-queue), OTLP kill switch, idempotent upserts.  
- Alert channel claims, PD dedup, Slack unknown-outcome deferral, 24h reminders.  
- Blind adapters never burn quota to “validate keys.”  
- Family aggregation, coverage caveats (Cloudflare PayGo, etc.), fail-closed partial pages.  
- Receipt inbox cannot mint spend; HMAC importer separate.  
- Sole-writer Oracle cutover, pre-migration backups, fail-closed migrate-safe.  
- Integration drawer honesty; secrets not returned to forms.  
- Responsive table → card pattern; modal focus trap / `100dvh`.

---

## Suggested implementation waves

| Wave | Theme | Outcomes |
|------|--------|----------|
| **A** | Money trust | Null-safe totals, chart parity, plan/sub exclusivity, providers API fail-closed |
| **B** | iOS money | Provider-scoped hero, no fake local budgets, sign-out clear, real empty widget |
| **C** | Storms + ops | Producer contracts, Retry-After, uptime strict, deploy lag alerts |
| **D** | Operator UX | Attention, density, coverage legend, onboarding checklist, mobile a11y |
| **E** | Scale + coverage | MTD counters, poll abort/backoff, Infisical admin keys, OpenRouter honesty |

---

## Non-goals of this review

- No code changes, PRs, or production probes.  
- Did not re-verify live `usage.jays.services` data correctness.  
- Shared client package (`congress-trading-shared`, ST push path) not in this worktree — flagged as external risk only.

---

## Follow-up

Owner may pick waves for implementation lanes; GROK3 stays read-only unless assigned a fix lane. Full specialist transcripts remain in session subagent outputs (2026-07-20).
