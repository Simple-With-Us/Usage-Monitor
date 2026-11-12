# Fleet Alerts On `/ops`

`/ops` renders the fleet's current alert state from the **shared alert ingress** rather than re-deriving health from each vendor.

## Why

Until now `/ops` had no awareness of the alert pipeline at all. It computed its own health — Congress.Trade health endpoint, Mac health, Sentry health, Coolify, budgets — and Zulip `#alerts` separately received whatever each vendor webhook sent it. Two sources of truth that can disagree, and one of them (`#alerts`) was unreadable.

The alert ingress inverts that. It is the **only writer** of alert state:

```
vendor webhook ──> alert ingress ──> Zulip #alerts   (standing status, edited in place)
                              └──> GET /status        (same state, machine-readable)
                                        │
                                        └──> /ops Fleet Alerts card
```

One writer, many readers. The dashboard and the channel show the same truth by construction.

Owning repo: [AI-Fleet-Coordinator](https://github.com/Simple-With-Us/AI-Fleet-Coordinator) → `workers/alert-ingress`. The contract lives there and is locked by `status.test.js`; if the shape changes, it changes with this page.

## Configuration

| Env var | Meaning |
|---|---|
| `FLEET_ALERTS_URL` | Base URL of the deployed ingress Worker, e.g. `https://alert-ingress.<account>.workers.dev`. Unset ⇒ the card renders **Not Configured**. |

No credential is needed here — `GET /status` is public on the ingress, and carries no secret by design.

`ALERT_WEBHOOK_URL` (Usage Monitor's own outbound provider-alerts webhook) is the natural place to point at the ingress too, so budget alerts flow through the same state machine. That is a separate owner change; see AFC-351.

## Behaviour

- **Degrades, never breaks.** Unset URL, non-2xx, unreachable host, or a malformed payload each render an explanatory card. An alert surface being down must not take out the ops page.
- **Cached briefly** (30s, 15s after a failure) so a busy page does not fan out a request per render, and a blip does not leave the view stale.
- **Firing first.** Topics sort by firing count, alerts by phase then severity, so problems are at the top.
- **Severity is not trusted blindly.** Only a phase of `alerting` may render as non-`INFO`, even if the ingress says otherwise — the card renders severity as colour, so a held incident must never look alarming.
- Polls every 30s, matching the rest of the page.

## Tests

```bash
npx vitest run src/lib/__tests__/fleet-alerts.test.ts
```

Covers the contract parse, defensive degradation on every malformed input, caching, failure back-off, and the ordering and severity rules.