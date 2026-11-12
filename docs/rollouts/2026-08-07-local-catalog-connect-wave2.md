# 2026-08-07 — Local catalog connection wave 2

## Owner asks
1. OpenAI lacked a separate ChatGPT row (Claude already split) — fixed.
2. Capitalize **Other** in Custom / Other.
3. xAI label must not append “Grok” (SuperGrok is separate).
4. Stop showing `subscription_only` — human connection abilities.
5. “Seed template” wording was unintuitive → **Add Missing Providers**.
6. Connect all sources with durable on-device data (survives updates; not App Store–shared).
7. Flesh out each provider’s connection abilities; continue autonomy on parity waves.

## Shipped
- Catalog model: `LocalConnectionAbility` + chips/details per entry.
- Rows: **OpenAI (API)**, **ChatGPT (subscription)**, **xAI**, **SuperGrok (subscription)**, **Claude (subscription)**, **Custom / Other**.
- Bootstrap `ensureCatalogProviders()`: adds missing inactive shells, heals known renames, stores non-secret connection profile JSON on each row.
- Add UI: connection summary + ability chips; Settings buttons renamed.
- Persistence: SQLite under app container (survives App Store updates); Keychain for secrets; nothing secret in the binary.

## Explicit non-goals still open
- Residual project % allocations, OTLP/intelligence, full invoice list for every vendor.

## Follow-ups
- Per-provider connection wizard with deep links to console pages.
- Global portfolio budget.
- Poll history range control.
