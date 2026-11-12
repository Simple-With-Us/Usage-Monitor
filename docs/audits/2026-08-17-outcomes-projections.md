# Usage Monitor — outcomes and projections audit

**Date:** 2026-08-17
**Reviewer:** Grok (read-only, report only)
**Branch:** `cursor/outcomes-projections-audit-4269`
**Method:** Static review of the live money, burn, alert, anomaly, and reconciliation paths, plus the 2026-07-20 full-app audit, rollout notes, and unit tests.  No production mutations.  No new product code.

**Verdict.**  The math is careful, fail-open where it should be, and much more honest about unknown cash than it was a month ago.  It still does not know whether any of its forecasts were right.  Four clocks measure “how far into the month we are.”  Budget alerts wait for cash to cross 80%.  The dashboard’s `projectedStatus` can already be red from a day-1 linear 31×.  The only closed-loop cost action in this repo is the R2 free-tier kill switch.  For LLM and API spend, the product is a high-quality observer: it helps an operator raise a budget or investigate a table, and it cannot pause vendor spend or say “we were wrong last month.”

---

## Scope

This audit asks whether Usage Monitor’s projections, burn rates, remaining-days estimates, free-tier thresholds, discrepancy detection, alert thresholds, anomaly logic, historical comparisons, and accuracy measures drive useful cost decisions.

It does **not** re-audit provider-adapter truth (that is the concurrent `cursor/providers-accuracy-audit-9579` lane) or security/privacy.

---

## How the models work

### Cash end-of-month forecast

`calculateEomForecast` in `src/lib/forecasting.ts` is the default cash model:

```
currentDay  = UTC_date + hours/24 + minutes/1440
usageUsd    = max(0, spentUsd − fixedAccruedUsd)
EOM         = fixedAccruedUsd + (usageUsd / currentDay) × daysInMonth
```

`currentDay` is a 1-based day number.  15 January 12:00 UTC is treated as day 15.5 of 31, “exactly halfway.”  The unit test in `src/lib/__tests__/forecasting.test.ts` locks that in.  True elapsed time at that instant is 14.5 days.  LLM burn and R2 use true elapsed.  Cash does not.

The early-month guard is `if (currentDay < 0.1) return spentUsd`.  `getUTCDate()` is 1–31, so `currentDay` is never below 1.  The guard cannot fire.  The “beginning of month” test passes because usage is `$50 − $50 = 0`, not because the guard ran.  A $10 variable charge at 00:00 UTC on the 1st projects to `$10 / 1.0 × 31 = $310`.

### Series / trend forecast

`forecastMonthlyUsageFromSeries` fits recency-weighted least squares (`y = a + b·d`, half-life 5 days) on complete days and integrates the line over the remaining span.  Remaining usage is clamped to `[⅓, 3]×` of linear remaining.  The fit needs 5 complete days inside the function.

Provider cash (`computeBudgetStatus` in `src/lib/budget-status.ts` around 1491–1523) adds a second gate: 5 **nonzero** complete days.  That stops a mid-month first snapshot from looking like a spike and hitting the 3× clamp.  After that gate, the provider EOM is:

```
projectedVariable = max(observedVariable, seriesOrLinear)
projectedEom      = fixedAccrued + projectedVariable + known remaining renewals
```

The 2026-07-20 audit said the series model was implemented and unused.  That is no longer true on the provider cash path.  It is still unused on project budgets, family aggregation, alert-state EOM, iOS Local, LLM burn, and R2.

The function comment says the fit excludes today’s partial day.  Production series length is `utcDayIndex(now)+1` and `completeDays = min(length, floor(currentDay))`, so today’s partial bucket is in the fit.

### Remaining days / runout

`projectBudgetRunout` takes the already-computed EOM and assumes constant remaining burn:

```
dailyBurn = (projectedEom − spent) / (daysInMonth − currentDay)
days      = (budget − spent) / dailyBurn
```

Days are rounded to one decimal.  Runout can land after month end.  The test at `forecasting.test.ts` 147–158 expects a 2-day crossing into August from a 30 July snapshot.  The UI copy in `src/lib/format.ts` still says “at current burn.”

LLM burn has no remaining-days.  R2 has no days-until-70%.  iOS `ProviderDetailView.pacePoints` uses `daysInMonth − day` on the **device** calendar.  That is chart geometry, not runway.

`remainingUsd` is dollars left (`budget − spent`), can be negative, and only covers budgeted providers.

### LLM burn (analytics only)

`src/lib/llm-burn.ts` generalizes ccusage’s 5-hour block to every LLM in `ExternalUsageEvent`.  Cost is `max(reported, LiteLLM-derived)`.  Both sides are API-equivalent estimates.  The module never feeds `budget-status`, alerts, or controls.  The 2026-07-30 rollout says so, and the card footer says so.

Pace uses true elapsed month fraction:

```
paceRatio          = mtdEstimate / (budget × elapsedFraction)
projectedMonthEnd  = mtdEstimate / elapsedFraction   if elapsed ≥ 0.02, else null
```

Chips: no budget; `paceRatio < 1` on pace; `< 1.1` watch; `≥ 1.1` over-pace.  Watch therefore starts at exactly on-pace, not at 1.1.  Hourly rate divides by activity minutes clamped to `[15, windowHours×60]`.

This is a trailing rate, not Anthropic’s billed 5-hour block remaining.

### Free-tier / kill thresholds

R2 is the only automated cost actuator.

| Knob | Value | File |
|------|-------|------|
| Storage / Class A / Class B caps | 10 GiB, 1M, 10M | `src/lib/r2-usage.ts` 43–47 |
| Kill | 70% | `R2_THRESHOLD_PCT` |
| Storage kill | absolute MTD only | 14–17, 401–408 |
| Class A/B kill | absolute **or** pace | 18–19, 409–421 |
| Soft tip-prune | 50% | `R2_SOFT_PRUNE_STORAGE_PCT` |
| Auto-resume | storage < 65% and ops not on-track | `R2_RESUME_STORAGE_PCT` |
| Early-month | `elapsedFraction = max(elapsed, 0.02)` | 356 |

The 0.02 floor **raises** early-month pace.  A handful of Class A ops on the 1st can look like a 70% month.  LLM burn does the opposite: it withholds the dollar projection below 2%.  Cash tries to withhold below 0.1 day and fails.

Backblaze’s 10 GB allowance is observe-only.  OpenRouter’s $3 remaining floor pages UptimeRobot; it is not a burn model.

### Alerts

Budget alerts in `src/lib/provider-alerts.ts` fire on **current tracked MTD spend**, not on EOM:

| Transition | Ratio |
|------------|-------|
| Enter warning | ≥ 0.80 |
| Enter exceeded | ≥ 1.00 |
| Stay exceeded | ≥ 0.95 |
| Stay warning | ≥ 0.75 |

Dashboard `status` uses a flat `WARNING_RATIO = 0.8` with no hysteresis.  Dashboard `projectedStatus` applies the same 0.8 / 1.0 bands to the **series-aware** EOM.  `buildProviderAlertState` recomputes EOM with linear `calculateEomForecast` and does not put that number into `resolveBudgetAlertTier`.  A 5× burn on day 3 of a large budget is silent until cash actually crosses 80%.  The same day, `projectedStatus` can already be `exceeded` for a throttle consumer.

Request-limit “hysteresis” is a comment.  The call always passes `previous = "ok"`.

Renewal notices are exact calendar milestones 7 / 3 / 1 days.  `stale_snapshot` is not emitted.

### Anomalies

Median + MAD, Iglewicz–Hoaglin modified z (`src/lib/anomaly-detection.ts`).  Defaults: 14-day window, 7 baseline points, 3.5σ warning, 5σ critical, $1 / 100-request floors, +50% relative jump, **up only**.  Observed point is the latest **complete UTC day**, never today.

That is a standard robust spike rule.  It is not a cost model.  14 days is short versus weekly seasonality.  Dense MTD zeros (weekends) pull the median down.  Snapshot gaps omit missing days, so several quiet days can collapse into one fat increment.  Snapshot anomaly uses raw `totalCost`, not variable cost, so a first-of-month fixed fee can look like a spike.  Push prior-month rollups are sparse (`totalCostUsd > 0`); in-month push is dense with zeros.

### Discrepancy / reconciliation

Period recon compares pushed `usagePushed` to `snapshotVariableCostUsd` with `allowed = max($0.01, 5% of verified)`.  It never writes into `spentUsd`.

Decision tree (first match): duplicate canonical name → all `unverifiable`; catalog visibility not `actual`/`partial` → `unverifiable`; no calendar MTD snapshot → `pending`; snapshot but zero push → `unverifiable` (Twilio / PagerDuty #64/#70, PR #1131); else compare.

`unverifiable` and `pending` do not page.  That stopped a class of guaranteed 100% false pages.  It also means a missing producer is silent.

### Claude drift (analytics)

`ClaudeCostCheckCard` chips: `<5%` in agreement, `<15%` drifting, `≥15%` diverged.  Unpriced models under-count derivation.  Neither figure is cash.

---

## Findings

Severity is about **wrong or late cost decisions**, not code taste.

### P0 — can cause a wrong action this month

**1. Day-1 cash forecast can 31× a single charge.**
The `currentDay < 0.1` guard is dead.  `projectedStatus` uses that EOM.  `GET /api/budget-status` documents `projectedStatus` for throttle consumers (“Throttle consumers need runway, not only lagging MTD spend,” `budget-status.ts` 1682–1693).  A first-of-month lump can tell a consumer to stop while MTD is 3% of budget.  LLM burn withholds; cash does not.

**2. Alert EOM and dashboard EOM are different models.**
`buildProviderAlertState` always calls linear `calculateEomForecast` (`provider-alerts.ts` 216–220).  Provider cards use the series-aware EOM after 5 nonzero days.  Alerts still ignore EOM entirely and wait for cash ≥ 80%.  An operator can see “On pace to exceed budget” with no `budget_warning`, or the reverse once cash crosses and the series later cools.

**3. Web and iOS can disagree on the same account.**
Web hero prefers Global Budget (override or sum of project budgets).  iOS Overview sums **provider** budgets (`DashboardViewData.swift`, “Across N provider budgets”).  Remote iOS prefers server `projectedStatus` (0.8).  The stale-payload fallback is `projectedFraction ≥ 0.9` (line 132).  Same UTC day, one surface can be On Track and the other Over Budget.

**4. R2 Class A pace-kill is the sharpest actuator and the easiest early-month misfire.**
`elapsedFraction = max(elapsed, 0.02)` makes pace more aggressive.  Storage is absolute-only (a steady 6 GiB is fine).  Ops are not.  Effort log already recorded the 2026-08-04 kill sticking for about eight days at 4.4% storage because Coolify/Infisical pinned `R2_WRITES_DISABLED`.  A kill that does not resume is a worse cost decision than the overage it prevents: backups stop.

### P1 — high impact on trust or a missed decision

**5. No forecast evaluation exists.**
Grep of `src/lib/__tests__` finds no MAPE, MAE, RMSE, backtest, holdout, or calibration.  Series tests assume the synthetic ramp continues (`1…20` then `21…31`).  That is a consistency check.  There is no month-end realized-vs-predicted job, no day-7/14/21/28 skill table, and no UI that says “last month we projected $X, actual was $Y.”

**6. Three elapsed-month clocks, three early-month policies.**

| Path | Clock | Early-month behavior |
|------|-------|----------------------|
| Cash EOM | 1-based fractional UTC date | Guard dead; day 1 = 31× |
| LLM burn | true `(now − monthStart) / monthLength` | Withhold projection below 2% |
| R2 / Hetzner | true elapsed | Floor denominator at 2% (R2) or pro-rate catalog (Hetzner) |
| iOS pace chart | `Calendar.current` | Integer local day |

Pace-vs-even-spend on the web chart uses **integer** UTC date (`SpendBurnChart.tsx`).  Cash EOM uses fractional 1-based days.  Same instant, different “day.”

**7. Series model is unused where totals are summed.**
Projects always call linear `calculateEomForecast` (`budget-status.ts` 2447–2457) and treat receipt-backed variable as non-forecastable fixed.  Family aggregation re-forecasts linearly (`provider-money-aggregation.ts` 199–202).  `ProjectsPanel` types `projectedEomUsd` and never renders it.  `ProjectTable` has no EOM column.  Portfolio pie uses family linear EOMs.

**8. Runout flattens a curved EOM.**
Even when EOM came from the WLS integral, days-left assumes constant `dailyBurn`.  The date can be next month while the copy says “at current burn.”  There is no “days left in *this* UTC month” vs “days until this budget is exhausted at this rate.”

**9. Budget alerts are late by design; pace is decorative for paging.**
80/100 + hysteresis is a sound cash tripwire.  It is not an early-warning statistic.  `formatBudgetRunout` is explicit: “Deliberately NOT an alert.”  A large budget can be 3× even-spend on day 5 and still `ok`.

**10. LLM burn cannot answer “how many days of Claude left.”**
No remaining-days, no token-quota remaining, no 5-hour *block* remaining.  `usdPerHour` is a trailing rate.  The card never shows `paceRatio`.  Cash can say On track while the burn chip says over pace, because they are different books of money.  Nothing reconciles them for the operator.

**11. Anomaly logic will page on calendar structure and miss today.**
Weekend zeros in dense MTD, poll gaps, and first-of-month fixed fees are false-positive paths.  Direction `up` means a silent producer looks like a calm day.  S7 (complete day only) means a runaway session today is invisible until tomorrow.  New push providers are silent until 7 complete days or prior-month rollups exist.  No multiple-comparison correction across the fleet.

**12. Reconciliation 5% does not encode expected coverage.**
After the Twilio fix, any producer that pushes *some* events can still discrepancy the whole org bill.  That is often “apps report a subset,” not “theft.”  Push-primary providers (Anthropic without admin, Voyage, Robinhood) typically stay `pending` or `unverifiable` forever.  Silence is easy to misread as reconciled unless the operator is already on the compliance table.

**13. The product still cannot pause real spend.**
`budget-controls.ts` 338–354: auto-pause was rejected because this app is a read-only observer; pausing poll blinds the dashboard while the key keeps charging.  The replacement is `key_disable_recommended`, advisory, default-off.  Attention “Edit budget” / “Review subscriptions” navigates.  iOS can pause a *tracked Subscription row*.  That stops materialized events here, not Anthropic.  There is no switch-provider or cheaper-model path.

**14. Complementary-channel `max()` still understates disjoint slices.**
The 2026-07-20 P0 #3 is still true in comments around `budget-status.ts` 1356–1363: one channel is assumed to superset the other.  Plan fixed fee + Subscription can still both hit `spentUsd`; `fixedCostConflict` is warning-only (2026-07-20 #4, still open).

**15. Hetzner catalog MTD × linear EOM can reconstruct the full monthly catalog price.**
`hetzner.ts` pro-rates catalog run-rate by elapsed fraction into MTD.  If that MTD then enters `calculateEomForecast`, even pace is applied twice.

### P2 — solidify

**16.** Stale comment in `forecasting.ts` 38: “All existing consumers keep calling `calculateEomForecast`; this is additive.”  Provider cash does not.

**17.** Trend lower clamp of ⅓ linear remaining never trusts a crash.  A real stop in spend still projects a third of the old pace.

**18.** iOS `SpendPace.make` requires a budget; web chart works with `budget = null` and omits the even-spend line.

**19.** Request-limit hysteresis comment vs `previous = "ok"` (`provider-alerts.ts` 275–283).

**20.** Claude 15% / 5% bands live only in the card.  They do not page.  Catalog refresh is `npm run pricing:update`, not a button.

**21.** No days-until-R2-70% for Class A ListObjects cadence.  Operators get percents.

**22.** `resumeMarginRatio = 0.9` in budget-controls is dead for auto-resume.  Spend is monotonic inside a UTC month.

**23.** Portfolio history is windowed usage-events totals (7d / 30d / 90d).  Copy: “Usage history only · budgets stay month-to-date.”  That is not MoM and not forecast-vs-actual.

---

## Model and evaluation gaps

What a forecasting shop would require and this repo does not have:

1. **A single elapsed-time definition.**  Until cash, LLM burn, R2, and iOS share one clock, “on pace” is not a comparable sentence.
2. **A working early-month policy on the cash path.**  Either withhold `projectedStatus` below ~2% elapsed (LLM burn’s rule) or use true elapsed so day 1 is ~1/31, not 1/1.
3. **One EOM per provider, reused everywhere.**  Alerts, projects, families, and Local should not re-linearize a number the provider path already computed.
4. **Point forecast plus uncertainty.**  The 3×/⅓ clamp is a heuristic bound, not a prediction interval.  No residual variance, no coverage.
5. **A time-series model, or an honest label.**  Recency-weighted OLS is not Holt, SES, or a weekday seasonal.  The UI already says “Linear estimate — not daily history” on the pace chart.  The EOM modal says “extrapolated” and does not say linear vs trend.
6. **Walk-forward evaluation.**  Persist `{asOf, providerId, projectedEomUsd, model}` daily.  After month close, score MAPE / sMAPE / bias at day 7, 14, 21, 28.  If day-7 MAPE stays ugly, stop showing dollar EOM that early.
7. **A last-month path, not an even-spend line.**  Even-spend is `budget / days`.  That is a policy line, not a baseline.  Last month’s daily series is sitting in rollups and is unused as a comparator.
8. **Seasonal anomaly baseline.**  Split weekday vs weekend, or use a 28-day window with DoW medians.  Keep MAD.  Add a down-direction “silent producer” check for push-primary rows that had traffic last week.
9. **Recon expected-coverage, not a flat 5%.**  A producer that is documented as a subset should not page at 100% of the org bill minus $0.01.
10. **Closed-loop outcome metrics.**  See the next section.  Cards rendered are not the product working.

---

## Recommended metrics

Measure decisions and forecast skill, not card impressions.

| Metric | What it answers | How |
|--------|-----------------|-----|
| **EOM MAPE by horizon** | Are projections any good? | Actual month-end cash vs `projectedEomUsd` stored on day 7 / 14 / 21 / 28, per provider.  Split linear vs series. |
| **Bias** | Do we systematically over-project early? | Signed `(projected − actual) / actual`.  Day-1 31× will show up here immediately. |
| **`projectedStatus` flip rate** | How often does runway change its mind? | Count ok→warning→ok inside the first 5 days.  High flip rate means do not throttle on it. |
| **Alert precision** | Did this page change money? | `budget_*` / `spend_anomaly` / `usage_reconciliation_discrepancy` that clear with no budget edit, no subscription change, and no producer fix. |
| **Budget-edit rate after Attention** | Does “On pace to exceed” cause a raise? | Attention or `projectedStatus=exceeded` view → budget PUT within 24h. |
| **Subscription action rate** | Do unused / duplicate / price-change alerts get a keep or a pause? | Alert → pause/cancel/confirm. |
| **Discrepancy time-to-clear** | Is investigate a dead end? | Claude diverged / OpenRouter disagreeing / `fixedCostConflict` → cleared or explicitly accepted. |
| **Cross-surface agreement** | Can a glance be trusted? | Web Global Budget status vs iOS provider-sum status vs LLM pace chip, same UTC day. |
| **R2 free-tier saves vs false kills** | Does the one actuator earn its keep? | Class A/B crossings that did not convert to paid, minus kills that stuck while storage was <10%. |
| **Negative control** | Did “pause” only hide spend? | Owner pause API uses that did not change the next vendor invoice. |

If EOM MAPE at day 14 is worse than “last month × this month’s elapsed fraction,” the series model is decoration.  Ship the score before shipping a fancier model.

---

## Fixes and upgrades

Report-only.  Suggested order if someone implements later.

### Fix now (small, high leverage)

1. **Replace `currentDay < 0.1` with true elapsed fraction**, and withhold `projectedStatus` / runout below ~0.02 elapsed, matching LLM burn.  Keep showing MTD spend.
2. **Pass the provider’s already-computed `projectedEomUsd` into alert state** instead of recomputing linear.  Still alert on cash for `budget_warning`; use one EOM for copy and `projectedStatus`.
3. **Align iOS Overview to Global Budget** (or label the denominator in the hero).  Change the 0.9 fallback to 0.8 so a stale payload matches the server.
4. **Exclude today’s partial day from the WLS fit**, matching the comment in `forecasting.ts` 91–93.
5. **Render project `projectedEomUsd` and `daysUntilBudgetExhausted`** in `ProjectsPanel` / `ProjectTable`.  The API already computes them.
6. **Fix the request-limit hysteresis** by passing the prior request tier, or delete the comment.
7. **Say linear vs trend on the EOM modal.**  One word.  Operators should know which model they are looking at.

### Upgrade next (product outcomes)

8. **Persist daily forecast snapshots** and a month-end scorecard.  No new model until MAPE exists.
9. **Last-month overlay on the pace chart.**  Keep even-spend as the policy line; add last month as the empirical line.
10. **LLM remaining-days** from `usdPerHour` and remaining budget (and, for Claude, remaining block if a producer ever sends it).  Show `paceRatio`.  Label the card “analytics, not cash” next to the chip, not only in the footer.
11. **Weekday-aware anomaly baseline** and a down-direction “ingest went quiet” check for push-primary providers.
12. **Recon coverage classes.**  `subset_expected` vs `full_org` so a 40% push share is not a 5% discrepancy.
13. **Days-until-R2-70%** for Class A/B, and a quieter first-48h pace rule (withhold or raise the floor) so the kill switch cannot trip on a few ListObjects.
14. **One “what should I do” row on Attention** that already exists for edit-budget, plus an explicit “this cannot stop the vendor” line on `key_disable_recommended`.  Do not pretend pause-poll is a cost control.

### Do not do

- Do not auto-pause polling as a cost save.  The 2026-07 owner review (PR #623) was right: blinding ≠ saving.
- Do not feed LLM burn or Claude derived cost into `spentUsd`.  Two books of money is correct.  The gap is that the UI does not put them on one decision row.
- Do not add Holt/SES/Prophet before a scorecard.  The linear model’s bias is diagnosable.  A fancier model without MAPE is another untested number on the hero.

---

## What is already strong

Do not regress these.

- Receipt cash is funding, not spend (S2).  EOM floors at observed usage so a top-up cannot fabricate a breach.
- Unknown portfolio spend is no longer coerced to $0.  Coverage chips exist.  The 2026-07-20 P0 #1 is largely closed.
- Series gate of 5 **nonzero** days is the right defense against mid-month first-snapshot 3× fabrication.
- MAD over mean+stdev is the right robust choice; the file’s breakdown-point comment is correct.
- Reconciliation vocabulary (`ok` / `discrepancy` / `unverifiable` / `pending`) after PR #1131 is honest.  Zero telemetry is not a 100% delta.
- LLM burn and Claude cost-check stay out of cash.  The footers are clear.
- R2 storage vs ops kill asymmetry is intentional and documented: stock vs flow.
- Runout copy is labeled informational, not an alert.
- Budget-control auto-pause was rejected in writing.  Keep it that way.

---

## Prior audit delta (2026-07-20)

| 2026-07-20 | 2026-08-17 |
|------------|------------|
| Series forecast unused | Used on provider cash after 5 nonzero days.  Still unused on projects, families, alerts, Local. |
| Anomalies poll-only | Push + prior-month rollups exist.  Operator still sees a message, not a last-month chart. |
| Unknown as $0 | Mostly closed on hero / providers API. |
| Receipts in `max()` | Closed. |
| iOS project/provider mix | Closed on remote Overview.  iOS vs web **budget denominator** remains. |
| Breach messages diagnostic only | Edit-budget deep-links exist.  Pause-spend still does not. |
| Plan fixed + Subscription double-count | Still warning-only. |
| Complementary-channel undercount | Still true. |
| No forecast-vs-actual | Still true.  This is now the main statistical gap. |

---

## Does the product drive useful cost decisions?

**Raise or set a budget.**  Yes, if the operator will leave Overview for Settings.  Attention primary actions deep-link.  That is a real path.

**Investigate a discrepancy.**  Yes, read-only.  Provider Spend reconciliation, OpenRouter “N disagreeing,” Claude drift chips.  No accept / correct / open-producer action.

**Stay on a free tier.**  Yes for R2 (and it will stop writes).  No for LLM free tiers or “stay on Haiku.”  Backblaze 10 GB is a caveat string.

**Pause spend.**  No.  Pause poll hides the meter.  Pause subscription stops *this app’s* materialized fee.  The vendor keeps charging.

**Switch provider or model.**  No surface.

**Believe last month’s forecast.**  There is nothing to believe.  The number was never scored.

For a single-operator fleet this is still useful: Jay can see which provider is loud, raise a cap, and keep R2 off the paid tier.  It is not yet a system that knows whether its own advice was any good.

---

## Sources consulted

- Source control (`git log` on `forecasting.ts`, `llm-burn.ts`, `anomaly-detection.ts`, `provider-usage-reconciliation.ts`, `budget-status.ts`): #620 (anomaly + forecasting), #769 / #770 (series EOM), #841 (spending-intelligence S2/S4/S9), #860 (LLM burn), #1131 (Twilio unverifiable).  PR bodies were not re-fetched; Github MCP was down this run.  `gh` was available and used only for repo identity.
- Long-form docs: `docs/audits/2026-07-20-grok3-full-app-expert-review.md`, `docs/rollouts/2026-07-30-llm-burn-windows.md`, `docs/rollouts/2026-08-12-pagerduty-alert-correctness.md`, `docs/rollouts/2026-07-19-usage-compliance-reconciliation.md`, `docs/EFFORT-LOG.md` (R2 kill stickiness).
- Real-time chat (Slack `#ag***-s**c`): no historical thread on these models.  Today’s reservation and keepout vs the providers-accuracy lane are the only hits.
- Issue tracker: Github MCP unavailable.  Gap: ticket-level forcing functions for 0.8 / 3.5σ / 70% were not searchable as issues.
- Infrastructure observability / error tracking / product analytics warehouse: no matching MCP in this environment.  Live MAPE cannot be computed here.  Thresholds are code constants, not monitor-backed.

---

## What we don’t know

- Whether Socratic Trade (or anyone) actually throttles on `projectedStatus`.  This repo only documents the field.
- Live month-end forecast error.  No snapshots, no warehouse, no production query in this audit.
- Why cash uses 1-based `currentDay` (15th noon = halfway).  The test treats it as intended.  No design note says why it should differ from LLM burn’s true elapsed fraction.
- Whether the ⅓ lower clamp is a deliberate “never trust a crash” policy or leftover caution from #620.
- How often R2 Class A pace would have killed in the first 48 hours of a month if the 0.02 floor were removed.  Needs live GraphQL history this environment does not have.
- Whether operators use Attention deep-links.  No product analytics.

Those last four are the reason the recommended metrics exist.  The code can be argued from the repo.  Whether the product works cannot.
