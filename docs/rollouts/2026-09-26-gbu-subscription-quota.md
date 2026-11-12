# 2026-09-26 — Grok Bot weekly via `gbu --json` (EXTRA source)

**Why:** Owner wants live `gbu --json` readings posted into Usage Monitor as an
EXTRA source beside CodeCaps' Cursor DashboardService reader, without replacing
it.  `bucketId: gbu-weekly` keeps `projectQuotaWindows` from collapsing the two.

**What landed**

- `scripts/lib/subscription-quota-parsers.mjs` — `parseGbuJson`.
- `scripts/subscription-quota-collector.mjs` — `--provider grok-bot` shells
  `gbu --json` (PATH prefers `~/.gbu/bin` and `~/.local/bin`), posts as
  `producerId=gbu` / `service=gbu` / `metadata.source=gbu`.
- `src/lib/quota-windows.ts` — `grok-bot` added to `EXPECTED_QUOTA_PROVIDERS`
  with label "Grok Bot".
- LaunchAgent plist.example PATH now includes `$HOME/.gbu/bin` and
  `$HOME/.local/bin`.

**Absolutes** (`includedSpend` / `includedLimit` / `includedRemaining` /
`onDemandUsed` / account email) stay in event metadata only.  The shared
quota-window projection still has no absolute fields.

**Token follow-up:** prefer `GBU_INGEST_TOKEN` when
`USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`.  Until then the collector falls back
to `SUBSCRIPTION_QUOTA_INGEST_TOKEN` / `USAGE_INGEST_TOKEN` like the other
providers.  Do not mint secrets in chat.

**Host follow-up:** refresh the installed LaunchAgent PATH from the updated
plist.example (live agent currently lacks `~/.gbu/bin` / `~/.local/bin`).  The
collector also prepends those dirs when spawning `gbu`, so PATH is belt and
suspenders.

**Verify**

```bash
node scripts/subscription-quota-collector.mjs --provider grok-bot \
  --fixture scripts/__tests__/fixtures/gbu-json.json --dry-run --redacted
node scripts/subscription-quota-collector.mjs --provider grok-bot --dry-run --redacted
npx vitest run scripts/__tests__/subscription-quota-collector.test.mjs \
  src/lib/__tests__/quota-windows.test.ts
```

**Deferred:** flaxodotdev `usage` CLI (no `--json`).  BotFleet `grok-quota.ts`
stays the intentional Grok CLI no-source stub.
