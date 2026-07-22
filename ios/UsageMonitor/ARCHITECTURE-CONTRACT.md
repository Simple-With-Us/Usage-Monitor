# Usage Monitor iOS — Architecture Contract

This document is the **binding contract** every feature / integration lane
follows. It describes the **real, committed** structure of the app as it exists
today (SPM package `UsageMonitorKit` + a thin app target + a widget extension).
Do not re-architect it — extend it. If something here disagrees with the code,
the code wins; fix the doc.

**Status (2026-07-21):** Dashboard, Providers, Alerts, Project budgets
(read-only), Settings, protected account-scoped OfflineCache, Widget, AppLock,
and session-backed native provider/subscription management are implemented.
Account Overview / widget totals are **provider-scoped** (do not mix server
project-summary budget with provider total spend). Project add/edit remains
disabled until its server-validated native mutation flow is implemented.

Toolchain on the build host: **Swift 6.4** (`swift --version`), **Xcode 27.0**
(`xcodebuild -version`). Package targets iOS 26+ for the owner's single-user device fleet.

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
| `GET /api/ready` | **Yes** (public) | No token. Per-IP rate limited (30/60s). |
| `GET /api/providers?view=dashboard` | **Session only** | Bounded native management inventory; secret values are not modeled client-side. |
| `PUT /api/providers/{id}` | **Session only** | Native exposes active-state and full-plan-preserving budget edits. |
| `PUT /api/subscriptions/{id}` | **Session only** | Native currently exposes the safe pause transition only. |

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
- **`AppTab`** (enum) — the five tabs and the deep-link vocabulary:
  `.dashboard/.providers/.alerts/.projects/.settings`, each with `.title`
  (Overview / Providers / Alerts / Projects / Settings) and `.systemImage`.
- **`AppFeatures`** — the seam: five `() -> AnyView` closures the **app target**
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
| **Providers** | `Sources/Providers/` | `ProvidersRootView` | `.providers` | `BudgetStore.providers` | Searchable budget list and provider detail from the shared snapshot | Implemented |
| **Alerts** | `Sources/Alerts/` | `AlertsRootView` | `.alerts` | `BudgetStore.alertItems` (`[ProviderAlertItem]`, pre-sorted) | Severity feed, detail, resolution state, local-notification integration | Implemented |
| **ProjectBudgets** | `Sources/ProjectBudgets/` | `ProjectBudgetsRootView` | `.projects` | `BudgetStore.projects` (`[ProjectBudgetStatus]`, may be empty) | Project attribution, allocation caveats, and read-only detail | Implemented (read-only) |
| **Settings** | `Sources/Settings/` | `SettingsRootView` | `.settings` | `AppEnvironment`, public health, bearer + session access | Secure connection, full-access login, provider/subscription management, notifications, appearance, app lock | Implemented |

Feature lanes may add their own `LoadState`-based `@Observable` stores for
non-budget data (e.g. Settings' `subscriptions()`/`health()`), and add test
files under `UsageMonitorKitTests` for their own logic.

---

## 7. Integration lanes

| Lane | Directory / entry file | Public entry | Depends on | What it must preserve | Status |
|---|---|---|---|---|---|
| **AppLock** | `Sources/AppLock/AppLockGate.swift` | `AppLockGate<Content> { … }` (wraps `RootView` in the app target) | `AppCore`, `DesignSystem` | Signature stays `AppLockGate { <content> }`. Read `env.settings.appLockEnabled`; gate with `LAContext.evaluatePolicy`, re-lock on `scenePhase == .background`; pass-through when disabled. `NSFaceIDUsageDescription` already in Info.plist. | Pass-through starter |
| **OfflineCache** | `Sources/OfflineCache/` (`BudgetDiskCache`, `WidgetSnapshotBuilder`) | `BudgetDiskCache` (`save`/`load`/`clear`), `WidgetSnapshotBuilder.snapshot(from:maxMeters:)` | `Models`, `Networking`, `WidgetShared` | Model-free of AppCore. The app's `OfflineCacheSnapshotSink` (in `App/`) adapts it to `BudgetSnapshotSink` — writes disk cache + widget snapshot on each success, feeds offline first paint. | Working starter |
| **WidgetShared** | `Sources/WidgetShared/` (`WidgetSnapshot`, `AppGroup`, `SharedStore`) | `WidgetSnapshot` (+ `.placeholder`), `AppGroup` (`identifier`, `containerURL`, `defaults`), `SharedStore.shared` (`read`/`write`) | `DesignSystem` | App group id `group.services.jays.usage.monitor` must match both `.entitlements`. Degrade gracefully (no force-unwrap) when the container is absent. | Working |
| **Widget UI** | `UsageMonitorWidget/UsageMonitorWidgetBundle.swift` (app extension, **not** a Kit target) | `UsageMonitorWidgetBundle` (`@main`), `BudgetSummaryWidget`, `BudgetTimelineProvider` | `WidgetShared`, `DesignSystem` | Reads real cached data via `SharedStore.shared.read() ?? .empty` (zeros when unsigned-in). Gallery may use `.placeholder` curated sample only. | Working (small/medium) |
| **PushScaffold** | `Sources/PushScaffold/PushScaffold.swift` | `PushScaffold` enum (`requestAuthorization()`, `setAPNsDeviceToken(_:)`) | `AppCore`, `Models` | Called from launch. Extend with categories/actions, APNs registration, local-notification scheduling from `[ProviderAlert]`. `UIBackgroundModes: remote-notification` + `BGTaskSchedulerPermittedIdentifiers` already declared. | Scaffold |

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
