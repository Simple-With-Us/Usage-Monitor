# Usage Monitor — Full-App Review (2026-07-28)

Six parallel audit lanes, all findings verified against code at `main@bd8accbb`. Each finding cites exact evidence. Lanes: spending intelligence, web/mobile UX, iOS parity, cross-app interop, code efficiency/performance, architecture/ops/security.

## Cross-cutting top actions (ranked across all lanes)

1. **Fix Render-vs-Oracle documentation drift** — `DEPLOY.md` is 100% Render runbook; production is Oracle. `AGENTS.md:286`, `AGENTS.md:257`, `README.md:56-57,63` all contradict `AGENTS.md:3`. Any agent following the docs would attempt the wrong deploy.
2. **Project budgets are alert-blind** — per-project `warning/exceeded` status is computed but never delivered; anomaly detection is provider-only. A single project can 10× spend silently until the provider-level budget trips.
3. **Receipt-cash floor can fabricate a budget breach** — `budget-status.ts:1251-1254`: a $500 top-up with $12 usage projects $500 EOM and flips `projectedStatus` to `exceeded`, misleading throttle consumers.
4. **Uncached `usage-events` summary scan + single-connection SQLite** — the two most likely next production incidents: a ~336k-row JS fold re-run every 60s uncached, and an ~11.4s MTD groupBy stalling all DB work (including ingest writes) on `connection_limit=1`.
5. **PWA is dead code + iOS Safari input zoom** — `PwaRegistration` is imported nowhere (app not installable/offline), and every form input uses `text-sm` (14px), triggering iOS focus zoom in the Add Provider/Subscription modals.
6. **The app has no error reporting of its own** — no `@sentry/*` SDK anywhere in `src/`; it reads other projects' Sentry health but a crash-looping route is visible only in `journalctl` on the Oracle host.
7. **Verify `USAGE_READ_TOKEN` is set in production** — code denies the ingest-token fallback in production; AGENTS.md/DEPLOY.md still claim the fallback. If the Oracle env lacks it, every bearer consumer is 503ing right now.
8. **iOS: ship or strip push** — `POST /api/devices` doesn't exist server-side; background alerts require a bearer token; the APNs scaffold is dead without a server half.
9. **Shared 10 rps ingest rate bucket across all producers** — limiter runs pre-auth and keys on Cloudflare's shared egress IP; one producer's burst 429s everyone. The login route already solved this pattern.
10. **Wire the half-built trend forecasting** — `dailyIncrementsFromSnapshotPeaks`/`maxDailySeries` are tested with zero production callers; poll-primary providers (the majority) still get naive linear EOM projection.

---

## 1. Spending intelligence

**What exists today:** 15-min scheduler tick; budget alerts at static 80%/100% with delivery-only hysteresis; MAD-based anomaly detection (3.5σ warn / 5σ critical, 14-day window); four delivery channels (Slack/webhook/email/PagerDuty) with genuinely sophisticated incident dedup, evidence watermarks, and claim leases; naive linear EOM forecast everywhere, recency-weighted trend fit only on the push channel.

| # | Finding | Sev | Evidence |
|---|---|---|---|
| S1 | Project budgets alert-blind: no notifications, no per-project anomaly detection, `unassignedSpentUsd` computed but never alerted | High | `alert-delivery.ts` has zero project references; `anomaly-loader.ts:104-153` keyed by `providerId` only |
| S2 | Receipt-cash projection floor fabricates breaches after top-ups | High | `budget-status.ts:1251-1254`, duplicated at `provider-money-aggregation.ts:143-149` |
| S3 | Poll-channel anomaly detection silently starves at scale: one global `take: 20_000` across all providers; any provider moved to 15-min polling degrades the whole fleet with no warning | Med | `anomaly-loader.ts:15,72-82` |
| S4 | Trend forecasting half-wired: `dailyIncrementsFromSnapshotPeaks`/`maxDailySeries` exported, tested, zero production callers; poll providers stuck on linear projection | Med | `daily-usage-series.ts:111-153`, `budget-status.ts:1242-1250` |
| S5 | Push-channel anomaly baseline is MTD-only → Anthropic (likely largest spend) can't anomaly-alert before ~day 9 of any month | Med | `anomaly-loader.ts:139-146`, `anomaly-detection.ts:109,266` |
| S6 | Two money-aggregation implementations drift: dashboard KPI (`aggregateProviderPortfolioMoney`) vs budget-status (`reconcileFixedCosts`); linked subscriptions + charge corrections show different totals | Med | `budget-status.ts:389-472` vs `provider-money-aggregation.ts:124-140` |
| S7 | Anomaly observed point is a partial day vs full-day baselines (false negatives at 00:30 UTC, false positives for morning-heavy providers) | Med | `anomaly-loader.ts:88-153`, `anomaly-detection.ts:261-272` |
| S8 | Non-USD subscriptions materialize as USD with no conversion or warning | Med | `subscription-materializer.ts:131` |
| S9 | No budget runout date / burn rate anywhere, despite all inputs existing | Med (gap) | grep `runout|burn.?rate|runway` → comments only |
| S10 | `projectedStatus` computed, returned, never rendered in UI | Low | zero refs in `src/components` |
| S11 | Hysteresis is delivery-only; dashboard and `/api/budget-status` flap at 80%/100% | Low | `budget-status.ts:1259-1277` vs `alert-delivery.ts:2142-2143` |
| S12 | Alert fatigue controls minimal: no snooze/mute/digest/per-code routing; one global `minSeverity` | Low | `alert-delivery.ts:172-210` |
| S13 | Month-straddle exclusion hides mid-month-cycle providers from budgets | Low | `budget-status.ts:789-806`, `adapters/apify.ts:72-76` |
| S14 | Missing joins over existing data: unused-subscription detection, provider-side price-change alerts, duplicate-subscription warnings, request-count anomalies on push channel | Low (gaps) | all verified absent |

**Sound (verified):** `max()` poll/push merge under documented assumptions; materializer idempotency; UTC month boundaries; `reconcileFixedCosts` dedup; fail-open unknown-spend handling.

## 2. Web & mobile UX

**Verdict:** mobile is genuinely real — a dedicated card-stacking `.responsive-table` system with `data-label` cells (`globals.css:20-108`), hamburger nav with aria attributes, 44px table action buttons. The gaps are specific:

| # | Finding | Sev | Evidence |
|---|---|---|---|
| U1 | PWA dead: `PwaRegistration` imported nowhere; no SW registers → not installable, no offline. Manifest `theme_color #111827` mismatches light default UI | High | `PwaRegistration.tsx:10-31`, `layout.tsx:30-61` |
| U2 | Display-density preference has no UI; `setStoredDisplayDensity` has zero callers; everyone locked to compact; three stale comments point at phantom toggles | High | `display-density.ts:20,45-56,60`, `globals.css:130-135` |
| U3 | All form inputs `text-sm` (14px) → iOS Safari auto-zoom on focus; only login gets `text-base` right | High | `AddProviderModal.tsx:1112+`, `AddSubscriptionModal.tsx:612+` vs `login/page.tsx:72` |
| U4 | Cost-coverage legend is hover-only on touch devices | Med | `CostCoverageLegend.tsx:46-56` |
| U5 | "Edit budget" link in Attention panel duplicates "Open provider" — same href, promised affordance doesn't exist | Med | `DashboardAttentionPanel.tsx:51-62` |
| U6 | Touch targets <44px on filter chips, drawer close, modal footers | Med | `DashboardProviderWorkspace.tsx:553-559`, `ProviderIntegrationDrawer.tsx:293` |
| U7 | 9+ divergent inline currency formatters; inconsistent fraction digits and null-state vocab (`--` / `Cost not reported` / `Not reported` / `Never`…) | Med | `DashboardProviderWorkspace.tsx:276-293`, `ProviderTable.tsx:242-249`, +7 more |
| U8 | Status-badge vocabularies drift between `SubscriptionsPanel` and `PaidServicesPanel` (22 keys incl. `cancelled` vs `canceled`); provenance labels have no legend | Med | `SubscriptionsPanel.tsx:45-58` vs `PaidServicesPanel.tsx:24-53` |
| U9 | OTLP invisible as a concept anywhere in UI; settings explainer covers sync/push/manual but not the third ingest path | Low | `settings/page.tsx:528-554` |
| U10 | Two divergent dialog primitives (`ModalDialog` vs hand-rolled drawer focus trap) | Low | `ModalDialog.tsx` vs `ProviderIntegrationDrawer.tsx:218-255` |

**Quick wins:** mount `<PwaRegistration/>`; `text-base sm:text-sm` on all inputs; fix "Edit budget" link; extract one `src/lib/format.ts`; disclosure-ize the legend chips; add/delete density toggle; `min-h-11` on small controls.
**Structural:** unified dialog primitive, consolidated status/provenance maps, first-run checklist, deep-linkable edit flows (`/settings?tab=connections&edit=<id>`).

## 3. iOS parity

**Verdict:** genuinely well-engineered native SwiftUI app (SPM `UsageMonitorKit`, 14 targets, WidgetKit extension, iPhone+iPad). **Nothing is decode-broken against the current web API** — every endpoint call verified correct, Codable subsets safely ignore new server fields. Auth model (dual credential, verify-before-persist, cookie hygiene) is exemplary; offline cache, error taxonomy, and staleness handling are ahead of the web in places.

| # | Finding | Sev | Evidence |
|---|---|---|---|
| I1 | Push is local-only: server `/api/devices` doesn't exist; BG-refresh alerts require bearer token (dashboard-session-only users get no background anything); `aps-environment: production` in tracked entitlements breaks debug APNs | High | `APIClient.swift:97-115`, `BackgroundRefreshManager.swift:101`, `UsageMonitor.entitlements:9-10` |
| I2 | Read-depth gap: no real history charts (synthesized linear pace curve only), no external billing records, no telemetry/operations/Sentry/key-attribution surfaces — where most of the web's money-explanation value lives | High | `ProviderDetailView.swift:234-255` vs `providers/[id]/page.tsx` |
| I3 | "Key preview" card masks the provider's database cuid and presents it as an API key | Med | `ProviderDetailView.swift:319` (real `keyPreview` exists in `ProviderManagementItem`) |
| I4 | Project CRUD disabled on stale rationale ("no bearer-reachable mutation API") — but the app now holds a dashboard session; `LocalProjectBudgetStore`/`ProjectBudgetEditView` are dead code | Med | `ProjectBudgetsRootView.swift:42,58`, `ProjectBudgetEditing.swift:8-16` |
| I5 | Subscription management pause-only; pausing an `externalBillingManaged` row silently relinquishes auto-management server-side with no warning | Med | `APIClient.swift:216-226`, `subscriptions/[id]/route.ts:296-298` |
| I6 | Provider mutations limited to `isActive` + `monthlyBudgetUsd`; web edits full plan, credentials, allocations, fetch-now | Med | `APIClient.swift:183-214` |
| I7 | New server alert codes (`budget_control_paused`, `key_disable_recommended`, anomalies) render as raw fallback text | Low | `ProviderAlert.swift:44-78` |
| I8 | `cadenceLabel` produces "every 3 monthlys" | Low | `Subscription.swift:112-115` |
| I9 | `sessionStatus()` probes with the heaviest endpoint in the app (`?view=dashboard`, documented OOM contributor) on every Settings appear | Low | `APIClient.swift:151-160`, `providers/route.ts:63-72` |
| I10 | Widget can show days-old data with no staleness indicator if app/BG task never runs | Low | `UsageMonitorWidgetBundle.swift:51-60` |

**iOS ahead of web:** offline-first paint with staleness labels, dedicated server-health section, recently-resolved alert tracker, Face ID lock, home-screen widget.

## 4. Cross-app interop

**Strong:** shared-schema v2 with byte-for-byte idempotency and explicit ACKs; bounded streaming reads; typed producer client in `@jaywedgeworth22/congress-trading-shared#v2.3.0`; receipt-cash isolation (distinct token + HMAC); 415 with actionable gRPC message.

| # | Finding | Sev | Evidence |
|---|---|---|---|
| X1 | One shared 10 rps rate bucket for all producers, keyed on Cloudflare's shared egress IP, checked pre-auth → bursts or bad-token hammering 429s everyone. Login route already solved this | High | `ingest/usage/route.ts:46,114-121`, `rate-limit.ts:130-151` |
| X2 | `receiver_busy` 503 relies on producer retry discipline the shared client doesn't provide (no retry, no documented outbox requirement) — fire-and-forget producers silently lose events | Med | `ingest-admission.ts:133-145`, shared `dist/index.js:1005-1048` |
| X3 | Read-token confusion: reads take the header named `x-usage-ingest-token`; AGENTS.md claims unconditional fallback that production code denies | Med | `ingest-auth.ts:47-66`, AGENTS.md:43-44,264-265 |
| X4 | Read surface unversioned, auth-inconsistent (budget-status middleware-public vs subscriptions middleware-excluded), no OpenAPI/examples; `usage-events?raw=1` (natural "did my events land?" debug) is session-only | Med | `middleware.ts:21-33`, both routes |
| X5 | Batch validation all-or-nothing: one poison event of 100 fails the batch with a Zod-blob message; ACK's `rejected` field hardcoded 0 | Med | `usage-telemetry.ts:143-176`, `route.ts:149-156,310-326` |
| X6 | Non-collision persistence failures escape as untyped HTML 500s instead of contract `internal_error` | Low | `route.ts:294-299` |
| X7 | v1 ACK under-reports replays (`accepted: 0` on full replay) | Low | `route.ts:328-335` |
| X8 | Stale `safari-extension/API Usage Monitor Safari/` empty skeleton | Low | — |
| X9 | Rollout doc records `#v2.0.0` pin; package.json now `#v2.3.0` | Low | `docs/rollouts/2026-07-21-usage-telemetry-v2.md:7-8` |

**Opportunities:** producer breach webhooks (alert-delivery machinery already exists); typed read-side client; per-producer tokens (enables per-producer rate limits + revocation); read-token access to `usage-events?raw=1`.

## 5. Code efficiency / performance

| # | Finding | Sev | Evidence |
|---|---|---|---|
| E1 | `summarizeExternalUsageEvents` re-aggregates the whole raw month in JS (~336k rows, ~336 cursor round trips), uncached, fired every 60s while portfolio panel open | High | `external-usage-events.ts:499-574`, `useDashboardData.ts:399-410` |
| E2 | `connection_limit=1` + ~11.4s MTD groupBy every ~60s stalls all DB work incl. ingest writes (exporters time out and retry, amplifying load); no explicit WAL pragma anywhere | High | `prisma.ts:46-50`, `external-usage-events.ts:1032-1041`, `instrumentation.ts:40-49` |
| E3 | Duplicate full-month scans per cold budget compute (direct + anomaly loader), with per-row O(candidates) regex identity resolution | Med-High | `budget-status.ts:992-996`, `anomaly-loader.ts:85`, `provider-identity.ts:89-114` |
| E4 | Every 15-min poll re-selects `rawData` blobs for all providers — the exact pattern removed elsewhere after the #392 OOM | Med | `usage-recorder.ts:266-275,314-328` |
| E5 | Sequential poll loop: worst-case tick ≈ 39 × 90s ≫ 15-min cadence; no total-tick budget | Med-Low | `usage-recorder.ts:292-440` |
| E6 | Duplication: `serverConfig` ×3, `monthStartUtc` ×2, status-metric constants ×2, empty-bucket literal ×2; giant modules (`alert-delivery.ts` 2,917 lines, `infisical-provider-sync.ts` 2,690, `budget-status.ts` 2,185) | Med | — |
| E7 | Dead deps: `uuid` (zero imports), `postal-mime` (worker-only but in root deps), `pg` (one-shot migration script only); lint config minimal (no unused-export/import-cycle rules) | Low | `package.json` |

**Root fix recommended:** persisted scheduler-maintained MTD aggregate table (the `ExternalUsageEventDailyRollup` infra is the natural substrate) so no request path ever runs the 11s query; then WAL + `connection_limit=2` with per-connection pragma verification.

## 6. Architecture / ops / security / hygiene

| # | Finding | Sev | Evidence |
|---|---|---|---|
| O1 | Render-vs-Oracle docs drift (see top action #1) | High | `DEPLOY.md`, `AGENTS.md:257,286`, `README.md:56-57,63` |
| O2 | `USAGE_READ_TOKEN` prod unverifiable + docs contradict code (see top action #7) | Med | `ingest-auth.ts:47-58`, `instrumentation.ts:31-38`, `render.yaml:89-94` |
| O3 | Outdated majors accumulating: eslint 8→10, next 15.5→16.2, prisma 6→7.9, tailwind 3→4; Dependabot group covers minor/patch only | Med | `npm outdated` verified 2026-07-28 |
| O4 | No self error-reporting (see top action #6) | Med | no `@sentry/*` in package.json or `src/` |
| O5 | Startup readiness check inert on Oracle (`required: RENDER === "true"` always false) — steady-state monitors can't catch a wrong entrypoint | Med | `runtime-health.ts:387-398` |
| O6 | No steady-state `/data` disk-capacity monitoring between deploys | Med | deploy preflight-only, `deploy-production.sh:38-39` |
| O7 | 394 MB stray temp DBs at repo root + broad `COPY . .` in Dockerfile + 3 untracked prod-mutation scripts | Med | `temp_large*.db` (197MB each, untracked), `Dockerfile:13` |
| O8 | Duplicate "Cursor Cloud specific instructions" sections in AGENTS.md | Low | `AGENTS.md:288-310` and `342-360` |
| O9 | STATUS.md/PLAN.md describe an unmerged side branch; stale | Low | `STATUS.md:7-8,42-44` |
| O10 | Render-era runtime shims/comments: readiness compat flag, proxy-topology comments naming Render instead of Caddy, `RENDER_SERVICE_NAME` identity | Low | `ready/route.ts:~257-262`, `rate-limit.ts:124-209` |
| O11 | `/api/ready` publicly exposes exact revision + scheduler/backup detail (deliberate; minor patch-level disclosure) | Low | `ready/route.ts:~285-330` |
| O12 | Tombstone table grows forever by design (correct for idempotency) but unmonitored | Low | `data-retention.ts:946-953` |

**Exceptionally solid (preserve):** the 1,114-line deploy transaction (exact-SHA provenance gating, scratch-DB migration rehearsal, TXID-watermark backup verification, authenticated restore with integrity comparison on every deploy); layered backups (pre-migration snapshots → deploy backups → Litestream PITR with 15-min external verification and weekly restore drills); auth/crypto (HKDF session keys, timing-safe compares, AES-256-GCM, nonce CSP); uptime pipeline's conclusion-equals-probe invariant.

**Missing capabilities grounded in what exists:** no data export endpoint (daily rollups make it cheap); no self-metrics endpoint (admission/scheduler counters already counted); no mutation audit trail for owner-initiated edits (`BudgetControlEvent` covers only automated actions); no per-session revocation (documented trade-off).

---

## Suggested sequencing

**This week (quick wins, low risk):** top actions 1, 4-quick-win (SQL groupBy swap + WAL pragma), 5 (PWA mount + input font sizes), 7 (verify prod token); U5 link fix; X3 docs fix; O7 cleanup; I3 key-preview bug.

**Next (1-3 days each):** S2 receipt floor; S4 forecast wiring; S1 project alerting (anomaly loader group-by-projectId + alert codes through existing delivery); X1 rate-limit keying; E1/E2 rollup table; I2 provider-detail depth via existing session-gated routes.

**Structural:** S6 single money-math source; X2 shared-client retry/outbox + per-event rejections; X4 versioned read surface + OpenAPI; I1 push server half; O4 self-Sentry; E6 module splits.
