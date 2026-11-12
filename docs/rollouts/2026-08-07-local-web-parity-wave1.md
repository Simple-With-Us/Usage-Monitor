# 2026-08-07 — Local iOS ↔ web parity wave 1

## Goal
Close the largest **UI/money-surface** gaps between **Local Usage Monitor** and the web (and remote iOS client) without claiming impossible features (OTLP, fleet ops, residual % project allocation).

## Shipped

### BudgetEngine
- Per-provider + summary **EOM projection parts**: paced variable, fixed accrued, remaining scheduled renewals (same composition as web `projectedEomUsd`).
- Summary counters: exceeded/warning/configured budget counts; `remainingUsd` / `hasBudget`.

### Overview
- Web-like **hero** (spent, status chip, meter, budget caption).
- **Stats grid**: Projected End of Month, Remaining / no budget set, Needs Attention, Providers Tracked.
- **Projection breakdown** card (usage + fixed + renewals).
- **Needs Attention** list + **Top Providers** with monograms and composition captions.
- **Recurring Fees** card for active subscriptions (Paid Services parity).

### Providers
- Search, horizontal **status filters**, sort menu, summary header, spend/budget rows (remote list parity).

### Projects
- **All Projects** rollup card at top of list.

### Settings / detail
- Subscriptions inventory section; Title Case buttons per `docs/FLEET-UI-COPY.md`.
- Provider detail **EOM Projection Parts** section.

## Explicit non-goals (still web-only)
- Intelligence (LLM burn, Claude cost check, key attribution)
- Ops / Sentry / receipt inbox
- Residual project % allocations
- Live ingest / OTLP
- External-billing auto-adoption

## Follow-ups
- Money tab or richer history windows for poll series
- Provider integration drawer / connection checklist copy from web
- Global portfolio budget setting
