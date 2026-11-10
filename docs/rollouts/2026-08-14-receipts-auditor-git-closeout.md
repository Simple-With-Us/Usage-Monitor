# Receipts worker Git closeout + leftover Monet items

Picked up Monet's "Cloudflare receipts worker repo" session after the weekly
usage cap.  Most of that chat had already landed (#1106/#1107/#1109/#1112/#1120
plus the later R2 enable/force-rebuild).  This note is the remainder.

## Receipts workers

- Do **not** split `workers/receipt-inbox` into its own GitHub repo.  It shares
  `workers/receipt-lifecycle.mjs` and the root `package.json`.
- `usage-monitor-receipt-inbox` is already Git-linked to
  `jaywedgeworth22/Usage-Monitor` `main` (Workers Builds deploy command
  `npx wrangler deploy --config workers/receipt-inbox/wrangler.jsonc`).  That
  path fires on every `main` commit and deploys inbox only.
- `usage-monitor-receipt-lifecycle-auditor` was still CLI-only (last modified
  2026-07-29).  Redeployed 2026-08-14 after `verify-lifecycle` confirmed the
  exact 180-day `evidence/` rule.  New version `471b79ce-bf7a-4540-89a0-bc65cd3ff59d`.
- Combined deploys stay `npm run receipt-inbox:deploy` (auditor first).

## Turso

Congress.Trade is **not** on hosted Turso.  Infisical `TURSO_DATABASE_URL` is a
`file:` URL (length 37, not `libsql://` / `turso.io`).  Coolify override
`file:/data/congress-trade/db.sqlite` matches the 2026-07-30 cutover.  The
`TURSO_*` names and the leftover `TURSO_AUTH_TOKEN` JWT are historical.  The
token can be deleted; a `file:` libsql client does not need it.

## Uptime title

The GitHub uptime issue title said "Oracle origin".  Production is Coolify on
Hetzner NBG1.  Title is now "Hetzner origin".  The PagerDuty dedup key is
unchanged so open incidents do not fork.

## Still owner-only

- Rotate the Backblaze UM application key (key ID leaked in the Monet
  transcript).
- Mint a fresh Congress.Trade-account R2 token into CT `R2_ARCHIVE_*` /
  `AWS_ACCESS_KEY_ID` (the shared `CLOUDFLARE_R2_*` key 401s).
- Optionally delete the stale `CLOUDFLARE_R2_*` rows in
  `~/.secrets/global-api-keys` now that Infisical is the runtime source.
- Optionally delete unused CT `TURSO_AUTH_TOKEN`.
