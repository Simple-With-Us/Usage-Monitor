# Usage Monitor iOS — Architecture Contract

This document is the **binding contract** every feature / integration lane
follows. It describes the **real, committed** structure of the app as it exists
today (SPM package `UsageMonitorKit` + a thin app target + a widget extension).
Do not re-architect it — extend it. If something here disagrees with the code,
the code wins; fix the doc.

**Status (2026-08-04):** Dashboard, Providers, Alerts, Project budgets,
Settings, protected account-scoped OfflineCache, Widget, AppLock, and
session-backed native provider/subscription/**project** management are
implemented against the **remote** Next.js host. Provider detail additionally
loads recorded snapshot history and provider-reported external billing through
session-gated routes when a dashboard session is active (labeled-estimate
fallback + sign-in hint otherwise). Account Overview / widget totals are
**provider-scoped** (do not mix server project-summary budget with provider
total spend).

**Dual iOS apps (2026-08-04):**

| App target | Bundle ID | Role |
|---|---|---|
| **UsageMonitor** (Usage Monitor Client) | `com.simplewithus.usage.client.ios` | Remote live-sync client (owner + server self-hosters). §§1–9. |
| **LocalUsageMonitor** (Usage Monitor Local) | `com.simplewithus.usage.local.ios` | On-device self-host product. §10 + design doc. |

See `ios/README.md` and
`docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`.

Toolchain on the build host: **Swift 6.4** (`swift --version`), **Xcode 27.0**
(`xcodebuild -version`). Package targets iOS 17+ (App Store floor; matches Congress.Trade). Host fleet may still build with Xcode 26+.

---

## 0. Layout & the parallelism rule

Everything lives under `ios/UsageMonitor/`:

- `UsageMonitorKit/` — the SPM package (`Package.swift`, `Sources/`, `Tests/`).
  **All app code lives here**, one target per directory.
- `App/` — the thin `@main` app target (`UsageMonitorApp.swift`, the
  `OfflineCacheSnapshotSink` adapter, `Assets.xcassets`, `Resources/`).
- `UsageMonitorWidget/` — the WidgetKit extension entry point.
- `UsageMonitorTests/` — app-level smoke tests.
- `UsageMonitor.xcodeproj`, `project.yml` — the generated Xcode project.

**Every target is already declared in `Package.swift`.** SPM auto-discovers
every `.swift` file under a target's `Sources/<Target>/` directory, so a lane
adds a screen by **dropping a file into its own folder** — never editing the
manifest, never touching `.pbxproj`. That is what lets ~9 lanes work in
parallel without merge conflicts. **Do not edit `Package.swift`** unless you
are adding a genuinely new target (coordinate first — it is the one shared
file). Adding a test file to your own lane is fine.

### Dependency layers (acyclic — do not introduce cycles)

```
Models          → (none)                       Codable API types + date parsing
DesignSystem    → (none)                        tokens + reusable SwiftUI components (MODEL-FREE)
Networking      → Models                        APIClient actor + Keychain token store
AppCore         → Models, Networking, DesignSystem   app state / routing / theme / tab scaffold
WidgetShared    → DesignSystem                  app↔widget snapshot bridge (app group)
<Feature>       → AppCore, DesignSystem, Networking, Models
AppLock         → AppCore, DesignSystem
OfflineCache    → Models, Networking, WidgetShared
PushScaffold    → AppCore, Models
```

`DesignSystem` is deliberately **model-free**. Components take primitives + a
`Theme.SemanticStatus`; features map their domain enums at the call site using
the `AppCore` bridge (see §3).

---

## 1. Backend auth model (read this before wiring any call)

Server: `https://usage.jays.services` (Next.js). Two gates matter:

`src/middleware.ts` session-gates everything **except** an explicit public
allow-list. On that list (reachable **without** a browser session):
`/api/budget-status`, `/api/health`, `/api/ready`, and the **collection**
`/api/subscriptions` (its `[id]` sub-route stays session-gated). Those route
handlers then **self-authenticate**.

The app supports two deliberately separate credentials. A scoped read token is
stored in Keychain and sent as `Authorization: Bearer`; a dashboard password is
sent once to `/api/auth/login` and retained only as the server's HttpOnly
session cookie. The password is never stored. Read endpoints accept either the
session or the expected `USAGE_READ_TOKEN` (falling back to
`USAGE_INGEST_TOKEN`); mutations remain session-only.

| Endpoint | Reachable with the app's bearer token? | Notes |
|---|---|---|
| `GET /api/budget-status` | **Yes** | Primary data source. Bearer or dashboard session. Returns **503** for a non-session client when no read token is configured server-side. |
| `GET /api/subscriptions` | **Yes** | Bearer- OR session-authorized. Collection GET only. |
| `GET /api/health` | **Yes** (public) | No token. |
| `GET /api/ready` | **Yes** (public) | No token. Per-IP rate limited (30/60s). Includes layered backup status (`checks.backupLayers`: local, B2/primary, R2 weekly archive) plus disk. Each layer carries `title` + `detail` — the phone renders those strings so copy can change on a Coolify deploy without a new IPA. |
| `GET /api/server-metrics` | **Yes** | Bearer or dashboard session. Hetzner host CPU/network/disk series + Coolify app inventory (`self` marks Usage Monitor). |
| `GET /api/providers?view=dashboard` | **Session only** | Bounded native management inventory; secret values are not modeled client-side. |
| `PUT /api/providers/{id}` | **Session only** | Native exposes active-state and full-plan-preserving budget edits. |
| `PUT /api/subscriptions/{id}` | **Session only** | Native currently exposes the safe pause transition only. |
| `POST /api/projects` | **Session only** | Create project; 400/409 on duplicate/case-equivalent name. |
| `PUT /api/projects/{id}` | **Session only** | Blank `description` clears; `monthlyBudgetUsd: null` clears the budget. |
| `DELETE /api/projects/{id}` | **Session only** | Usage history survives (`projectId` set-null server-side). |
| `GET /api/snapshots?providerId=&days=` | **Session only** | Recorded history: raw points + server daily rollups, chronological. Native provider detail exposes a 7/30/90/365-day range picker (web parity); default 30. |
| `GET /api/providers/{id}` | **Session only** | Bounded detail read; native consumes only `externalBilling` records. |

**Consequence for lanes:** `budgetStatus()` remains the sole daily-driver money
fetch and powers Dashboard, Providers (+ detail), Alerts, and Project budgets.
The session-only calls are management inventory/actions in Settings; feature
lanes must not replace the shared budget fetch with per-provider calls.

---

## 2. Networking surface (`Sources/Networking/`)

`APIClient` is an **`actor`** (Sendable, serialized). Feature view-models hold a
reference injected from `AppCore` — **never construct URLs / `URLSession`
directly, never build your own `APIClient` for budget data** (use the shared
`BudgetStore`, §3).

Public methods (all `async throws`):

- `budgetStatus() -> BudgetStatusResponse`  — `GET /api/budget-status` (bearer or session)
- `subscriptions() -> [SubscriptionSummary]` — `GET /api/subscriptions` (auth)
- `health() -> ServerHealth`                 — `GET /api/health` (public)
- `readiness() -> ServerReadiness`           — `GET /api/ready` (public)
- `verifyToken() -> BudgetStatusResponse` `@discardableResult` — cheapest
  authenticated call; **Settings must call this before persisting a token.**
- `login(password:)`, `logout()`, `sessionStatus()`, `accessCapabilities()` —
  transient password login and dashboard-session lifecycle.
- `providerInventory()`, `setProviderActive(...)`,
  `setProviderMonthlyBudget(...)`, `pauseSubscription(id:)` — bounded,
  server-validated native management.
- `createProject(...)`, `updateProject(...)`, `deleteProject(id:)` —
  session-gated project CRUD (`/api/projects`).
- `usageSnapshots(providerID:days:)`, `providerDetail(id:)` — session-gated
  provider-detail read depth (recorded history, external billing records).
- `var hasToken: Bool`

Construction: `APIClient(configuration: APIConfiguration = .production,
tokenStore: TokenStoring = KeychainTokenStore(), session: URLSession? = nil)`.

`APIConfiguration` — `baseURL` + `timeout` (default 20s). `.production` →
`https://usage.jays.services`. `.fromUserInput(_:)` accepts only a secure HTTPS
origin (a missing scheme defaults to HTTPS); credentials, paths, queries,
fragments, and plaintext HTTP are rejected.

`TokenStoring` protocol → `KeychainTokenStore` (real; `kSecAttrAccessible­
AfterFirstUnlock` so widget/background reads work) and `InMemoryTokenStore`
(previews/tests). Errors: `TokenStoreError`.

`APIError` (enum, Equatable, Sendable): `.missingToken`, `.unauthorized` (401),
`.forbidden` (403), `.serverNotConfigured` (503), `.rateLimited(retryAfter:)`
(429), `.httpStatus(Int)`, `.decoding(String)`, `.offline`, `.transport(String)`.
Each carries `.title`, `.message`, `.isRetryable` for driving `ErrorState`.

---

## 3. AppCore — shared state, routing, theme bridge (`Sources/AppCore/`)

All types are `@MainActor @Observable` unless noted. Feature roots read the
environment; they **do not** construct these.

- **`AppEnvironment`** — the single DI container, injected as
  `@Environment(AppEnvironment.self)`. Exposes:
  `settings: AppSettings`, `apiClient: APIClient` (rebuilt by
  `reconfigure(host:)`), `budgetStore: BudgetStore`, `hasToken: Bool`,
  `setToken(_:) throws` (Keychain), `reconfigure(host:)`,
  `static preview(token:)`. The app builds it with the real
  `OfflineCacheSnapshotSink`.
- **`BudgetStore`** — the single owner of the `budgetStatus()` fetch. Injected
  both as `@Environment(AppEnvironment.self).budgetStore` **and directly** as
  `@Environment(BudgetStore.self)`. API:
  - `state: LoadState<BudgetStatusResponse>`, `lastUpdated: Date?`,
    `lastError: APIError?`
  - derived: `response`, `providers: [ProviderBudgetStatus]`,
    `projects: [ProjectBudgetStatus]`, `summary: BudgetSummary?`,
    `alertItems: [ProviderAlertItem]` (flattened + severity-sorted)
  - lifecycle: `loadIfNeeded()` (idempotent first load, offline-first paint
    from cache), `load()`, `refresh()` (keeps stale data on failure → sets
    `lastError`).
  - **Every budget-driven feature reads this store. Do not fetch budget-status
    yourself.**
- **`AppSettings`** — persisted (non-sensitive) prefs in `UserDefaults`:
  `theme: AppTheme` (`.system/.light/.dark`), `baseHost: String`,
  `appLockEnabled: Bool`. **The API token never goes here — Keychain only.**
- **`LoadState<Value>`** — `.idle/.loading/.loaded/.failed(APIError)` with
  `.value`, `.error`, `.isLoading`, `.isInitialLoading`. Use it for every
  feature-local store too.
- **`AppTab`** (enum) — the six tabs and the deep-link vocabulary:
  `.dashboard/.providers/.alerts/.platforms/.projects/.settings`, each with
  `.title` (Overview / Providers / Alerts / Platforms / Projects / Settings)
  and `.systemImage`.  Note iPhone shows only the first four plus a **More**
  list, so `.projects` and `.settings` live under More; every dead-end state
  that needs Settings must therefore call `env.selectTab?(.settings)` rather
  than telling the user to "tap Settings".
- **`AppFeatures`** — the seam: six `() -> AnyView` closures the **app target**
  supplies (one per tab). `RootView(environment:features:initialTab:)` is the
  `TabView` shell; it owns tab selection + app-wide chrome and injects
  `AppEnvironment`, `BudgetStore`, `AppSettings`, and the color scheme. Each
  feature root owns **its own `NavigationStack` + title**.
- **`Theme.SemanticStatus` bridge** (`SemanticStatusMapping.swift`) — map domain
  → design at the call site:
  `Theme.SemanticStatus(_ level: BudgetLevel)`,
  `Theme.SemanticStatus(_ severity: AlertSeverity)`,
  `Theme.SemanticStatus(coverage: CostCoverage)`.
- **`BudgetSnapshotSink`** protocol + `NullBudgetSnapshotSink` — the caching
  seam AppCore exposes without depending on OfflineCache/WidgetShared.
- **`ProviderAlertItem`** — `(provider, alert)` pair with stable `id`; the
  Alerts feed element.

### View-model pattern (already in use, follow it)

`@MainActor @Observable final class` stores, exposing `LoadState<…>`. Feature
roots drive first load with `.task { await store.loadIfNeeded() }` and
pull-to-refresh with `RefreshableScrollView { await store.refresh() }`; render
skeleton while `state.isInitialLoading`, `ErrorState` on `state.error`, content
on `state.value`; on refresh-over-data failure surface `lastError` as a
non-blocking banner. For budget data, reuse the shared `BudgetStore` rather than
creating a new store.

---

## 4. Models (`Sources/Models/`)

Codable, `Hashable`, `Sendable`. Enums decode unknown/future raw values to a
safe fallback (never throw). Only the consumed subset of each backend type is
declared; extra fields are ignored.

- `BudgetStatusResponse` — `ok`, `generatedAt`, `month`, `providers`,
  `projects?`, `summary`; `generatedAtDate`.
- `BudgetSummary` — totals/spent/remaining/`percentUsed?`/`overBudget`/`warning`.
- `ProviderBudgetStatus` (`Identifiable`) — rich per-provider budget row
  (`monthlyBudgetUsd?`, `spentUsd`, `projectedEomUsd`, `remainingUsd?`,
  `percentUsed?`, `status: BudgetLevel`, `spendCoverage: CostCoverage`,
  `alerts: [ProviderAlert]`, …). Helpers: `title`, `hasBudget`,
  `mostSevereAlert`, `snapshotFetchedDate`.
- `ProjectBudgetStatus` (`Identifiable`) — per-project row (`directUsd?`,
  `allocatedUsd?`, `incompleteAllocatedProviderCount?`, `percentUsed?`,
  `status`, …). Helper: `hasBudget`.
- `ProviderAlert` (`Identifiable`) + `AlertSeverity` (`.critical/.warning/.info`,
  `.order`). `ProviderAlert.title` + `.symbolName` give a human label + SF
  Symbol per known `code` with a generic fallback.
- `CostCoverage` (`.complete/.partial/.unknown/.legacyUnknown`, `.isComplete`,
  `.label`) and `BudgetLevel` (`.ok/.warning/.exceeded/.unconfigured`).
- `SubscriptionSummary` (`Identifiable`) — `GET /api/subscriptions` element:
  cost/cadence/renewal + `provider`/`project` refs; `nextRenewalDate`, `isLive`,
  `cadenceLabel`.
- `ServerHealth`, `ServerReadiness` — `/health` + `/ready` payloads.
- `AccessCapabilities`, `DashboardSessionStatus`, `ProviderManagementItem`,
  and mutation receipts — bounded full-access state and provider inventory.
- `ISO8601DateParser` (`DateParsing.swift`), `PreviewFixtures.swift` — seeded
  data for previews/tests.

---

## 5. DesignSystem (`Sources/DesignSystem/`) — build every screen from these

`Theme` namespace: `Theme.Colors` (background/surface/surfaceElevated/fill/
meterTrack, primary/secondary/tertiary text + separator, `accent`/`accentSoft`,
`success`/`warning`/`danger`/`neutral`), `Theme.SemanticStatus`
(`.neutral/.ok/.warning/.danger` → `.tint`, `.wash`), `Theme.Spacing`
(xxs…xxxl, 4pt base), `Theme.Radius` (sm/md/lg/xl/pill), `Theme.Typography`
(hero/title/sectionHeader/statValue/body/callout/caption/captionEmphasis).

Components (public `init`s):

- `StatTile(label:value:secondary:systemImage:status:)`
- `ProviderRow(title:subtitle:value:valueCaption:status:showsChevron:)`
- `BudgetMeter(fraction:status:height:)` and
  `LabeledBudgetMeter(title:detail:fraction:status:)`
- `SparklineCard(title:value:caption:points:status:)` and `Sparkline(points:tint:)`
- `SectionHeader(_:subtitle:accessory:)` (+ accessory-less overload)
- `EmptyState(systemImage:title:message:actionTitle:action:)`
- `ErrorState(systemImage:title:message:retryTitle:retry:)`
- `SkeletonBlock`, `SkeletonList(rows:)`, `Shimmer` modifier
- `StatusBadge(_:status:systemImage:)`
- `RefreshableScrollView(spacing:onRefresh:content:)` + `.dsScreenBackground()`
- `.dsCard(padding:radius:)` / `CardModifier`
- `CurrencyFormat.usd(_:)`, `.compactUSD(_:)`, `.percent(_:)`

(`Sources/DesignSystem/Components/` exists as an empty folder — put additional
shared components there if a lane needs one; keep them model-free.)

---

## 6. Feature lanes (each owns exactly one `Sources/<Target>/` directory)

All five feature roots are implemented. Each keeps a
`public struct <Name>RootView: View` with a `public init()` — the app target
mounts these via `AppFeatures.live`. **Do not rename the root type or change its
`init` signature.** Add sibling files in the owning folder.

| Lane | Directory | Public root (mounted) | Tab slot | Reads | Uses (DesignSystem / Models) | Status |
|---|---|---|---|---|---|---|
| **Dashboard** | `Sources/Dashboard/` | `DashboardRootView` | `.dashboard` (Overview) | `@Environment(BudgetStore.self)` → `summary`, `providers` | Account overview, pace chart, top providers, refresh/stale/error states | Implemented |
| **Providers** | `Sources/Providers/` | `ProvidersRootView` | `.providers` | `BudgetStore.providers` + session-gated `ProviderDepthStore` | Searchable budget list and provider detail: shared snapshot plus recorded history (`/api/snapshots`) and external billing (`/api/providers/{id}`) when a session is active | Implemented |
| **Alerts** | `Sources/Alerts/` | `AlertsRootView` | `.alerts` | `BudgetStore.alertItems` (`[ProviderAlertItem]`, pre-sorted) | Severity feed, detail, resolution state, local-notification integration | Implemented |
| **ProjectBudgets** | `Sources/ProjectBudgets/` | `ProjectBudgetsRootView` | `.projects` | `BudgetStore.projects` (`[ProjectBudgetStatus]`, may be empty) + session-gated `ProjectManagementStore` | Project attribution, allocation caveats, detail, and session-backed add/edit/delete (`/api/projects`) | Implemented |
| **Settings** | `Sources/Settings/` | `SettingsRootView` | `.settings` | `AppEnvironment`, public health, bearer + session access | Secure connection, full-access login, provider/subscription management, notifications, appearance, app lock | Implemented |

Feature lanes may add their own `LoadState`-based `@Observable` stores for
non-budget data (e.g. Settings' `subscriptions()`/`health()`), and add test
files under `UsageMonitorKitTests` for their own logic.

---

## 7. Integration lanes

| Lane | Directory / entry file | Public entry | Depends on | What it must preserve | Status |
|---|---|---|---|---|---|
| **AppLock** | `Sources/AppLock/AppLockGate.swift` | `AppLockGate<Content> { … }` (wraps `RootView` in the app target) | `AppCore`, `DesignSystem` | Signature stays `AppLockGate { <content> }`. Read `env.settings.appLockEnabled`; gate with `LAContext.evaluatePolicy`, re-lock on `scenePhase == .background`; pass-through when disabled. `NSFaceIDUsageDescription` already in Info.plist. | Pass-through starter |
| **OfflineCache** | `Sources/OfflineCache/` (`BudgetDiskCache`, `WidgetSnapshotBuilder`, `WidgetSnapshotStore`) | `BudgetDiskCache` (`save`/`load`/`clear`), `WidgetSnapshotBuilder` budget/LLM/server/Mac/alerts projections, `WidgetSnapshotStore` merge-writes | `Models`, `Networking`, `WidgetShared` | Model-free of AppCore. Budget writes merge into the existing snapshot so LLM, server, and Mac tiles are not wiped. | Working |
| **WidgetShared** | `Sources/WidgetShared/` (`WidgetSnapshot`, `AppGroup`, `SharedStore`) | `WidgetSnapshot` (+ optional `llm` / `servers` / `mac` / `alerts`, `.placeholder`), `AppGroup`, `SharedStore.shared` (`read`/`write`/`update`) | `DesignSystem` | App group id `group.com.simplewithus.usage` must match both `.entitlements`. Older snapshots without `llm`/`servers`/`mac`/`alerts` decode as missing sections, not zeros. | Working |
| **Widget UI** | `UsageMonitorWidget/` (app extension, **not** a Kit target) | `UsageMonitorWidgetBundle` (`@main`), `BudgetSummaryWidget` + dedicated `MacGlanceWidget` / `AlertsGlanceWidget`, `SelectBudgetIntent` topic + focus | `WidgetShared`, `DesignSystem` | Gallery: **Usage Monitor**, **Mac**, **Alerts** (same `.widget` bundle, small/medium/large). **Edit Widget** picks **Budget**, **LLM Quotas**, **Servers**, **Mac**, **Alerts**, or **Providers**. Honest empty/stale when a section is missing. Deep links: dashboard / projects / serverStatus / computers / alerts / providers. Bundle id unchanged. | Working |
| **PushScaffold** | `Sources/PushScaffold/PushScaffold.swift` | `PushScaffold` enum (`requestAuthorization()`, `configureNotificationCategories()`, `scheduleAlertNotifications(for:)`) | `AppCore`, `Models`, `Networking` | Called from launch. **Local notifications only — remote push (APNs) is NOT implemented.** There is no server device-enrollment endpoint and no APNs sender, so the app must not claim `aps-environment` or `UIBackgroundModes: remote-notification`; `PushScaffoldTests` enforces both. Delivery is `BGTaskScheduler` (`UIBackgroundModes: fetch` + `BGTaskSchedulerPermittedIdentifiers`) → `AlertNotifier.deliver` → `scheduleAlertNotifications`. Adding remote push means adding the server side first, then the client against that real contract. | Working (local only) |

---

## 8. App target (`App/`) — composition only, owns no feature UI

`UsageMonitorApp.swift` builds `AppEnvironment(snapshotSink:
OfflineCacheSnapshotSink())`, wraps `RootView(environment:features: .live)` in
`AppLockGate`, and supplies `AppFeatures.live` (the five feature roots). Adding a
screen never touches this file beyond a lane swapping in a richer root inside its
own module. `App/OfflineCacheSnapshotSink.swift` is the **one** place allowed to
depend on both AppCore and the integration modules.

---

## 9. Rules of the road

1. Own **one** directory; add files, don't edit other lanes' files or
   `Package.swift`.
2. Keep every `public <Name>RootView` type name + `public init()` stable.
3. One authenticated fetch (`budgetStatus`) via the shared `BudgetStore` — no
   new budget network calls; the rich `/api/providers` route is unreachable by
   token (session-gated).
4. Token → Keychain only (`setToken`), never `AppSettings`/`UserDefaults`.
   Verify with `verifyToken()` before persisting.
5. Build from `Theme` tokens + DesignSystem components; map domain→status with
   the `AppCore` `Theme.SemanticStatus(_:)` bridge. No hard-coded colors.
6. Render `LoadState`: skeleton on `isInitialLoading`, `ErrorState` on `error`,
   content on `value`; keep stale data + soft banner on refresh failure.

---

## 10. Usage Monitor Local (separate app) — addendum

**Authority:** `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`.
This section binds the **LocalUsageMonitor** app target only. §§1–9 bind
**UsageMonitor** (remote client).

### 10.1 Two apps — not a compile flag

| App | Xcode scheme | Money-truth | App group |
|---|---|---|---|
| **UsageMonitor** (Usage Monitor Client) | `UsageMonitor` | Remote server SQLite via HTTPS | `group.com.simplewithus.usage` |
| **LocalUsageMonitor** (Usage Monitor Local) | `LocalUsageMonitor` | On-device GRDB (PR-2+) | `group.com.simplewithus.usage` |

- **Do not** merge these into one binary with a runtime switch.
- Local app must **not** link remote money write paths (`APIClient` mutations,
  session login for cash). Outbound HTTPS to **provider APIs only** (adapters).
- Owner daily driver stays **UsageMonitor** → self-hosted/Oracle host (live sync).

### 10.2 MVP surface freeze (Milestone A)

**In scope:** Overview, Providers (list/detail + fetch-now), Alerts (local),
Projects (direct attribution only), Settings (providers/subscriptions/keys),
widget, Face ID App Lock.

**Out of scope for v1 App Store:** live OTLP/ingest, CT/ST push telemetry,
Money/Ops/Sentry depth, residual % project allocation, remote APNs as product
alert path, Docker/self-host packaging as the product answer.

### 10.3 Module boundaries (Local app)

```
LocalStore       → (none)                 GRDB schema exactly per design §2.2.1 (scaffold today)
LocalDataPlane   → DesignSystem, LocalStore   LocalRootView + future engine glue
KeychainSecrets  → (none)                 provider API keys only (planned)
Adapters         → Models                 ProviderAdapter + LocalUsageResult (planned)
BudgetEngine     → Models, LocalStore     spentUsd formula per design §2.3 (planned)
Materializer     → LocalStore             subscription_charge rows (planned)
```

- Remote client app targets **must not** depend on `LocalStore` / `LocalDataPlane`.
- Local app target depends only on Local + DesignSystem (+ AppLock when local settings exist).
- Widget for Local (if added later) uses a **separate** extension + local app group file snapshot.

### 10.4 Cash contracts (do not invent)

1. **BudgetEngine v1:**  
   `spentUsd = pollVariableUsd + subscriptionChargesUsd + planFixedMonthlyUsd`  
   with plan-fixed vs subscription exclusivity as on the server. No residual %
   allocation in v1. Golden vectors live in the design doc.
2. **Snapshot eligibility:** prefer `calendar_month_to_date` (+ window); else
   `unknown` with `fetched_at >= monthStart`; **no grace**.
3. **`LocalUsageResult`:** bounded subset — **no** `rawData`, **no**
   `externalBilling` persistence.
4. **P0 poll order:** OpenRouter → OpenAI → DeepSeek. OpenRouter MTD budget
   requires a **Management** key (inference-only → connected, `$0` poll, no
   `usage_monthly` → `totalCost` mapping). Anthropic personal / Tiingo / FMP
   are **subscription_only** (not poll targets).
5. **Export package v1:** keys never included; passphrase optional with
   warning; Replace-all in Milestone A; Merge-by-name in B.

### 10.5 Rules of the road (Local app)

1. Provider API keys → Keychain only; never GRDB, never export payload.
2. Face ID App Lock replaces dashboard password for local use (wire when local
   Settings ships; do not force remote `AppEnvironment` into Local).
3. BGAppRefresh is **opportunistic** — no 15-minute SLA; UI must show last
   successful poll age.
4. Local notifications only for product alerts (remote APNs belongs to the
   **UsageMonitor** client talking to a server).
5. Any PR that ports server money math must cite design §2.3 and add golden
   vector tests before merge.
6. Deep links: Usage Monitor Local uses `usagelocalmonitor://`; Usage Client
   Monitor uses `usageclientmonitor://`.
