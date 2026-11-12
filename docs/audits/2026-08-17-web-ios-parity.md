# Usage Monitor — desktop / mobile web ↔ native iOS parity audit

**Date:** 2026-08-17  
**Owner:** Cursor (Grok) — read-only expert panel  
**Branch:** `cursor/web-ios-parity-audit-fc87`  
**Method:** Static review of `main` at `8db78b5`.  Lanes: desktop/mobile web UX, iOS Client + Local engineering, accessibility, data visualization, product QA, TestFlight readiness, and tests.  No production probes and no product-code edits.

> **[ARCHAEOLOGY / pre-2026-09-22]**  Bundle IDs `services.jays.usage.*` referenced below are the pre-2026-09-22 fleet-wide bundle-ID state and have not been retconned.  Canonical IDs after the fleet-wide rename: `com.simplewithus.usagemonitor.ios` (Client), `com.simplewithus.usagemonitor.local.ios` (Local), App Group `group.com.simplewithus.usagemonitor`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

**Surfaces:** Next.js web (`usage.jays.services`) at desktop and iPhone Safari / PWA widths; **Usage Client Monitor** (`services.jays.usage.client.monitor`); **Usage Local Monitor** (`services.jays.usage.local.monitor`).

**Prior review:** [`docs/audits/2026-07-20-grok3-full-app-expert-review.md`](2026-07-20-grok3-full-app-expert-review.md).  This pass checks what that review asked for against the code that shipped in the following four weeks.

---

## Verdict

The **Client iOS app is a real companion**, not a thin status widget.  Overview, Providers, Alerts, Projects, Platforms, Server, Computers, Settings, App Lock, offline cache, and the Home Screen widget share the same `GET /api/budget-status` money feed as the website.  The July 20 iOS hero bug (project budget mixed with provider spend) is **fixed and regression-tested**.

The remaining gap is not “iOS is unfinished.”  It is **three products with three money denominators and two filter languages**:

1. **Web Overview** meters against a **global** budget when one exists (`effectiveGlobalBudgetUsd` override or suggested).
2. **iOS Client Overview** meters against the **sum of provider** `monthlyBudgetUsd` and never reads the global-budget API.
3. **iOS Local** computes its own `BudgetEngine v1` totals (poll + subscriptions + plan fixed) with **no** push, OTLP, or receipt cash.

An owner who set a global cap on the website will see a different “percent used” and status chip on the phone.  That is the highest-value remaining trust issue.

Secondary clusters: web Mac Health is **auth-broken for dashboard sessions**; Local VoiceOver coverage is thin; TestFlight binaries are still **1.0.0 REJECTED** after the GM resubmit / INVALID_BINARY path; web charts and several overlays fail WCAG modal / reduced-motion / legend rules that iOS already handles on the money path.

**P0 count:** 0 new cash-formula defects on the server path.  
**Ship stance:** Client is TestFlight-usable for the owner with a read token.  Public App Store is **not** ready until ASC 1.0.0 leaves REJECTED and Local gets an accessibility pass.

---

## How to read this document

| Severity | Meaning |
|----------|---------|
| **P0** | Money / auth / ship-blocker.  Users can trust the wrong number or cannot review. |
| **P1** | Daily-path parity, a11y, or TestFlight gap.  Fix in the next implementation wave. |
| **P2** | Real UX or contract drift.  Schedule after P1. |
| **P3** | Polish, docs, or density. |

**Parity grades** in the matrix:

| Grade | Meaning |
|-------|---------|
| **Full** | Same job, same fields, same user outcome. |
| **Close** | Same job; presentation or filter vocabulary differs. |
| **Partial** | One surface is missing a first-class control or a mutation. |
| **Web-only / Client-only / Local-only** | Intentional or accidental absence. |
| **Honest gap** | Documented Local v1 non-parity (no live ingest / fleet ops). |

Evidence uses `path:line` against this checkout.

---

## Surfaces inventoried

### Web (one Next.js app; responsive chrome, not a second API)

| Route | Client | Job |
|-------|--------|-----|
| `/` | `src/app/page.tsx` | Overview: hero, summary, attention, provider workspace, portfolio charts, LLM burn, Claude check, projects, Sentry, ops |
| `/providers` | `ProvidersPageClient` | Same workspace as Overview |
| `/providers/[id]` | `src/app/providers/[id]/page.tsx` | Detail, `UsageChart`, balances/credits, snapshots 7/30/90/365 |
| `/money` | `MoneyPageClient` | Paid services / coverage |
| `/projects` | `ProjectsPageClient` | Project budgets |
| `/alerts` | `AlertsPageClient` | Attention list |
| `/platforms` | `PlatformsPageClient` | Fleet / R2 / peer status |
| `/ops` | `OpsPageClient` | Operations + receipt-inbox metadata |
| `/settings?tab=*` | `src/app/settings/page.tsx` | Connections, subscriptions, projects, notifications |
| `/attribution` | `KeyAttributionPanel` | Key ↔ app bindings (CRUD) |
| `/login` | password form | Session cookie |
| `/support`, `/privacy` | static | ASC legal URLs |

`ProviderCard.tsx` still exists and has unit tests, but **no production page mounts it**.  The live list is `DashboardProviderWorkspace` (families + table).

### iOS Client (remote)

Default pinned tabs: Overview, Providers, Alerts, Server.  Computers, Platforms, Projects, Settings start under **More** (`TabPreferences.defaultPinned`).

| Tab / push | Root | Job |
|------------|------|-----|
| Overview | `DashboardRootView` | Hero, EOM split, pace chart, attention, top providers, portfolio history, intelligence |
| Providers | `ProvidersRootView` | List + `ProviderDetailView`; **Money** and **Keys & Apps** as sub-routes |
| Alerts | `AlertsRootView` | Threshold list + detail |
| Server | `ServerStatusRootView` | `/api/health`, `/api/ready`, host usage |
| Computers | `ComputersRootView` | `/api/health/mac` |
| Platforms | `PlatformsRootView` | `/api/platform-status` + operations |
| Projects | `ProjectBudgetsRootView` | Server project budgets |
| Settings | `SettingsRootView` | Host, token, session, inventories, lock, theme |
| Widget | `UsageMonitorWidgetExtension` | Overall or project focus; App Lock redaction |
| App Lock | `AppLockGate` | Face ID / passcode |

### iOS Local (on-device)

Fixed `TabView`: Overview, Providers, Projects, Alerts, Settings.  **No** Server, Computers, Platforms, Intelligence, portfolio history, or WidgetKit extension.  Money truth is GRDB + `BudgetEngine v1`.  Settings owns export / merge-replace import / `.umkeys` key import.

---

## What is already strong (do not regress)

| Area | Evidence | Why it matters |
|------|----------|----------------|
| Light default | `src/app/layout.tsx:53` `defaultTheme="light"`; iOS `AppSettings.swift:67-68` | Fleet rule 2026-08-10 |
| Skip link | `src/app/layout.tsx:57-63` | WCAG 2.4.1 |
| Web modal primitive | `ModalDialog.tsx` focus trap, Escape, scroll lock | Reuse this everywhere |
| Workspace a11y | `DashboardProviderWorkspace` caption, `aria-sort`, `aria-pressed` chips, URL `?filter=` / `?q=` | Shareable filters |
| Snapshot range | Web select **and** iOS `SnapshotHistoryRange` are **7 / 30 / 90 / 365** | True parity (July 20 docs were stale) |
| iOS hero money scope | `DashboardViewData.swift:25-37` + `DashboardViewDataTests` | July 20 P0 (project vs provider mix) is gone |
| iOS Reduce Motion on money | `DashboardHeroCard`, `SpendPaceChart`, Alerts, Providers | Web has **none** |
| Inline nav titles | Every Client/Local root uses `.navigationBarTitleDisplayMode(.inline)` | Fleet UI copy |
| Offline + widget | Account-scoped disk cache; widget snapshot sink; 30 min timeline | Client daily driver |
| List vs empty | `ListLoadErrorPanel` / iOS `BudgetErrorState` | Outage ≠ “nothing configured” |
| Receipt inbox isolation | Ops metadata only; HMAC importer is not a dashboard button | Email cannot mint spend |
| Local key import | `.umkeys` + `LocalKeysImportTests` | Phone-only product path |
| Dual-app identity | Distinct bundle IDs, app groups, deep links | App Store / TestFlight |

---

## Parity matrix

Legend: **W-D** web desktop · **W-M** web mobile / PWA · **C** iOS Client · **L** iOS Local.

| Feature | W-D | W-M | C | L | Grade | API / store | Tests | Notes |
|---------|-----|-----|---|---|-------|-------------|-------|-------|
| Overview hero MTD spend | Yes | Yes | Yes | Yes | **Close** | Web: family aggregator + `spentUsd ?? null`.  Client: `Σ spentUsd` (`Double`).  Local: engine | `DashboardHero.test.ts`, `DashboardViewDataTests` | Same job; **different spend and budget basis** (F-01, F-02) |
| Hero budget meter | Global override → else Σ provider plans | same | **Σ provider budgets only** | Local budgets | **Partial** | Web `GET/PUT /api/settings/global-budget`.  iOS does not call it | Web modal only | Client caption: “Across N provider budgets” (`DashboardHeroCard.swift:113-124`) |
| EOM projection + split | Modal | Modal | Card on Overview | Detail / overview parts | **Close** | Server composition on Client; Local engine | `ProjectedCostBreakdownModal`; iOS view-data tests | Web modal lacks focus trap (F-12) |
| Provider workspace / list | Family table + chips | Card CSS + chips | Native list + chips | Catalog list | **Close** | Web also `GET /api/providers?view=dashboard`.  Client list from `BudgetStore` | Workspace + `ProvidersFeatureTests` | **Filter vocab differs** (F-03) |
| Provider detail | Full | Full | Full when session | Local detail | **Close** | `GET /api/providers/:id`, `GET /api/snapshots` | `providers/[id]/page.test.ts`, `ManagementAPIClientTests` | Range 7/30/90/365 on **both** |
| Balances / credits | `BalanceBadge` + credits tile | same | Settings inventory; **not** detail | Stored; **not** shown | **Partial** | Snapshot `balance` / `credits` | `ProviderCard.test.ts` (unused card) | Color-only badge (F-14); Local silent (F-15) |
| Paid services / Money | `/money` | `/money` | Providers → Money | Recurring card | **Close** | `GET /api/subscriptions` + providers | `PaidServicesPanel.test.ts`, `MoneyScreenTests` | Web uses non-dashboard `GET /api/providers` |
| Projects | `/projects` + residual % | same | Projects tab | Direct only | **Partial** | `budget-status.projects` + CRUD | `ProjectsPanel.test.ts`, `ProjectBudgetsTests` | Local: no residual allocation (honest) |
| Alerts | `/alerts` | `/alerts` | Alerts tab | Local thresholds | **Close** | `budget-status` alerts | Attention + `AlertsResolutionTests` | Local: no PD / Slack |
| Portfolio / telemetry charts | Recharts pie + burn | same | Swift Charts pace + history | Sparkline only | **Partial** | `GET /api/usage-events` | `DashboardCharts.test.ts`, `SpendBurnChart.test.ts` | Local honest gap; web pie a11y (F-10) |
| Timeframe (history) | `HistoryWindowControl` 1/7/30/90/180/all + calendar | same | `TimeframeOption` same semantics | — | **Full** | `days` / `from`/`to` | No cross-stack golden URL test (T-08) | Hero MTD stays current UTC month on both |
| LLM burn / Claude check | Overview cards | Overview | Intelligence section | — | **Partial** | `GET /api/llm-burn`, `GET /api/claude-cost-check` | `llm-burn.test.ts` | Local honest; Client Intelligence unlabeled (F-16) |
| Key attribution | `/attribution` CRUD | same + zoom risk | Keys & Apps **GET only** | `.umkeys` import | **Partial** | `/api/key-attribution` | Route tests + `KeysAndAppsScreenTests` | Different jobs (bindings vs device keys) |
| Imports | Ops receipt **metadata**; HMAC is private | same | None | JSON + `.umkeys` | **Honest / Local-only** | Ingest + worker | `local-keys-bundle.test.ts`, `LocalKeysImportTests` | No web “Import Keys” button (by design) |
| Platforms | `/platforms` | `/platforms` | Platforms tab | — | **Close** | `GET /api/platform-status` | `platform-status-*.test.ts` | |
| Ops / receipt inbox | `/ops` + Overview embed | same | Platforms ops section | — | **Close** | `GET /api/operations` | `OperationsOverview.test.ts` | Web always polls (F-22) |
| Sentry Health | Overview card | Overview | — | — | **Web-only** | `GET /api/sentry-health` | `sentry-health.test.ts` | Session-only |
| Server liveness | Implicit in ops | same | **Server tab** | — | **Client-only** | `GET /api/health`, `/api/ready` | `ServerStatusFeatureTests` | First-class on phone |
| Mac / Computers | `MacHealthCard` in ops | same | **Computers tab** | — | **Partial** | `GET /api/health/mac` | `MacHealthTests` (thin) | Route is **bearer-only** (F-04) |
| Host metrics | Ops | Ops | Server + Platforms | — | **Full** | `GET /api/server-metrics` dual-auth | `server-metrics.test.ts` | Contrast with mac route |
| Global budget edit | Overview modal | Overview modal | — | — | **Web-only** | `/api/settings/global-budget` | — | Drives web hero (F-01) |
| Notifications settings | Settings tab | Settings | — | — | **Web-only** | `GET/PUT /api/settings` | — | Client has APNs register, not this panel |
| Provider / subscription **create** | Settings | Settings | — | Local CRUD | **Partial** | Session POST | Settings / Local tests | Client can pause/edit/delete, not create |
| Fetch now | Settings | Settings | Settings inventory | Local poll | **Close** | `POST /api/providers/:id/fetch` | Management tests | Session-only on Client |
| Navigation IA | 8 primary + More + ⌘K | Hamburger + search | 4 pinned + More sheet | 5 fixed tabs | **Close** | — | `TabPreferencesTests` | Names align (Overview / Providers / …) |
| Command palette | Yes | Nav search button | — | — | **Web-only** | — | — | Incomplete listbox a11y (F-18) |
| Theme Light / Dark / System | Nav prefs | Nav prefs | Settings | Settings | **Full** | Local persistence | — | Light default both |
| Display density | Web only | Web only | — | — | **Web-only** | `display-density` | — | Dual density systems remain (July 20 #9) |
| App Lock / Face ID | — | — | Yes | Yes | **iOS-only** | Keychain | AppLock tests | Correct for native |
| Offline cache | Browser HTTP cache only | same | Disk + widget | SQLite | **Client/Local** | — | `OfflineCacheTests` | |
| Home Screen widget | PWA icon only | PWA | Yes | Writer, **no extension** | **Client-only** | App group snapshot | `WidgetPresentationTests` (19) | Local writer is dead I/O (F-17) |
| Push / APNs | — | — | Register + deep link | — | **Client-only** | `POST /api/apns/device-tokens` | `PushScaffoldTests` | Entitlement in repo is `development` (TF-03) |
| Daily rollup export | API only | API only | — | — | **None** | `GET /api/export/daily-rollups` | Route tests | No UI on any client |
| Error / empty / retry | Mixed 36–44px | same | `LoadState` + Settings CTA | Red `Text` | **Partial** | — | Component tests | Local unstructured (F-19) |
| VoiceOver / SR | Partial (skip, tables, some charts) | same | Strong on money path | **Weak** | **Partial** | — | Almost no a11y asserts | F-08, F-09, F-16 |
| Reduced motion | **None** | **None** | Money / filters | Sparse | **Partial** | — | — | F-07 |
| Two-space copy | Platforms helper only | same | Mostly Client | Inconsistent | **Partial** | `FLEET-UI-COPY.md` | — | F-23 |
| TestFlight / ASC | n/a | n/a | 1.0.0 REJECTED | 1.0.0 REJECTED | **Blocked** | Ship scripts | — | TF-01 |

---

## Endpoint consumption (who actually calls what)

Auth: **S** session cookie · **B** bearer `USAGE_READ_TOKEN` · **P** public path (route may still self-gate) · **I** ingest.

| Endpoint | Auth | Web | Client | Local |
|----------|------|-----|--------|-------|
| `GET /api/budget-status` | P → S or B | Overview, Providers, Alerts, detail, burn chart | `BudgetStore` (all money tabs + widget) | Engine / GRDB |
| `GET /api/subscriptions` | P → S or B | Money, Settings, Overview | Money + Settings inventory | GRDB |
| `GET /api/providers?view=dashboard` | S | Overview / Providers / Alerts | — (budget-status list) | — |
| `GET /api/providers` | S | `/money`, Settings | — | — |
| `GET /api/providers/:id` | S | Detail | `ProviderDepthStore` | — |
| `GET /api/snapshots` | S | Detail 7/30/90/365 | Same ranges | Local history |
| `GET /api/usage-events` | S | Portfolio | `PortfolioHistoryStore` + session probe | — |
| `GET /api/llm-burn` | S | `LlmBurnCard` | `IntelligenceStore` | — |
| `GET /api/claude-cost-check` | S | Overview | Intelligence | — |
| `GET /api/key-attribution` | S | Attribution CRUD | GET only | — |
| `GET /api/operations` | P → S or B | `/ops`, Overview | Platforms | — |
| `GET /api/server-metrics` | P → S or B | Ops | Server / Platforms | — |
| `GET /api/platform-status` | P → S or B | `/platforms` | Platforms | — |
| `GET /api/sentry-health` | S | Overview | — | — |
| `GET /api/health`, `/api/ready` | P | — | Server tab | — |
| `GET /api/health/mac` | P → **B only** | `MacHealthCard` (cookie fetch) | Computers (`.read`) | — |
| `GET/PUT /api/settings/global-budget` | S | Overview modal | — | — |
| `GET/PUT /api/settings` | P → S or B (GET) | Notifications | — | — |
| `POST /api/providers`, `POST /api/subscriptions` | S | Settings | — | Local |
| `POST /api/auth/login` | P | `/login` | Full Access | — |
| `POST /api/apns/device-tokens` | P → S | — | Push scaffold | — |
| `GET /api/export/daily-rollups` | P → S or B | — | — | — |
| `POST /api/ingest/usage` (receipt HMAC) | I | — | — | — |

`isUsageReadAuthorized` (`src/lib/ingest-auth.ts:142-155`) checks **bearer / x-usage-*-token headers only**.  Dual-auth routes (`budget-status`, `server-metrics`, …) add `verifySessionToken` themselves.  `/api/health/mac` does **not**.

---

## Findings

### P1 — Fix next

**F-01 · Hero budget denominator disagrees (web global vs iOS provider sum)**  
- **Area:** Balances / projections / trust  
- **Evidence:** Web `src/app/page.tsx:208-211` prefers `globalBudget.effectiveGlobalBudgetUsd` then `providerPlanBudgetSum`.  iOS `DashboardViewData.swift:35-37` sums `monthlyBudgetUsd` only.  Client caption `DashboardHeroCard.swift:113-124` says “Across N provider budgets.”  No iOS call to `/api/settings/global-budget`.  
- **Today:** A web global override (or suggested project rollup) changes the website meter and status chip.  The phone ignores it.  
- **Fix:** Pick one account denominator and document it.  Recommended: Client Overview reads `summary.effectiveGlobalBudgetUsd` when present, keeps the provider-sum fallback, and labels the basis the same way as web (`override` / `suggested` / `provider plans`).  Add a Client Settings row to edit the global cap (session).  Golden fixture shared by `DashboardHero.test.ts` and `DashboardViewDataTests`.

**F-02 · Spend rollup disagrees (family-safe nulls vs `Σ Double`)**  
- **Area:** Provider cards / money  
- **Evidence:** Web `page.tsx:143-171` feeds `aggregateProviderPortfolioMoney` with `spentUsd: provider.spentUsd ?? null`.  iOS `BudgetStatus.swift:99` `spentUsd: Double` (decode default `0` at `128`) and `DashboardViewData.swift:32` `providers.reduce { $0 + $1.spentUsd }`.  
- **Today:** Multi-key families and unknown cost can be excluded or left null on web; iOS adds zeros and cannot show “not reported” on the hero.  
- **Fix:** Decode `spentUsd` as `Double?` on Client.  Reuse the same family aggregator (port the TS function or share JSON fixtures).  Never paint `$0.00` for unknown.

**F-03 · Provider filter chips are different products**  
- **Area:** Filters  
- **Evidence:** Web `familyMatchesFilter` (`DashboardProviderWorkspace.tsx:493-504`): `all | alerts | active | incomplete`.  iOS `ProviderFilter` (`ProvidersListModel.swift:49-97`): `all | overBudget | attention | onTrack | noBudget`.  
- **Today:** “Incomplete cost” and “active accounts” exist only on web.  “Over / On Track / No Budget” exist only on Client.  URL `?filter=` on web has no iOS equivalent.  
- **Fix:** Ship one facet set on both (recommended union: All, Alerts, Over, Warning, Incomplete, No Budget, Active).  Keep web URL sync; add Client query persistence.

**F-04 · `GET /api/health/mac` is bearer-only; web card and session-only Client fail**  
- **Area:** Navigation / Computers / error states  
- **Evidence:** Route comment claims session (`src/app/api/health/mac/route.ts:8-11`) but the handler only calls `isUsageReadAuthorized`.  That helper is header-only (`ingest-auth.ts:142-155`).  `server-metrics` correctly does session **then** bearer (`server-metrics/route.ts:21-38`).  Web `MacHealthCard.tsx:14` `fetch("/api/health/mac")` sends cookies, no bearer.  Client `APIClient.macHealth` uses `.read` (bearer if present, else cookie).  
- **Today:** Logged-in website users get a silent empty Mac card.  Client works only when a read token is stored.  
- **Fix:** Copy the `server-metrics` dual-auth block.  Add route tests for session cookie and missing token (503 vs 401).  Surface `CardUnavailableNotice` on 401 instead of a blank host.

**F-05 · `MacHealthCard` uses non-existent Tailwind tokens**  
- **Area:** Error states / visual QA  
- **Evidence:** `MacHealthCard.tsx:36-49` `border-border`, `bg-card`, `bg-muted`, `text-foreground`.  `tailwind.config.ts` does not define those shadcn aliases.  
- **Today:** Loading and empty states render as unstyled boxes vs the rest of Ops.  
- **Fix:** Use `border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800` like every other card.

**F-06 · TestFlight / App Store still blocked at 1.0.0 REJECTED**  
- **Area:** TestFlight readiness  
- **Evidence:** `docs/rollouts/2026-08-16-asc-eula.md` — versions remain `1.0.0 REJECTED`; What's New `STATE_ERROR` on first versions.  `docs/asc/APP-STORE-LISTING.md` — INVALID_BINARY on beta macOS; GM resubmit 2026-08-15.  `project.yml:40-41` marketing `1.0.0` / build `1`.  
- **Today:** Custom EULAs and beta review contacts are in.  Review is not.  
- **Fix:** Confirm Resolution Center on apps `6799230435` / `6799230729`.  Ship only from GM `Xcode.app`.  Bump to **1.0.1** so What's New can be set.  Do not treat TestFlight VALID as App Store ready.

**F-07 · Web has no `prefers-reduced-motion`**  
- **Area:** Accessibility  
- **Evidence:** Repo grep of `src/` finds no `prefers-reduced-motion`.  Animations: hero `duration-500` (`DashboardHero.tsx:120` area), Ops `animate-spin`, `MacHealthCard` pulse.  iOS money path already uses `@Environment(\.accessibilityReduceMotion)`.  
- **Fix:** Global CSS: disable transition/animation/scroll-behavior when reduced.  Skip pulse skeletons.

**F-08 · Local app VoiceOver is far behind Client**  
- **Area:** Accessibility / Local  
- **Evidence:** `LocalDataPlane` has ~2 `accessibilityLabel` hits (`LocalRootView.swift`) vs 100+ on Client money screens.  
- **Today:** Provider rows, alerts, project rollups, and filter chips are unlabeled.  
- **Fix:** Same labeling pattern as `ProvidersRootView` / `DashboardHeroCard` before any public Local App Store submit.

**F-09 · Client Computers + Intelligence lack labels**  
- **Area:** Accessibility  
- **Evidence:** `ComputersSection.swift` / `ComputersRootView.swift` — no combined labels.  `IntelligenceSection.swift` — LLM burn / Claude / keys cards unlabeled.  
- **Fix:** Combined `accessibilityLabel` + value on every status row and intelligence card.

**F-10 · Web pie chart has no text alternative**  
- **Area:** Charts  
- **Evidence:** `DashboardCharts.tsx` `PieChart` has no Recharts `accessibilityLayer` and no HTML table.  `UsageChart.tsx:58` already sets `accessibilityLayer`.  
- **Fix:** Add the layer plus a sorted “Projected EOM by family” table under the pie (same numbers the slices use).  Confirm the pie uses the **same** family aggregator as the hero (July 20 item 2).

**F-11 · Attribution inputs zoom on iPhone Safari**  
- **Area:** Mobile web / imports  
- **Evidence:** `KeyAttributionPanel.tsx:66` `text-sm` on inputs/selects.  Good pattern already exists: `AddProviderModal` / login / workspace search use `text-base sm:text-sm`.  
- **Fix:** Global form control class `text-base sm:text-sm`.  Raise action buttons to `min-h-11`.

**F-12 · Three web overlays skip `ModalDialog`**  
- **Area:** Accessibility / projections  
- **Evidence:** `ProjectedCostBreakdownModal.tsx:57-62`, `GlobalBudgetModal.tsx:77-82`, `CommandPalette.tsx:144-148` — `role="dialog"` without trap / scroll lock.  `ModalDialog.tsx:26-94` already implements the correct pattern.  
- **Fix:** Route all three through `ModalDialog` / `useDialogA11y`.

---

### P2 — Schedule after P1

**F-13 · Coverage legend is web-first; Client under-paints `spendCoverage`**  
Web `CostCoverageLegend` + workspace columns.  Client decodes `CostCoverage` but the hero only shows a generic “coverage is still syncing” string (`DashboardHeroCard.swift:138-143`).  Local has caveat codes only.  
**Fix:** Port Complete / Known / Not reported / Gap chips onto Client provider rows.

**F-14 · `BalanceBadge` is color + minus sign only**  
`BalanceBadge.tsx:19-28` — no `aria-label`.  Negative is visible as `-`, but AT users get no “balance” noun.  
**Fix:** `aria-label={`Balance ${formatted}`}` including “negative”.

**F-15 · Balance exists in Local snapshots and never renders**  
`LocalAppModel` persists `balance`; provider detail does not show it.  DeepSeek / OpenRouter balance-only polls look empty.  
**Fix:** Latest balance row + “balance-only poll” caption when abilities include `.pollBalance`.

**F-16 · Client provider detail omits prepaid balance**  
Web detail shows `BalanceBadge` + credits (`providers/[id]/page.tsx:430`, `:542`).  Client detail shows receipt cash / coverage, not `balance`.  `balance_low` alerts can fire with no number on the page.  
**Fix:** Optional balance / credits row from budget-status or depth payload.

**F-17 · Local writes widget snapshots with no WidgetKit target**  
`LocalWidgetSnapshotWriter` (`LocalWidgetSnapshot.swift:22`) from `LocalAppModel.swift:80`.  `project.yml` Local target has no widget extension.  Design doc still lists a Local widget as v1.  
**Fix:** Either add the extension (separate app group already exists) or stop writing.

**F-18 · Command palette listbox is incomplete**  
`CommandPalette.tsx:175-180` — `role="listbox"` / `option` without `aria-activedescendant` or roving tabindex.  
**Fix:** WAI-ARIA combobox or a simple menu.

**F-19 · Local errors are raw red text**  
`LocalRootView.swift` ~111–115.  Client has `BudgetErrorState` with Settings CTA.  
**Fix:** Shared `ErrorState` + Retry.

**F-20 · Touch targets under 44pt**  
Web: desktop nav `py-1.5` (`Nav.tsx:167-171`), More items `py-2`, section pills `min-h-9` (`page.tsx:480`), Settings / table actions `h-9`, `ListLoadErrorPanel` / `error.tsx` retry `py-2`.  iOS: More pin 32×32, tab icon pill 44×28 (`RootView.swift:471-478`).  
**Fix:** `min-h-11` / 44pt hit slop on every control a thumb can hit.

**F-21 · Sticky offset stack is wrong on mobile web**  
Nav is `h-14` (56px) on small screens (`Nav.tsx:138`).  Settings tabs `sticky top-16`, workspace filters `sm:top-16`, table thead `top-28`.  Hash targets use `scroll-mt-20`.  
**Fix:** `--nav-height` / `--sticky-stack` CSS variables per breakpoint.

**F-22 · Overview over-polls; Ops is not lazy**  
`useDashboardData` 60s; portfolio 60s; LlmBurn 120s; Operations 60s on mount (`OperationsOverview.tsx:952-954`) even when embedded on Overview (`page.tsx` ops block).  AGENTS.md says lazy-mount; code does not use `IntersectionObserver` or `document.hidden`.  Client Overview refreshes every 30 minutes while visible — calmer.  
**Fix:** One visibility-aware scheduler; fetch Ops only when the section is open or `/ops` is the route.

**F-23 · Two-space sentence rule is mostly unimplemented on web**  
`docs/FLEET-UI-COPY.md:66-80`.  Platforms has a helper (`PlatformsPageClient.tsx:24-37`).  Most dashboard strings are single-spaced (e.g. `page.tsx:431-433`, projection modal `:74-76`).  Client is closer; Local is mixed.  
**Fix:** Shared `withSentenceGaps` for multi-sentence UI copy.  Editorial pass on Local.

**F-24 · LlmBurnCard fails closed to nothing**  
`LlmBurnCard.tsx:114-126` — error or `!data.ok` returns `null`.  Sentry / Claude use `CardUnavailableNotice`.  
**Fix:** Same unavailable pattern + retry.

**F-25 · SpendBurnChart / UsageChart legends**  
Burn series share one orange (solid vs dash) with no legend (`SpendBurnChart.tsx:337-358`).  UsageChart names live in the tooltip / a11y layer only.  Dual Y-axis (USD + credits) is heavy on a phone.  
**Fix:** Visible legend; credits toggle on narrow viewports; non-color cue (dash + label).

**F-26 · Client cannot create providers or subscriptions**  
Web Settings POST.  Client inventory can pause / edit / delete.  Local can create.  
**Fix:** Session-gated create sheets, or a single “Add on the website” empty state that deep-links `/settings`.

**F-27 · Key attribution mutations are web-only**  
`KeyAttributionPanel` POST/PUT/DELETE.  `KeysAndAppsScreen` is GET.  
**Fix:** Accept as Client v1, or add bind/unbind when a dashboard session exists.

**F-28 · Sentry Health and notification settings have no Client home**  
Web-only cards/panels.  Fine if Server/Platforms stay the ops home — say so in Settings.  
**Fix:** Either port or link “Open on website” when session is live.

**F-29 · PWA install banner can cover the last card**  
`PwaRegistration.tsx:71` fixed bottom `z-70`.  Main has safe-area padding, not banner height.  
**Fix:** Extra `padding-bottom` while the banner is visible.

**F-30 · ARCHITECTURE-CONTRACT tab count is stale**  
Contract still describes an older tab set; code has **8** destinations including Computers (`RootView.swift:10-18`, rollout `docs/rollouts/2026-08-16-ios-computers-tab.md`).  Design doc still cites legacy bundle IDs (`services.jays.usage.monitor`).  
**Fix:** Doc-only sync (this PR does not edit those files).

**F-31 · `aps-environment: development` in tracked entitlements**  
`UsageMonitor.entitlements` + `PushScaffoldTests` expect `development`.  App Store export must rewrite to `production`.  
**Fix:** Confirm `scripts/ios-fleet/ship-testflight.sh` rewrites on archive; document in `ios/README.md`.

**F-32 · Density + product naming leftovers**  
July 20 #9 / #13: web still has global vs workspace density; brand is “Usage Monitor” on web and “Usage Client Monitor” / “Usage Local Monitor” on device (correct).  ⌘K hint is `hidden sm:inline` (`page.tsx:446-452`).  
**Fix:** Keep names.  Unify density defaults.  Optional mobile “Search” label.

---

### P3 — Polish

- **F-33** `ProviderCard` is test-only.  Delete or remount so the component cannot drift from the workspace.  
- **F-34** DashboardHero wraps “families” as `famil` / `ies` (`DashboardHero.tsx:199-200`).  
- **F-35** Attention severity badge prints raw `critical` (`DashboardAttentionPanel.tsx:140-143`) — Title Case the label.  
- **F-36** Sentry `target="_blank"` without “opens in a new window”.  
- **F-37** MacHealthCard heading uses a desktop emoji (`🖥️`).  
- **F-38** Projection modal / many strings still single-space (see F-23).  
- **F-39** History “More” listbox options are buttons (`HistoryWindowControl.tsx:189-191`).  
- **F-40** Local Providers tab icon `server.rack` vs Client `square.stack.3d.up.fill`.  
- **F-41** Dynamic Type: Platforms caps at `.xxxLarge`; money hero uses `minimumScaleFactor` only.  
- **F-42** Lock-screen Unlock button could use an explicit hint.  
- **F-43** No UI for `GET /api/export/daily-rollups` on any client.  
- **F-44** Widget PrivacyInfo omits disk-space reason `E174.1` that the Client app declares.  
- **F-45** Local has no `UIBackgroundModes` (acceptable for v1; document in review notes).

---

## July 20 follow-up (what changed)

| July 20 item | 2026-08-17 status |
|--------------|-------------------|
| iOS hero mixes project budget with provider spend | **Fixed.**  `DashboardViewData` is provider-scoped; tests lock it.  **New issue:** web global budget vs that provider sum (F-01). |
| Unknown cost coerced to $0 | **Still open** on Client decode (`Double` default 0) and some web fallbacks.  Web Overview aggregator is more careful (F-02). |
| Pie ≠ summary KPI | **Still verify** when implementing F-10.  Family aggregator exists; pie must call it. |
| Plan fixed + Subscription double-count | Server still warns; exclusivity tests exist under `src/app/api/subscriptions/__tests__/plan-subscription-exclusivity.test.ts`.  Not re-litigated here. |
| No iOS subscriptions UI | **Fixed** (Settings inventory + Money screen).  Create remains web/Local (F-26). |
| Widget placeholder fake money | **Fixed** (real snapshot + App Lock redaction tests). |
| iPhone `text-sm` inputs | **Partial.**  Login / add-provider / workspace search fixed.  Attribution and some settings still zoom (F-11). |
| Dark-first | **Fixed** (light default web + iOS). |
| ARCHITECTURE-CONTRACT stale | **Still stale** on tab count / some bundle IDs (F-30). |
| Local widget | **Not shipped**; writer remains (F-17). |

---

## Accessibility review (WCAG-oriented)

| Criterion | Web | Client | Local |
|-----------|-----|--------|-------|
| 2.4.1 Bypass blocks | Skip link + `#main-content` | n/a (native) | n/a |
| 2.4.3 / 2.1.2 Focus | `ModalDialog` good; 3 overlays fail (F-12) | System sheets | System |
| 1.4.3 Contrast | Generally gray/um tokens; Mac card tokens no-op (F-05) | DesignSystem | DesignSystem |
| 1.4.4 / 1.4.10 Reflow | Responsive tables → cards in `globals.css` | Dynamic Type mixed (F-41) | Same |
| 1.4.11 Non-text contrast | Pie stroke `#1f2937`; burn series color-only (F-25) | Semantic status | Weaker |
| 1.4.13 / 2.3.3 Motion | No reduced-motion (F-07) | Money path yes | Sparse |
| 2.5.5 Target size | Many 32–36px controls (F-20) | More pin 32pt | Filter chips |
| 1.1.1 / 1.3.1 Charts | UsageChart layer; pie none (F-10) | Swift Charts labels partial | Sparkline only |
| 4.1.2 Name/role/value | Workspace strong; palette weak (F-18) | Money strong; Computers/Intelligence weak (F-09) | Weak (F-08) |
| 1.4.4 Safari zoom | Attribution `text-sm` (F-11) | n/a | n/a |

---

## Data-visualization notes

1. **Two Y-axes** on `UsageChart` (USD vs credits) are easy to misread on a 390pt phone.  Prefer a credits toggle.  
2. **Pie of `projectedEomUsd`** must use the same family dedupe as the hero.  If it still sums raw rows, the chart will exceed the KPI (July 20 #2).  
3. **Spend burn** uses one hue for actual vs projected.  Dash helps; a legend is required.  
4. **Hero MTD is locked** to the current UTC month on web and Client; timeframe pickers correctly say they only move history.  Keep that split.  
5. **LLM burn / Claude check** are analytics, not cash.  Both surfaces should keep that caption.  Local should not pretend to have them.  
6. **Coverage** is a first-class series, not a tooltip.  Web is closer; Client should match (F-13).

---

## Performance

| Surface | Observation | Upgrade |
|---------|-------------|---------|
| Web Overview | 4–6 independent 60–120s intervals when portfolio + ops are mounted (F-22) | Visibility-aware coalescing |
| Web charts | `DashboardPortfolioSection` dynamic-imports Recharts — good | Keep |
| Web tables | Telemetry groups can grow; LlmBurn caps at 8 | Cap + “Show more” on telemetry |
| Client | `BudgetStore` cache-first, coalesced load, 30 min visible refresh | Keep; do not add per-tab 60s loops |
| Client widget | 30 min timeline + app-group write | Keep |
| Local | On-demand poll; widget write is wasted (F-17) | Stop or ship extension |
| Cold budget-status | July 20 noted ~11s month groupBy | Still a server concern; not unique to UI |

---

## TestFlight readiness

| Item | Client | Local | Gate |
|------|--------|-------|------|
| Bundle ID | `services.jays.usage.client.monitor` | `services.jays.usage.local.monitor` | Distinct — good |
| Widget ID | `.client.monitor.widget` | none | F-17 |
| App group | `group.services.jays.usage.client.monitor` | `group.services.jays.usage.local.monitor` | Must be on **App Store** profiles |
| PrivacyInfo | App + widget | App | Widget reason alignment (F-44) |
| Face ID usage string | Yes | Yes | |
| Export compliance | `ITSAppUsesNonExemptEncryption = false` | same | |
| EULA | Custom 2026-08-16 | Custom 2026-08-16 | Done |
| Beta review contact | Filled | Filled | Done |
| What's New | Blocked on 1.0.0 | Blocked on 1.0.0 | Bump 1.0.1 |
| Version / build in repo | 1.0.0 / 1 | 1.0.0 / 1 | Ship script must bump |
| min iOS | 17.0 | 17.0 | `project.yml`, `Package.swift` |
| GM host only | Required | Required | INVALID_BINARY on macOS 27 beta |
| ASC state (last written) | 1.0.0 **REJECTED** | 1.0.0 **REJECTED** | F-06 |
| APNs entitlement | `development` in git | none | TF rewrite (F-31) |
| Background modes | `fetch` + BGTask | none | Honest for Local |
| App Lock | Yes | Yes | |
| Offline | Disk cache | SQLite | |
| Review notes | Server URL + token | On-device keys; no server | Two spaces in every sentence |
| XCUITest / screenshots in CI | No | No | Manual `xcrun simctl io` only |

Ship commands (do not run from this cloud VM): `bash scripts/ios-ship-testflight.sh` and `bash scripts/ios-ship-testflight-local.sh`.

---

## Test inventory and gaps

Approximate counts from this checkout (file / `it` / `test` / `func test` scan, not a live run):

| Suite | Files | Cases |
|-------|-------|-------|
| Web `src/components/__tests__` | 17 | ~155 |
| Web `src/app/**/__tests__` | 16 | ~278 |
| Web `src/lib/__tests__` | 105 | ~1530 |
| iOS `UsageMonitorKit/Tests` | 27 | ~314 |
| iOS host `UsageMonitorTests` | 1 | 2 |
| iOS `UsageMonitorWidgetTests` | 1 | 19 |

**Covered well:** budget-status intel, provider money aggregation, workspace filters, paid services, attention, Client hero math, offline cache, provider list facets, project CRUD, widget redaction, Local key-bundle vectors, push scaffold entitlements.

**Gaps (highest value first)**

| ID | Gap | Why |
|----|-----|-----|
| T-01 | Shared `budget-status` JSON fixtures for web + Swift | F-01 / F-02 will drift again without them |
| T-02 | `spentUsd` null / `spendCoverage: unknown` UI | Client cannot express unknown today |
| T-03 | `/api/health/mac` session + 401 empty-card | F-04 has no failing test |
| T-04 | No XCUITest / snapshot tests | TestFlight visual QA is manual |
| T-05 | No Local accessibility tests | F-08 will regress |
| T-06 | No Local host smoke on the Local scheme | `UsageMonitorTests` is Client-shaped |
| T-07 | No Computers / Intelligence unit tests | F-09 |
| T-08 | Timeframe query-item golden (web `buildUsageEventsUrl` vs `TimeframeOption`) | Easy silent break |
| T-09 | Pie vs hero aggregator equality | July 20 #2 |
| T-10 | Receipt-inbox “not configured” UI on Client | Platforms decode tests only |
| T-11 | Global-budget API + hero meter | Web modal untested against iOS absence |
| T-12 | Chart VoiceOver / `accessibilityLayer` asserts | F-10 |

---

## Ranked upgrades (implementation waves)

Do not start these in this PR.  Suggested order for a later agent:

### Wave A — Trust the same number (P1 money)

1. One hero denominator (F-01) + optional `spentUsd` (F-02) + shared fixtures (T-01, T-02).  
2. Pie uses that aggregator and ships a data table (F-10, T-09).  
3. Coverage chips on Client rows (F-13).  
4. Balance / credits on Client + Local detail (F-15, F-16, F-14).

### Wave B — Same operator language (P1/P2 IA)

5. Unified provider facets + URL/query persistence (F-03).  
6. Dual-auth + styled Mac Health (F-04, F-05, T-03).  
7. Client create-or-handoff for providers/subscriptions (F-26).  
8. Settings copy that lists web-only surfaces (Sentry, notifications, global budget, attribution mutations).

### Wave C — Access and motion (P1 a11y)

9. `ModalDialog` everywhere (F-12); reduced motion on web (F-07).  
10. Local VoiceOver pass (F-08); Computers/Intelligence labels (F-09).  
11. 44pt targets + Safari `text-base` inputs (F-11, F-20).  
12. Chart legends + credits toggle (F-25).

### Wave D — Calm and ship (P1/P2 ops)

13. Visibility-aware web polling (F-22).  
14. Local widget: ship or delete writer (F-17).  
15. ASC 1.0.1 from a GM host; What's New; confirm APNs rewrite (F-06, F-31).  
16. One XCUITest smoke: Client login/token → Overview hero (T-04).

### Wave E — Polish

17. Two-space copy pass (F-23).  Contract/docs sync (F-30).  Dead `ProviderCard` (F-33).  Export UI or a documented ops-only link (F-43).

---

## Honest Local non-parity (do not “fix” into a second server)

These are **product decisions** from `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`, not defects:

- No push / OTLP / CT / ST ingest.  
- No `max(snapshot, push, receipt)` and no HMAC receipt cash.  
- No residual project allocation.  
- No Intelligence, Platforms, Server, Computers, Sentry.  
- No remote bearer; App Lock only.  
- Poll adapter set is a Swift subset, not the Node catalog.

Local **should** still match Client on: light default, inline titles, Title Case chrome, sentence-case values, 44pt targets, VoiceOver on money rows, labeled empty/error, and showing a balance when the poll produced one.

---

## Product QA script (manual)

Use this the next time someone has a logged-in desktop, an iPhone Safari session, Client with a read token, and Local with a seeded catalog.  Do not treat this cloud review as a substitute.

1. **Same month, three heroes.**  Note MTD $, budget $, % used, status chip on web desktop, web phone, Client.  If a global budget is set, Client **will** disagree today (F-01).  
2. **Incomplete provider.**  Confirm web does not show `$0.00` as fact; Client currently can.  
3. **Filters.**  Apply Alerts vs Over vs Incomplete on each list.  Expect different membership (F-03).  
4. **Provider detail.**  7 / 30 / 90 / 365, chart, balance, credits, retry.  
5. **Projection split.**  Open web modal vs Client EOM card — usage / fixed / renewals.  
6. **Mac Health.**  Web Ops card vs Client Computers — expect web empty unless a bearer is somehow present (F-04).  
7. **VoiceOver.**  Client Overview (good) vs Local Providers (poor) vs web pie (no table).  
8. **Reduce Motion.**  On in iOS Settings — hero should not numeric-flip.  Web still animates.  
9. **Attribution on iPhone.**  Focus a `text-sm` field — Safari zoom (F-11).  
10. **Local import.**  `.umkeys` merge; confirm keys never leave the device.  
11. **Widget.**  Client with App Lock on — amounts redacted.  Local — no widget.  
12. **ASC.**  Do not submit from a beta Xcode host.

---

## Out of scope

- No live `usage.jays.services` clicks or TestFlight installs from this VM.  
- No ASC API writes.  
- No money-path formula rewrite (`budget-status.ts` cash rules).  
- No Slack / PagerDuty / ingest storm work (July 20 ops lane).  
- Apple Notes: this cloud agent cannot publish the Coding note.  Handoff body is in the PR.

---

## Apple Notes handoff (local publication)

**Title:** `[UM, Grok] Web / iOS parity audit`  
**Folder:** Coding  
**Stamp:** Mon, Aug 17, 2026 (refresh on paste)

Read-only audit on `main` `8db78b5`.  Report: `docs/audits/2026-08-17-web-ios-parity.md`.

Biggest remaining trust gap: website Overview meters a **global** budget; Client Overview meters the **sum of provider** budgets.  July 20 iOS project/provider mix is fixed.

Web Mac Health is bearer-only, so the dashboard card stays empty for session users.  Local VoiceOver is thin.  TestFlight/App Store still 1.0.0 REJECTED (EULA is in).

No product code in the report PR.  Implementation waves A–E are listed in the doc.
