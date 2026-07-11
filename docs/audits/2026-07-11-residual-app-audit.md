# Residual app audit — 2026-07-11

Scope: independent pass over the `c8ccd7f` hardened integration base, excluding the separately-owned
third-party transparency drawer/catalog and release-maintenance scripts. No live writes or deployment.

## Fixed in `residual-audit-hardening`

| Severity | Finding | Resolution / evidence |
|---|---|---|
| High | Generic/manual providers fell through to the custom HTTP adapter and failed every scheduler/manual fetch with `endpoint is required`. | `provider-polling.ts` makes scheduler and Fetch Now explicit `manual_provider` no-ops; no adapter call or null snapshot write. |
| High | Provider creation grouped every same-name service as a shared balance even when credentials/accounts differed. | `provider-grouping.ts` permits implicit grouping only when normalized provider name and decrypted primary credential both match. Existing rows are deliberately not rewritten without a backup/data audit. |
| High | Direct project spend keyed only by provider name was subtracted from every duplicate provider row, dropping part of independent snapshot residuals. | Project attribution now subtracts name-keyed direct usage/fixed spend only from the canonical pushed-spend owner. Regression proves $5 direct + $10 duplicate snapshot remains $15. |
| Medium | Pipe-delimited in-memory summary/attribution keys could merge distinct legal source/provider/environment values. | Keys now use JSON tuple encoding; regression covers both summary and attribution collision shapes. |
| Medium | Project create accepted non-string names/descriptions and invalid budgets until Prisma returned 500; create/update normalization differed. | Shared project parser trims/bounds names, validates nullable descriptions and non-negative finite numeric budgets, returns 400 before Prisma, 409 on duplicate, and 201 on create. |
| Medium | Provider allocations accepted duplicate project IDs and unknown FKs, surfacing database errors instead of validation. | Parser rejects duplicates; create/update verify every referenced project before writing. |
| Medium | Subscription `autoRenew` used JavaScript truthiness (`"false"` became `true`); `knobEnv` accepted arbitrary/pollution-shaped keys and unbounded entries/values. | Booleans are strict; knob names must be bounded uppercase env identifiers with bounded maps/values. |
| Medium | External billing staleness ignored each caller's refresh-derived threshold and always waited 24 hours. | Freshness helper now honors a valid threshold and falls back to 24 hours only for invalid configuration. |
| Medium | Mobile responsive tables used `display:none` on `<thead>`, removing column headers from the accessibility tree while showing only CSS pseudo-labels. | Headers are now visually clipped but remain available to assistive technology. |

Verification: Node 24 full `npm run verify` green — ESLint, TypeScript, 51 test files / 273 tests,
migration-safety scenarios, SQLite backup checks, release-maintenance checks, startup configuration,
and the Next.js production build. `git diff --check` is also clean.

## Open findings mirrored to the effort log

1. Backup-backed audit/repair of legacy false `groupId` rows; canonical grouped spend/credit math.
2. Stable account identity for name-colliding `quota_sync` and `credit_balance` events.
3. Explicit primary/secondary credential clear/rotate semantics plus bounded, prototype-safe provider config.
4. Streaming body limit and 413 behavior for generic usage ingest.
5. Independent `SESSION_SECRET`, session version/rotation, and nonce/hash CSP migration.
6. Adapter `rawData` allowlisting/redaction and explicit privacy/retention classification.
7. Official-source verification of Hetzner currency before labeling plan prices USD.
8. Hide/disable or explain the now-safe generic/manual Fetch Now no-op in the integration UI.

## Deliberate non-actions

- No budgets, plan prices, provider identities, or credentials were invented.
- Duplicate OpenAI/Resend rows were not merged or deleted; live evidence says they are distinct lanes.
- No existing `groupId` or production business data was rewritten without a verified backup and owner-visible receipt.
