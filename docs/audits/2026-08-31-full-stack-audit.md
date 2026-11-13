# Usage Monitor — top-to-bottom full-stack audit

**Date:** Mon, Aug 31, 2026 (CT)
**Seat:** GROK (Mac TUI), branch `grok/full-stack-audit`, worktree `~/apps/usage-grok-audit`
**HEAD reviewed:** `26103611` (`origin/main` at start of lane)
**Method:** seven parallel read-only reviewers (web viewports, iOS Client+Local, backend ingest/API, money path, security/privacy, ops/workers/extensions, TODO/error hunt) plus orchestrator spot-checks of every P0/P1 claim.  No production mutations.  No secret values printed.
**Board:** `da6edf84`

This is a report-only audit.  It does not implement product fixes.

---

## Verdict

The money path is still fail-closed where it was designed to be: ingest vs HMAC cash vs dashboard writes stay on distinct credentials, poll vs push uses `max()` not `sum()`, plan vs subscription exclusivity is enforced, derived LiteLLM cost stays in metadata, and the receipt inbox cannot POST cash.

Residual risk is concentrated in five clusters:

1. **Read-token privilege expansion** — `USAGE_READ_TOKEN` can mutate alert routing and list/enroll APNs devices.
2. **Cash vs estimate leaks** — Hetzner/Backblaze catalog prorates are written as `UsageSnapshot.totalCost`; plan-fixed still adds on top of snapshot-included fixed.
3. **Ops durability leftovers from 2026-08-17** — weekly R2 still uses host `/tmp`; overlapping scheduler ticks can hide a stall; Coolify still has no in-repo deploy gate.
4. **Web Agents chrome is unstyled** — shadcn token class names with no theme tokens in `tailwind.config.ts`.
5. **iOS Client vs Local honesty** — APNs can claim registered when upload failed; Local writes widget snapshots with no WidgetKit extension; Local never ships on hosted `ios-ship`.

No unauthenticated cash write, no committed live secrets, and no P0 unauthenticated secret-read were found.

Live browser and iOS simulator passes were **not** run this session.  Layout severities below are from CSS/Swift wiring and should be confirmed visually before a polish PR.

---

## What's holding (do not re-open)

| Area | Status |
|------|--------|
| Light theme default | Web `defaultTheme="light"`; iOS `AppSettings` defaults `.light` |
| OTLP + ingest middleware exclusions | `/api/otlp` and `/api/ingest` are public at the session gate; routes self-auth |
| Daily-rollups bearer exclusion | **Fixed in code** (`middleware.ts` + tests).  `AGENTS.md` was stale (corrected in this lane) |
| Ingest admission `finally` release | Process-local lock; no timeout-release while a query is running |
| v2 `project` out of idempotency | Confirmed |
| `persisted` = newly inserted only | Confirmed on generic ingest (OTLP `accepted` still includes duplicates) |
| Workspace export secret-free | `splitProviderConfig`; no `apiKey` / `secretConfig` |
| Receipt inbox HMAC isolation | Worker has no `BILLING_RECEIPT_*` bindings; email does not auto-POST expenses |
| Datadog session replay | Hard 0 |
| Chrome/Safari extension | Storage-only launcher; no host scrape; CI safety test |
| PWA service worker | Install/activate only; no fetch handler, so no API cache |
| Cron `/api/cron/fetch-all` | Timing-safe `x-cron-secret` |
| Litestream restore overwrite | `-if-db-not-exists`; `migrate-safe` refuses `--accept-data-loss` |
| Providers API null spend | `spentUsd: canonicalBudget?.spentUsd ?? null` (July fake-`$0` is gone) |
| `/api/health/mac` dual-auth | Session or read token (old M6 is fixed) |

---

## Ranked findings

Severity: **P0** = can take down origin, destroy the live DB copy, or silently invent/double cash.  **P1** = confirmed privilege, cash misreport, or unusable surface.  **P2** = real gap with bounded blast radius.  **P3** = hygiene / copy.

Already-filed board items are noted.  New items from this audit are listed under "Board filings."

### P0

| ID | Finding | Evidence | Surface |
|----|---------|----------|---------|
| A1 | Coolify path has no in-repo deploy gate.  Red CI can become the sole SQLite writer. | `.github/workflows/production-deploy-verify.yml` is observer-only.  Retired Oracle gated on signed SHA + green checks.  Board `d0f5f1db` / issue #1293. | Ops |
| A2 | Weekly R2 archive still writes under host `/tmp`.  Prior Coolify `503 no available server` was tmpfs fill from restore leftovers. | `scripts/ops/r2-weekly-archive.mjs:237` `mkdtempSync(join(tmpdir(), "r2-weekly-archive-"))`.  Leftover from 2026-08-17 durability P0. | Ops |
| A3 | Overlapping scheduler ticks reset the stall clock.  `tick_stalled` can stay silent while work is wedged. | `src/lib/usage-recorder.ts:691-733` always `markTickStarted()`; `setInterval` has no in-flight guard.  Fetch/maintenance coalesce, the stall clock does not. | Backend |

### P1 — security / privilege

| ID | Finding | Evidence | Surface |
|----|---------|----------|---------|
| B1 | `USAGE_READ_TOKEN` can `PUT /api/settings` and mutate live alert routing (`ALERT_*`, Pushover keys) in `process.env`.  Documented as read-only. | `src/app/api/settings/route.ts:11-18,54-80`.  Middleware public: `src/middleware.ts:36`.  Contrast: `PUT /api/settings/global-budget` is session-only. | Security, backend |
| B2 | `GET /api/apns/device-tokens` returns full `deviceToken` values.  The preview field is additive, not a replacement. | `src/app/api/apns/device-tokens/route.ts:23-45` spreads `...t` after selecting `deviceToken: true`. | Security |
| B3 | Same read token can `POST` APNs enrollments.  Combined with B1, a stolen read token retargets both Pushover and APNs. | Same route `:9-16,48-80`.  iOS Client uses `.session` for this POST, so bearer enroll is not even the Client path. | Security, iOS |
| B4 | Shared-package auto-merge lacks the same-repo fork guard that `auto-merge-prs.yml` has.  `pull_request_target` + `contents: write` + title/ref heuristics. | `.github/workflows/auto-merge-shared-dependency.yml:10-61` vs `.github/workflows/auto-merge-prs.yml:44-46`.  Conditional on `GH_PAT` / `SHEPHERD_TOKEN` being set. | CI |
| B5 | `GET /api/settings` returns alert email From/To to any read token. | `src/app/api/settings/route.ts:45-49`. | Privacy |

### P1 — money

| ID | Finding | Evidence | Surface |
|----|---------|----------|---------|
| C1 | Backblaze and Hetzner catalog-prorated estimates are written as `UsageSnapshot.totalCost` and enter `spentUsd`.  Caveat only flips `spendCoverage` off `complete`. | `src/lib/adapters/backblaze.ts:432-442` (`backblaze_storage_catalog_prorated`); `src/lib/adapters/hetzner.ts:635-646`; consumed at `src/lib/budget-status.ts:1351-1443`. | Money |
| C2 | `ProviderPlan.fixedMonthlyCostUsd` still adds on top of snapshot-included fixed.  Plan vs **subscription** is zeroed; plan vs **snapshot fixed** is only alerted via `fixedCostConflict`. | `src/lib/budget-status.ts:541-566`. | Money |
| C3 | Owner-recorded `prepaid` is treated as consumption (`metricType: "cost"` → `usagePushed`).  HMAC receipt prepaid is funding and excluded.  Same $500 credits inflate budget if typed in Ops, not if imported. | `src/lib/owner-expense.ts:160-162`; HMAC skip at `src/lib/external-usage-events.ts:1655-1656`. | Money |
| C4 | iOS remaining/runway uses the sum of provider-plan budgets; web remaining uses Global Budget when set. | API `budget-status.ts:1812-1835`; web `src/app/page.tsx:208-211`; iOS `BudgetStatus.swift` does not decode `effectiveGlobalBudgetUsd`. | Money, iOS |

### P1 — web / native usability

| ID | Finding | Evidence | Surface |
|----|---------|----------|---------|
| D1 | Agents dashboard + Mac Health use undefined Tailwind tokens (`border-border`, `bg-card`, `bg-muted`, `text-muted-foreground`, `bg-primary`).  Config only extends `accent`.  Chrome/borders/fills do not paint. | `tailwind.config.ts:7-12`; `src/components/AgentsDashboard.tsx:51-71`; `src/components/MacHealthCard.tsx:37-55,129-135`. | Web, all viewports |
| D2 | `/agents` nests a second `<main>` inside the root landmark and extra `container` padding. | `src/app/layout.tsx` already wraps `<main id="main-content">`; `src/app/agents/page.tsx:10-12`. | Web, phones worst |
| D3 | Money / Settings tables use `overflow-x-clip`.  `responsive-table` only card-stacks below 640px, so tablet widths clip Actions/Source. | `PaidServicesPanel.tsx:313`, `SubscriptionsPanel.tsx:141`, `ProjectTable.tsx:58`. | Web 640–1024 |
| D4 | Client APNs UI can show Registered when upload failed.  Token is stored in `UserDefaults` before POST; errors are `print` only. | `PushScaffold.swift:60-84`; `NotificationsSection.swift:67-69,127-130`. | iOS Client |
| D5 | Local writes widget snapshots into its app group but `project.yml` has no WidgetKit extension.  Client embeds `UsageMonitorWidgetExtension`; Local does not. | `LocalWidgetSnapshotWriter`; Local target in `ios/UsageMonitor/project.yml`.  Design MVP required a Local widget. | iOS Local |
| D6 | Hosted `ios-ship` ASC auth failure streak since 2026-08-26.  Local stays skipped. | Board `5828a5b7`.  Workflow imports GH Actions secrets; JWT path looks structurally correct — likely secret copy vs ST/CT, not missing code. | iOS ship |

### P1 — ingest / durability

| ID | Finding | Evidence | Surface |
|----|---------|----------|---------|
| E1 | Mac heartbeat: unbounded `request.json()`, no ingest admission, unique key per millisecond → SQLite insert flood.  Defaults plant `hostname: "jays.services"` / `username: "jay"` when fields are omitted. | `src/app/api/ingest/mac-heartbeat/route.ts:7-16`; `src/lib/mac-health.ts:42-76`. | Backend |
| E2 | OTLP logs rate-limit is still IP-keyed; metrics/usage moved to post-auth identity buckets.  Shared Cloudflare egress can 429 everyone. | `src/app/api/otlp/v1/logs/route.ts:36-46` vs metrics identity buckets. | Backend |

### P2 (selected — full lists in agent notes)

| ID | Finding | Why it matters |
|----|---------|----------------|
| F1 | Budget / projected-cost modals skip `ModalDialog` a11y (no focus trap, Escape, scroll lock).  Command palette also has no trap. | Keyboard / phone Global Budget. |
| F2 | Desktop/tablet nav links and Settings CTAs miss 44px targets (`px-2 py-1.5`, `h-9`). | iPad / compact density. |
| F3 | Settings `PUT` is non-durable (`process.env` only) but reports `ok: true`.  Combined with B1, hijack lasts until restart. | False success. |
| F4 | Forecast day index is 1-based (`getUTCDate() + hours/24`); the start-of-month `< 0.1` guard never runs.  Tests encode "Jan 15 noon = halfway."  `llm-burn.ts` already uses true elapsed fraction. | Early-month runway. |
| F5 | Complementary-channel `max(snapshot, push)` undercounts disjoint spend.  Correct when one channel supersets the other. | Cash undercount, alerted. |
| F6 | Fail-open 2× when snapshot-fixed and a local subscription are unlinked.  Tests lock `spentUsd` 65 = 35 + 30. | Cash double-count with a conflict flag. |
| F7 | Alert `$0` fallback when `trackedSpendUsd` is omitted on the first delivery pass. | Missing snapshot looks cheap. |
| F8 | `request_limit` compares raw `totalRequests` to `monthlyRequestLimit` with no unit/window.  Adapters stuff MB / daily / minute credits into the same field. | False quota alerts. |
| F9 | GitHub adapter assumes USD for `netAmount`. | FX mis-cash if billed otherwise. |
| F10 | Secret-migration classifier omits bare `apikey` while runtime `ALWAYS_SECRET_KEYS` includes it. | Plaintext leftovers in SQLite/backups. |
| F11 | Snapshot `rawData` allowlist is shallow; nested `keys` / `invoice` / `billing` survive. | Adapter-nested secrets persist. |
| F12 | Unscoped `USAGE_INGEST_TOKEN` can impersonate any v1 `sourceApp` unless `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`. | Scoped producers only help when required. |
| F13 | Alert Slack/webhook POST has no SSRF/private-IP pin (adapter `fetchJson` does). | Env-write chained egress. |
| F14 | `BILLS_CALENDAR_TOKEN` lives in the query string; Datadog APM records `http.url` by default. | Calendar-required; redact in APM. |
| F15 | FMP/Massive next-due hole: classify path sets `cancelledNoRenew`, but a dashboard `POST /api/owner-expenses` without the flag still emits a VEVENT. | Calendar, not cash. |
| F16 | Gmail ghost repair matches exact old notes; seed notes have changed.  Active ghosts still materialize estimated charges into `spentUsd`. | Catalog-only rows billed as cash. |
| F17 | LLM burn card compares API-equivalent estimate to cash `monthlyBudgetUsd` and says "budget pace." | Estimate vs cash mix in UI. |
| F18 | Local Fleet tab shows "N/A / Not Connected" outside screenshot demo.  Reads as a failed connection, not Client-only. | iOS Local honesty. |
| F19 | Local `tabBarScrollClearance` stacks on system `TabView` insets (Client custom bar is single-apply). | iPhone SE empty bottoms. |
| F20 | Client APNs POST is session-only; read-token users (widget path) cannot enroll.  Settings still invites registration. | Push honesty. |
| F21 | PWA install banner is `fixed` bottom `z-[70]` with no matching `padding-bottom` on main. | Last-row hide on web PWA. |
| F22 | Command palette omits Agents (a primary nav page). | Discoverability. |
| F23 | Ingest admission `Retry-After: 5` while persist can take longer.  Producer-storm risk. | Backend |
| F24 | Retired Garage compose still deployable with `GARAGE_ALLOW_WORLD_READABLE_SECRETS=true`. | Ops landmine |
| F25 | Three generations of deploy/backup docs contradict (board `bba9984a`).  `DEPLOY.md` invariant #4 still describes Oracle auto-deploy.  SQLite data-loss runbook still says Oracle. | Docs vs Coolify |
| F26 | `/api/health` is always `{ ok: true }`.  Dockerfile HEALTHCHECK will not restart on DB/scheduler failure.  Intentional sole-writer protection if monitors use `/api/ready?strict=1`. | Ops |
| F27 | Client Money / Keys & Apps live in Providers overflow, not first-class like web `/money`. | Parity |
| F28 | No native Client workspace export → Local import.  Web has `GET /api/workspace/export`. | Parity |
| F29 | No `src/app/api/settings` or APNs route tests.  Dual-auth write bugs have no regression net. | Tests |

### P3 (grouped)

- Title Case drift: web "Keys & apps", "Paid services", "Add provider"; iOS "No spend yet", "Provider inventory".
- Sentence-gap helper exists on Platforms/Agents/Ops only; most JSX/SwiftUI copy uses a single space.
- `not-found` / `error` Retry buttons lack `min-h-11`.
- OTLP `accepted` includes idempotent retries; ingest `persisted` does not.
- Push-primary docs still list Robinhood as a blind adapter; catalog path is retired.
- Owner purchase history is hardcoded in `scripts/add-user-billing-receipts.mjs`.
- Infisical "safe" setter still puts `dest=value` on argv (`ps` on a shared Mac).
- Single `ENCRYPTION_KEY` with no previous-key decrypt (attribution HMAC already has previous keys).
- `TODO`/`FIXME` in app TS/Swift: **zero**.  Only a vendored OTEL proto comment.

---

## Surface notes

### Web (320 → 1920)

Nav overflow handling at md/lg/xl is intentional and looks correct.  Light default is correct.  The Agents page is the largest visual defect (undefined tokens + nested `<main>`).  Tablet table clipping is the next layout failure.  Dialog a11y is solid on `ModalDialog` / Add Provider and missing on Global Budget, projected-cost, and the command palette.  Touch targets drop below 44px once the hamburger is replaced at `md`.

### iOS Client + Local + widgets

Theme default light is correct.  Client glass pin contract (2–4 pins + More) matches the ST-style shell.  Tab-bar last-row hide was recently de-duplicated on Client (`tabBarScrollClearance` once at `RootView`); Local still stacks clearance on system `TabView`.  Client has Agents, Platforms, Projects, Settings subscriptions, LLM burn (session-gated).  Gaps vs web: first-class Money, receipt review, bills calendar, workspace export, owner expenses.  Local widget writer without an extension is a product lie, not a polish item.

### Backend

Auth on ingest, cron, and dual-read routes is generally sound.  The hole is treating a **read** token as a **write** token on settings and APNs.  Mac heartbeat is the unbounded ingest sibling that never got the body cap / admission lock.  `USAGE_READ_TOKEN` production fallback is correctly denied unless break-glass.

### Money

No silent live cash invention from email, OTLP, or paused/considering subscriptions.  The remaining cash bugs are **estimate written as invoice**, **two fixed sources added**, **owner prepaid vs HMAC prepaid inconsistency**, and **iOS remaining vs Global Budget**.  Forecast tests currently bless the 1-based day-index bug.

### Ops / CI

Highest blast radius is still Coolify shipping a red SHA (A1, already filed).  Weekly `/tmp` (A2) can 503 the box again.  `ios-ship` ASC streak is standing (D6).  Copy the same-repo guard onto the shared-package workflow (B4) before relying on `GH_PAT`.

---

## Suggested fix order

Do not start with copy or Title Case.

1. **Session-only `PUT /api/settings`.**  Dual-auth GET without email addresses.  Strip full APNs tokens from GET.  (B1–B5)
2. **Same-repo guard on `auto-merge-shared-dependency.yml`.**  (B4)
3. **Stop writing catalog estimates as `totalCost`.**  Stop adding plan-fixed on top of snapshot-included fixed.  (C1, C2)
4. **Move weekly R2 workdir off host `/tmp`.**  Guard overlapping scheduler ticks so `markTickStarted` cannot reset a live tick.  (A2, A3)
5. **Rewrite Agents + Mac Health onto `gray-*` / `accent` tokens.**  Drop nested `<main>`.  `overflow-x-clip` → `overflow-x-auto`.  (D1–D3)
6. **APNs Client ACK flag.**  Local widget extension **or** delete the dead writer.  (D4, D5)
7. **Bound + admit Mac heartbeat.**  Align OTLP logs limiter with metrics.  (E1, E2)
8. **Owner prepaid ≠ consumption.**  Decode Global Budget on iOS remaining.  Fix forecast elapsed fraction.  (C3, C4, F4)

Then: Coolify deploy gate (A1 / #1293), ios-ship secret parity (D6 / `5828a5b7`), DEPLOY.md Coolify rewrite (F25 / `bba9984a`).

---

## Coverage holes (no dedicated tests)

`src/app/api/settings/route.ts`, `src/app/api/apns/device-tokens/route.ts`, `src/lib/adapters/custom.ts`, `src/lib/crypto.ts`, `src/lib/otlp/protobuf-decode.ts`, `src/app/api/owner-expenses/route.ts`, `src/app/api/llm-burn/route.ts`.

---

## What this audit did not do

- Live click-through of usage.jays.services in a browser at 320/768/1280.
- iOS Simulator screenshots on SE / 15 / Pro Max / iPad.
- Production Infisical value inspection (names/lengths only, never dumped).
- Exploit PoCs (policy: report, do not write).
- Implementation PRs for the findings above.

Prior related audits (still useful, several leftovers remain): `docs/audits/2026-08-17-security-privacy.md`, `docs/audits/2026-08-17-backend-durability.md`, `docs/audits/2026-08-17-providers-accuracy.md`, `docs/audits/2026-07-20-grok3-full-app-expert-review.md`.
