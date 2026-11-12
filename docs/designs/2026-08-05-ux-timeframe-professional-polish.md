# Usage Monitor — UX panel: timeframe + professional polish (web + iOS)

**Date:** 2026-08-05  
**Status:** Implemented 2026-08-06 (web + iOS)  
**Authors:** Expert panel (web product design, iOS product design, design systems / fintech) + synthesis (GROK)  
**Owner ask:** Improve intuitiveness, aesthetic appeal, professional appearance; timeframe filter feels strange/illogical on **both** web and iOS.

---

## Executive summary

The product already has the **right money model** (MTD budgets always UTC calendar month; charts/telemetry use a separate history window). The UI **fights that model**:

| Problem | Web | iOS |
|---------|-----|-----|
| Default vs primary chips | Default = **this calendar month**, but chips are **24h/7d/30d/90d** → **More** looks selected on every load | Default = current month, buried in a long Menu |
| Global-looking control | History control sits in **page header** next to Refresh (reads as “filter whole Overview”) | TimeframePicker in **nav bar** (same false promise) |
| Dual vocabularies | Rolling vs calendar vs year vs all in one control; 24h vs 1d; 90d vs “3 months” | Overview: full `TimeframeOption`; provider detail: **7/30/90/365** only, different labels |
| Truthfulness | Rolling selection can still **label as current month** (`spendPeriodLabel`) | Same `periodLabel` trap; worse: Overview picker is largely a **dead control** (state unused) |
| Professional calm | Orange used for brand **and** incomplete/warning-adjacent UI; repeated MTD + coverage noise | Solid Theme tokens; control placement and dead filter undercut polish |

**Highest-leverage fix:** Treat history as a **scoped instrument** (“Chart range / History window”), put **This month** on the primary rail (selected by default), stop lying about labels, and on iOS either **wire or remove** the Overview picker.

---

## Product rule (must be visible and coded)

> **Budgets, provider spend, attention, and hero totals are always month-to-date (UTC calendar month).**  
> **History / chart range only filters historical charts, burn series, and usage-event lists.**  
> Never label MTD dollars with a rolling range; never label a rolling chart with a calendar month name just because budgets are MTD.

---

## Why the timeframe feels “illogical” today

### Web (`HistoryWindowControl` + `useDashboardData`)

1. **Default = `month:YYYY-MM`**, chips = `1d|7d|30d|90d` + More → cold load: **no chip selected**, More filled with “August 2026”.
2. Control is **above the whole Overview** → feels global; hero MTD $ does **not** change → trust hit.
3. Copy mixes **History / History window / timeframe** and jargon: *“Charts & telemetry · not MTD budget.”*
4. **24h** chip maps to `days=1` (day bucket), not true trailing 24h.
5. **90d** chip vs menu **“Past 3 months”** — different units.
6. `spendPeriodLabel(rolling)` always returns **current month name** — hero “History window” cell can disagree with selection.

### iOS (`TimeframePicker` vs `SnapshotHistoryRange`)

1. Overview: dense **Menu (~22 options)** in the toolbar — looks like a page period filter.
2. **Dead control risk:** selection may not drive visible Overview data (budget store stays MTD). Local app is more honest: plain “Month to date,” no fake filter.
3. Provider detail uses a **different** system: segmented **7d / 30d / 90d / 1y** for snapshots only.
4. Label glossary diverges from web and from provider detail.

---

## Recommended redesign

### Shared vocabulary (web + iOS)

| Token | Full label | Compact | Surfaces |
|-------|------------|---------|----------|
| `month:current` | This month | This month | Portfolio history primary chip; default |
| `7d` | Past 7 days | 7d | Primary |
| `30d` | Past 30 days | 30d | Primary |
| `90d` | Past 90 days | 90d | Primary (not “3 months” unless calendar) |
| `1d` | Past 24 hours | 24h | More only (or true trailing-24h later) |
| `180d` | Past 180 days | 180d | More |
| `all` | All time | All | More |
| `month:YYYY-MM` | August 2026 | Aug 2026 | More |
| `year:YYYY` | 2026 | 2026 | More |
| Provider snapshots only | Past 7/30/90 days, Past year | 7d/30d/90d/1y | Provider detail segmented |

### Primary control (web + iOS Overview history)

```
Chart range · charts only · budgets stay this month

[ This month ● ] [ 7d ] [ 30d ] [ 90d ] [ More ▾ ]
```

- **This month** selected on cold load (matches default `month:current`).
- **More** only selected for 180d / all / other months / years; button shows short label (`Jul 2026`, `All`).
- Drop **24h** from primary (demote to More).
- Rename control: **Chart range** or **History window** — never bare “Timeframe.”

### Placement

| Platform | Placement |
|----------|-----------|
| **Web** | Prefer **above the first chart/telemetry block** it drives; header keeps Refresh. If stays near title: must say **Chart range** + plain subtitle. |
| **iOS Overview** | **In-content** above portfolio history section — **not** leading nav. Until that section exists: **remove** the picker. |
| **iOS provider detail** | Keep segmented **7/30/90/365**; nest **inside** the history chart card (not a lonely card). |

### Copy (one system)

| Bad | Better |
|-----|--------|
| Charts & telemetry · not MTD budget | Changes charts and usage history only. Budgets stay month-to-date. |
| History (ambiguous) | Chart range / History window |
| Tap to edit (desktop) | Edit budget |
| Past 3 Months for `90d` | Past 90 days |

Helpers:

```ts
mtdSpendLabel()        // budget surfaces only
historyRangeLabel(tf)  // charts only — never reuse spendPeriodLabel for rolling
```

---

## Professional / aesthetic recommendations

### Design principles

1. **One primary number, one clock** — big $ is MTD unless explicitly switched.
2. **Calm by default; color means risk** — brand orange for identity/selection; red/amber only for watch/over; incomplete ≠ orange alarm.
3. **Honest labels** — “Known spend,” “Not reported,” as-of timestamps next to figures.
4. **Tabular money, two decimals** — consistent null (`—`).
5. **Operator density, not cramped** — compact padding, not 10px money caveats.

### Visual system tweaks

- Tokenize surfaces / text / semantic status (web is thinner than iOS `Theme`).
- Demote accent from body links; one primary CTA per region.
- Incomplete status: slate/blue-gray, not orange.
- Raise caveat type to ≥13px near money.
- Unify segmented control recipes (theme/density vs history).
- Hero = sole big MTD instrument; summary strip should not re-shout the same spend + caveats three times.
- As-of time first-class near figures that refresh.

### iOS-specific polish

- Remove dead Overview timeframe or wire to real portfolio telemetry.
- Local stays MTD-honest (no fake filter).
- Quiet Local identity after first launch (nav badge vs full-width banner).
- Merge history range into chart card header.

---

## Implementation plan (PR stack)

### PR 1 — Web timeframe truth (P0)

- Add **This month** primary chip; selected by default.
- Demote 24h to More; consistent day labels.
- `historyRangeLabel` vs `mtdSpendLabel`; fix hero history cell.
- Rename + plain-English subtitle; optional move above charts.
- Tests for default selection, URL params, MTD isolation.

### PR 2 — iOS timeframe honesty (P0)

- Remove or disable Overview `TimeframePicker` until it filters a visible section **or** ship portfolio history panel wired to `usageEventsQueryItems`.
- Provider detail: nest range control in chart card; shared labels.
- Shared glossary with web.

### PR 3 — Professional polish pass

- Semantic color tokens; incomplete ≠ brand orange.
- Hero/summary de-duplication; as-of prominence.
- Desktop copy; density/type floors for money-adjacent text.

### Explicit non-goals (v1)

- Custom absolute date range picker  
- Making budget-status historical  
- Forcing provider snapshot API to calendar months  
- Redesigning Local tabs beyond honesty  

---

## Acceptance criteria (summary)

**Web**

- [ ] Cold load: **This month** chip pressed; More not pressed  
- [ ] Changing range does **not** change hero MTD / budget meters  
- [ ] Changing range **does** change chart/usage-events query  
- [ ] Rolling ranges never display as current month name  
- [ ] No “below” copy if control is in the header  

**iOS**

- [ ] No dead controls  
- [ ] MTD surfaces ignore history selection  
- [ ] Provider 7/30/90/365 still correct  
- [ ] Local: no fake Overview timeframe  

---

## ASCII target (web)

```
┌ Overview ────────────────────────────── [ Updated 2:14 PM ] [Refresh] ─┐

┌ HERO — Account (MTD · UTC) ────────────────────────────────────────────┐
│  AUGUST 2026 SPEND                                                     │
│  $1,284.50                                                             │
│  ████████░░░░  of Global Budget                                        │
│  Chart range does not change this card                                 │
└────────────────────────────────────────────────────────────────────────┘

┌ CHART RANGE — charts & usage history only ─────────────────────────────┐
│  [ This month ● ] [ 7d ] [ 30d ] [ 90d ] [ More ▾ ]                    │
│  Budgets stay month-to-date                                            │
└────────────────────────────────────────────────────────────────────────┘
         ↓
   [ Burn / usage charts for selected window ]
```

---

## Sources

- Web expert review (HistoryWindowControl, useDashboardData, page placement)  
- iOS expert review (TimeframePicker, SnapshotHistoryRange, dead control, Local honesty)  
- Design systems expert review (tokens, orange overuse, dual-clock strip, wireframes)  

**Next step for owner:** approve PR 1 scope (web timeframe truth) and whether iOS Overview should **remove** the picker first or **ship telemetry + chips** in the same sprint.
