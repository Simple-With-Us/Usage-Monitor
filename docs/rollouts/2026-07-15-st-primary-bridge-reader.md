# Socratic primary-account Infisical bridge reader

This phase adds an independently default-off, read-only monitor source for the
primary SocraticTrade.com user account. It performs no identity creation and no
remote writes. Its Universal Auth identity, fixed project, `prod` environment,
and constant `/usage-monitor/st-primary/v1` path are isolated from the existing
ST application-root reader.

## Contract

The path must contain exact shared secrets `BRIDGE_MANIFEST_V1`,
`GEMINI_API_KEY`, and `DEEPSEEK_API_KEY`. The manifest is strict JSON with:

- `schemaVersion: 1`, `source: "socratic-trade-primary"`, `complete: true`, and
  a positive monotonically increasing integer `sequence`;
- exactly one `gemini.apiKey` entry bound to `google-ai` / `GEMINI_API_KEY` and
  one `deepseek.apiKey` entry bound to `deepseek` / `DEEPSEEK_API_KEY`;
- exact `capability: "apiKey"`, `status: "active" | "revoked"`, and either the
  lowercase raw SHA-256 value fingerprint or `null` for a revocation.

Unknown, missing, duplicate, partial, replayed, scope-mismatched, or
fingerprint-mismatched data fails closed and retains the database's
last-known-good complete set. A higher-sequence revocation persists an inactive,
keyless ownership tombstone even if it is the first observation.

## Monitor ownership

Bridge rows are always separate built-in Provider records labeled
`SocraticTrade.com · Primary account` and bound to `st-primary`. Existing
manual/app-root rows are never claimed. An exact duplicate credential is kept
as an inactive labeled alias so polling cannot double-count it. Both manifest
members apply in one database transaction.

The API exposes only safe source/scope/status/alias/read-only metadata. It does
not expose key previews, secret names, sequence values, fingerprints, or alias
target IDs. Credential, active state, and managed label cannot be changed in
the UI/API, browser requests cannot claim ownership metadata, and managed rows
cannot be deleted. A tombstone clears only the bridge-owned API key; billing
configuration, plans, allocations, history, and other fields remain intact.

## Enablement

Leave `INFISICAL_ST_PRIMARY_SYNC_ENABLED=false` until a separate reviewed writer
has published the contract and a least-privilege reader identity exists. Then
configure only `INFISICAL_ST_PRIMARY_CLIENT_ID` and
`INFISICAL_ST_PRIMARY_CLIENT_SECRET`. This change does not enable, deploy, or
mutate any live source.
