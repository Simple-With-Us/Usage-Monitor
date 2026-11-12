# 2026-08-10 — OpenRouter credit probe on Usage Monitor + dedicated UptimeRobot

## Summary

Real OpenRouter money monitoring lives on **Usage Monitor**, not Socratic
`/api/health`. A public probe checks account prepaid credits and every key’s
spend limit via a Management key; a **new** UptimeRobot keyword monitor watches
it. The existing ST “OpenRouter credits low” monitor is left unchanged.

## Endpoint

`GET https://usage.jays.services/api/openrouter-credits` (public, no session)

Keyword (ALERT_EXISTS, case-sensitive):

```text
"openrouterCredits":{"ok":false
```

`ok=false` when:

- account prepaid remaining &lt; `OPENROUTER_LOW_CREDIT_USD` (default $3), or
- any **enabled** key has `limit_remaining ≤ 0` (limit reached), or
- any **enabled** key has `limit_remaining` under `OPENROUTER_KEY_LIMIT_LOW_USD` (default $3)

Fail-open on read errors (never page because OpenRouter was unreachable).
USD figures are withheld on the public body.

## Credentials

Prefer Infisical (UM project) `OPENROUTER_ADMIN_KEY` or
`OPENROUTER_MANAGEMENT_KEY`. Fallback: active Provider row named `openrouter`
labeled management/admin/provisioning.

## Code

- `src/lib/openrouter-credit-probe.ts`
- `src/app/api/openrouter-credits/route.ts`
- middleware public path + tests

## UptimeRobot

New monitor (separate from ST health keyword):

- Name: `OpenRouter credits + key limits (Usage Monitor)`
- URL: `https://usage.jays.services/api/openrouter-credits`
- Type: KEYWORD, ALERT_EXISTS
- Keyword: `"openrouterCredits":{"ok":false`
- Interval: 300s (or plan minimum)
