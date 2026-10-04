# iOS widgets never loaded data — root cause and fix

**Date:** 2026-10-04
**Seat:** MiniMax (`@MINIMAX`)
**Board:** `57d42d5809dd477d807625261b287582`
**Branch:** `minimax/ios-widget-data-flow`
**Worktree:** `~/apps/usage-monitor-minimax`

## Owner report

> "the ios app's widgets don't work and they say click here to load data and you
> click and then the app does work and has the data but never gets it back to
> any of the widgets. the widgets should have options too for those that could
> serve multiple purposes logically or when not then just have more widget
> options themselves I guess."

The specific shape of the report is the diagnostic clue: **the app loads fine and
the widget still says the same thing afterwards.** That rules out "the app cannot
fetch" and points squarely at the app → widget handoff.

## Root cause

Two independent defects, both in the app-group handoff between the two iOS apps
and the shared widget extension. All three share `group.com.simplewithus.usage`.

### Cause 1 — the Local app wrote a file no widget could read

`LocalAppModel.reload()` calls `LocalWidgetSnapshotWriter.write(from:)`, which
writes **`local-widget-snapshot.json`**. Every consumer of the snapshot — all
three `TimelineProvider` implementations and all three `AppEntity` queries — read
only `SharedStore.shared.read()`, which reads **`widget-snapshot-v2.json`**.

No reader for the Local filename existed anywhere in the repo. So on a
Local-Monitor install the app was writing correct data into a file that no widget
code path could ever open.

The two filenames had been chosen deliberately during the 2026-09-22 bundle-ID
migration so the two payloads would coexist in the unified container, and they do
coexist — the writer was correct and the *reader* was incomplete.

Two compounding facts in the same area:

- `LocalUsageMonitor` (project.yml) does **not** embed `UsageMonitorWidgetExtension`
  at all, so the Local app ships no widget of its own.
- `LocalWidgetSnapshotWriter` never called `WidgetCenter.shared.reloadAllTimelines()`,
  so even a correct payload would have waited out the widget's 30-minute
  `.after(...)` timeline policy before anything re-rendered.

### Cause 2 — nothing could distinguish "no data yet" from "storage is broken"

Every unavailable state rendered the same hard-coded `"Open the app to load …"`.
When the app group is genuinely unavailable, app and extension each fall back to
their *own* private `UserDefaults` and never see each other — no amount of tapping
the app will ever help, but the widget kept giving that advice. That is the loop
the owner described.

## Fix

### `WidgetSnapshotResolver` (new, `WidgetShared`)

A `struct` with an injectable container (not a bag of statics) that reads the
freshest app-group snapshot regardless of which app wrote it:

- reads both filenames and merges them **per-section** (Kodus review fix,
  2026-10-04): the budget core comes from the newer payload — both apps
  produce genuine budget data — while the server-owned sections
  (`llm`/`servers`/`mac`/`alerts`/`quotas`, plus `projects`/`spenders`)
  prefer the Client's non-nil value and fall back to Local only when the
  Client file is absent. A whole-payload newest-wins pick was a regression:
  the Local payload's `generatedAt` is the device clock, always newer than
  the server timestamp, so every Local reload (bootstrap, pull-to-refresh,
  add-provider, import) wiped those sections back to "Open the app to
  load …" — precisely the loop this PR set out to fix;
- a corrupt Local payload falls back to the Client's good one instead of blanking
  the widget;
- returns `WidgetSnapshotDiagnostics` naming the source, the payload age, whether
  the app group is available, and which file was *rejected* (as distinct from never
  written).

The Local payload needed its own decoder: `LocalWidgetSnapshotWriter` uses a
default-configured `JSONEncoder` (`deferredToDate` dates), while the Client wraps
its snapshot in a versioned envelope with `.iso8601` dates. Decoding the Local
file with the Client's decoder fails on every `Date`.

### `WidgetTimelineReloader` (new, `WidgetShared`)

One process-wide `WidgetCenter` reload throttle, now called by **both** apps.
`WidgetSnapshotStore.reloadWidgetsIfNeeded` delegates here instead of keeping its
own private copy, which is how the two drifted apart in the first place.

### Honest empty states

`WidgetUnavailableContent.init` now substitutes an actionable message when the app
group itself is unavailable, so a genuinely broken install stops telling the owner
to tap the app.

## New widget options and widgets

Owner asked for options "for those that could serve multiple purposes" and more
widgets "when not". Both, split by what actually varies:

**Options added to every tile** (`WidgetRowCount`, `WidgetSortOrder`):

- **Rows** — Compact (2) / Standard (4) / Full (8). A small family legibly fits a
  couple of rows and a large one wastes space on three, so this is a real choice.
- **Sort** — *Closest to Budget* vs *Highest Spend*. These are genuinely different
  lists: a cheap-but-nearly-spent provider and a rich-but-idle one swap places.
  Unbudgeted rows sort last (unknown utilisation, not 0%), and equal rows keep a
  stable name order so the widget doesn't reshuffle on every refresh.

The Mac and Alerts tiles were `StaticConfiguration` with no Edit Widget options at
all; they are now `AppIntentConfiguration` carrying the same options. The
`AppEnum` conformances live in `BudgetWidgetIntent.swift` because the widget test
target compiles `WidgetPresentation.swift` standalone with no AppIntents host.

**New data.** Subscription quota windows (`GET /api/quota-windows`) were fetched by
the in-app card and by background refresh, but were **never mirrored into the
widget snapshot** — so no widget could have shown them. `WidgetSnapshot.QuotaSection`
is new, written from `QuotaWindowsStore.refresh` and `BackgroundRefreshManager`.

**New widgets:**

- **Quotas topic** — how much of each plan window is left. Deliberately distinct
  from *LLM Burn*, which is trailing-window spend: one answers "what have I
  burned", this answers "how close am I to being cut off". A window with no number
  renders "Unknown", never a fabricated 0%.
- **Quotas tile** — its own home-screen widget, because burying it in a topic
  picker means it is never actually on the Home Screen.
- **Projects topic** — every project budget as a list, rather than only reachable
  by picking one project as the Budget topic's focus.

## Verification

- `xcodebuild build -scheme UsageMonitor` — **BUILD SUCCEEDED**
- `xcodebuild build -scheme LocalUsageMonitor` — **BUILD SUCCEEDED**
- `xcodebuild test -only-testing:UsageMonitorWidgetTests` — **TEST SUCCEEDED**,
  62 tests, 0 failures (11 new widget-presentation tests, 8 new resolver tests).

New regression tests pin the exact owner-reported state: a Local-only write with
no Client file must be readable, and the two payload encodings must not drift back
into a shape that only one of the two apps can decode.

## Notes for the next seat

- The Kit's SwiftPM test target (`UsageMonitorKitTests`) is **not** wired into any
  Xcode scheme and cannot be run with `swift test` (pre-existing iOS-only
  networking code fails to compile for macOS). The resolver tests were therefore
  placed in `UsageMonitorWidgetTests`, which does run, rather than in a target
  nothing executes.
- `LocalUsageMonitor` still does not embed the widget extension. Local Monitor
  users get their widget from the Client extension, reading the shared container —
  which the resolver now handles. Giving the Local app its own widget extension is
  a separate decision and was not made here.
