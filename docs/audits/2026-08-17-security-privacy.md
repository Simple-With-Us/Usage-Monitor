# Usage Monitor — security and privacy audit

**Date:** 2026-08-17
**Reviewer:** Cursor (Grok 4.6), read-only
**Roles:** application security, privacy, financial-data security, incident response
**Worktree:** `/workspace` on `main` at `8db78b5` (postal-mime bump #1232)
**Method:** static review of auth, crypto, ingest, receipts, backups, alerts, iOS, CI, and Workers.  No production mutations.  No secret values, tokens, or key material are reproduced here.

**Verdict:** The money path is fail-closed where it matters.  Ingest, receipt cash, and dashboard writes are separated by distinct credentials.  Provider keys are AES-256-GCM at rest and redacted from client DTOs.  Receipt MIME cannot create cost events.  Residual risk is concentrated in **read-token privilege expansion**, **ENCRYPTION_KEY rotation / recovery**, **Cloudflare fleet-token blast radius**, and **shallow nested redaction** of poll snapshots.  No unauthenticated write to cash, and no committed live secrets, were found.

This is a report-only audit.  It does not implement fixes.

---

## 1. Scope

| Surface | In scope |
|---------|----------|
| API keys / secrets | Env, Infisical, `Provider.apiKey` / `secretConfig`, encryption, rotation |
| Token storage | Dashboard session, ingest/read/receipt tokens, iOS Keychain |
| Account isolation | Producer scoping, project attribution, single-tenant model |
| Logs | `console.*`, Sentry, alert HTML, Workers observability |
| Receipt email ingestion | `workers/receipt-inbox/`, lifecycle auditor, HMAC importer |
| Billing data privacy | Schema, `rawData`, metadata, exports, seed scripts |
| AuthN / AuthZ | Middleware, CSRF, cron, dual-auth routes |
| Dependency risk | lockfile, Dependabot, `npm audit`, git-URL pin |
| Backups | Litestream/B2, weekly R2, pre-migration SQLite snapshots |
| R2 access | Historic usage, receipt evidence, fleet tokens |
| Alert webhooks | Slack, generic webhook, PD, Resend, Pushover, APNs |
| Recovery | Restore drills, key rotation, IR runbooks, audit trail |

Out of scope: live Infisical values, live host SSH, destructive restore, secret printing, implementation PRs.

---

## 2. Threat model

### 2.1 Assets

| Asset | Sensitivity | Where it lives |
|-------|-------------|----------------|
| Provider API keys and secondary secrets | Critical | SQLite `Provider.apiKey` / `secretConfig` (AES-256-GCM); Infisical; process env |
| Dashboard password + session signing key | Critical | Infisical / host env; HKDF-derived cookie HMAC |
| Ingest / read / receipt / evidence tokens | Critical | Infisical; iOS Keychain (read token) |
| Month-to-date spend, budgets, subscriptions | High (financial) | SQLite + daily rollups + B2 replica |
| Receipt MIME (names, last4, line items) | High (PII + financial) | Private R2 `evidence/{64-hex}.eml`; fallback mailbox |
| Alert routing (Pushover, Slack, PD, email) | High | Env; ephemeral `PUT /api/settings` |
| Backup replicas | Critical (same as DB) | B2 Litestream; weekly R2 archive; `/data/.pre-migration-backups/` |
| Cloudflare / Coolify / Hetzner monitor tokens | High | Infisical; some fleet-wide |

### 2.2 Actors

| Actor | Capability if successful |
|-------|-------------------------|
| Unauthenticated internet | Hit public probes (`/api/health`, `/api/ready`, `/api/openrouter-credits`); brute login; hammer ingest 401s |
| Stolen `USAGE_READ_TOKEN` (iOS, automation) | Read budgets, subscriptions, rollup export, operations, **and today some writes** (settings, APNs) |
| Stolen unscoped `USAGE_INGEST_TOKEN` | Forge usage events as any `sourceApp` (v1); not receipt cash |
| Stolen `BILLING_RECEIPT_INGEST_TOKEN` + HMAC keys | Forge prepaid cash events |
| Stolen dashboard session / password | Full operator: providers, keys, subscriptions, budgets |
| Compromised sibling `*.jays.services` origin | CSRF against SameSite=Lax cookie unless Origin check holds |
| Stolen Cloudflare fleet token | Analytics / list across all four CF accounts |
| Host root / Infisical writer | Full secret set + live DB + backups |
| Lost iOS device | Read token in Keychain (this-device-only, not in iCloud backup) |

### 2.3 Trust boundaries

```
Internet
  │
  ├─ Cloudflare edge ── usage.jays.services (Coolify / Hetzner)
  │     ├─ middleware session / CSRF
  │     ├─ public probes
  │     ├─ bearer ingest / OTLP / receipt HMAC
  │     └─ SQLite /data ── Litestream ── B2 (primary) + weekly R2 (historic)
  │
  ├─ receipts.jays.services (Email Routing Worker)
  │     ├─ Durable Object admission
  │     ├─ R2 evidence/ (180d lifecycle)
  │     └─ fallback mailbox  (no billing ingest keys on Worker)
  │
  ├─ iOS Client Monitor ── Keychain read token + cookie session
  └─ Producers (ST / CT / Claude Code / Mac heartbeat)
```

The inbox Worker is intentionally **not** a money writer.  Cash enters only through `POST /api/ingest/usage` with a distinct receipt token and HMAC.

### 2.4 Accepted architecture (not bugs)

- **Single-tenant shared password.**  One `DASHBOARD_PASSWORD`, no user table, no MFA, no per-operator RBAC.  Appropriate for an owner-operated monitor; treat password/session leak as full compromise.
- **Public `/api/ready` and `/api/health`.**  Uptime and deploy gates need unauthenticated liveness.  Paths and secrets are omitted; operational detail is intentional.
- **Public `/api/openrouter-credits`.**  UptimeRobot keyword probe.  Dollar balances are stripped from the public shape.
- **Permanent idempotency tombstones.**  Money integrity over erasure.  Documented in `src/lib/data-retention.ts`.
- **`project` excluded from ingest idempotency.**  Shared v2 contract.  Attribution can change on replay without re-keying.

---

## 3. Findings

Severity: **Critical** = unauthenticated secret or cash write.  **High** = privilege expansion, recovery break, or fleet-wide credential blast radius.  **Medium** = durable sensitive data, isolation gap, or IR gap.  **Low** = hardening.  **Info** = accepted or latent.

No Critical findings.

### High

#### H1 — `USAGE_READ_TOKEN` can mutate live alert routing

**Evidence:** `src/app/api/settings/route.ts:11-18,54-80`.  `PUT` uses the same `isAuthorized()` as `GET` (session **or** read bearer).  `src/middleware.ts:33` excludes `/api/settings` from the session gate.  The handler writes `process.env.ALERT_EMAIL_ENABLED`, `ALERT_MIN_SEVERITY`, `PUSHOVER_USER_KEY`, and `PUSHOVER_API_TOKEN`.

**Impact:** A token documented as read-only can disable email, lower the severity floor, and inject Pushover credentials into the running process until restart.  Combined with H2 (email addresses on GET) this is a full alert-channel takeover for one process lifetime.  iOS and any automation holding the read token inherit write.

**Fix:** Restrict `PUT` to a dashboard session (mirror `POST /api/subscriptions` and `PUT /api/settings/global-budget`).  Keep GET dual-auth if iOS needs channel status; return booleans only.

#### H2 — GET `/api/settings` returns operator alert emails to any read token

**Evidence:** `src/app/api/settings/route.ts:45-49` includes `{ from, to }` for the email channel.  Dual-auth as above.

**Impact:** Read-token theft discloses `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` (personal contact data) plus a Pushover user-key preview.

**Fix:** For bearer callers return `emailConfigured: true` without addresses.  Session-only for From/To.

#### H3 — No `ENCRYPTION_KEY` rotation or multi-key decrypt

**Evidence:** `src/lib/crypto.ts:8-46` uses a single 64-hex key.  Wrong key → GCM auth failure.  Attribution HMAC has `ATTRIBUTION_IDENTITY_HMAC_PREVIOUS_KEYS` (`.env.example:28-30`); credentials do not.  Pre-migration backups explicitly contain every credential row (`scripts/backup-sqlite-before-migrate.mjs` comment).  Litestream replicas are the same ciphertext.

**Impact:** Compromised or rotated `ENCRYPTION_KEY` without a re-encrypt pass makes all `Provider.apiKey` / `secretConfig` unreadable on the live DB **and** on every restore.  There is no runbook (`docs/runbooks/` has only the SQLite data-loss note).

**Fix:** Add `ENCRYPTION_KEY_PREVIOUS` decrypt, a transactional `--reencrypt` script after a pre-migration backup, and `docs/runbooks/secret-rotation.md`.  Set a dedicated `ATTRIBUTION_IDENTITY_HMAC_KEY` so attribution fingerprints do not rotate with the credential key.

#### H4 — Cloudflare fleet token spans all four accounts

**Evidence:** `src/lib/r2-usage.ts:1748-1772` falls back to `CLOUDFLARE_FLEET_API_TOKEN` for Jay, ST, CT, and Old.  AGENTS.md (2026-08-14 live map): fleet/CT/legacy/`R2_USAGE` share one all-accounts token.  `scripts/cf-token-map.sh` is value-blind.

**Impact:** One leaked token yields GraphQL analytics and list visibility across Usage.Jays.Services, Socratic.Trade, Congress.Trade, and Jay Old.  Not a code injection; it is production blast radius.

**Fix:** Prefer per-account tokens in Infisical; drop fleet fallback in production resolution once JAY/ST/CT/OLD are verified.  Re-run `cf-token-map.sh` after rotation.  Never print token values.

---

### Medium

#### M1 — Unscoped ingest token can impersonate any v1 `sourceApp`

**Evidence:** `src/lib/ingest-auth.ts:56-63` sets `allowedSourceApps: null` for `USAGE_INGEST_TOKEN` unless `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`.  Scope is enforced only when the set is present (`src/app/api/ingest/usage/route.ts:235-243`).  v1 parser accepts client `sourceApp`.  v2 forces `sourceApp` from `batch.producerId`.

**Impact:** A leaked unscoped ingest token forges usage as Congress.Trade, Socratic.Trade, or any label, polluting budgets and rollups.  It cannot forge receipt cash (separate token + HMAC) or `sourceApp="subscription"` (reserved, lines 221-233).

**Fix:** Enable `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true` in production.  Migrate ST/CT/Claude Code/Mac to `USAGE_INGEST_PRODUCER_TOKENS`.

#### M2 — Read bearer can register APNs devices and read full device tokens

**Evidence:** `src/app/api/apns/device-tokens/route.ts:9-16,23-51`.  Middleware excludes `/api/apns` (`src/middleware.ts:32`).  GET spreads the full `deviceToken` **and** a preview (`:37-44`).  POST upserts any token.

**Impact:** Read-token holder can enroll a device into budget/alert pushes and exfiltrate every active APNs token (device identifier).

**Fix:** Session-only for listing full tokens.  iOS registration may keep POST with the read token if that is the client path — then omit full tokens from GET and rate-limit registration.

#### M3 — Secret-migration classifier omits `apiKey`

**Evidence:** Runtime `ALWAYS_SECRET_KEYS` includes `"apikey"` (`src/lib/provider-secret-config.ts:17-22`, Wave G / E18).  Migration `scripts/lib/provider-secret-migration.mjs:9-30` does not.  Parity test (`src/lib/__tests__/maintenance-scripts.test.ts:92-121`) never includes `"apiKey"`, so drift is invisible.

**Impact:** Legacy `Provider.config.apiKey` plaintext can remain in SQLite after `--apply`.  Client APIs redact via the runtime classifier; disk, backups, and direct DB access still see plaintext.

**Fix:** Add `"apikey"` to the migration set, extend the parity test, re-run `--apply` after backup.  Add a readiness count of secret-shaped keys still in `config`.

#### M4 — `UsageSnapshot.rawData` allowlist is shallow

**Evidence:** `src/lib/data-privacy.ts:34-38,126-141`.  Top-level only.  Allowlisted keys include `keys`, `invoice`, `billing`, `activity`, `externalBilling`.  Applied before persist (`src/lib/usage-recorder.ts:105-108`).  Custom adapters are strip-all (`:160-172`).

**Impact:** Nested emails, tokens, or account identifiers under an allowlisted key survive up to snapshot retention (45 days; cost-bearing rows keep `rawData` until row delete, `src/lib/data-retention.ts:200-203`).  Current OpenRouter path stores hashes, not raw keys — the contract is fragile for the next adapter.

**Fix:** Deep-redact known PII/secret subpaths for `keys` / `invoice` / `billing`.  Per-adapter persisted-`rawData` tests.

#### M5 — Alert webhook URLs have no SSRF guard

**Evidence:** `src/lib/alert-delivery.ts:871-896,1064-1079` posts JSON to `ALERT_WEBHOOK_URL` / Slack webhook from env.  Adapter `fetchJson` can pin DNS and block private IPs (`src/lib/adapters/helpers.ts:311-318,474-511`) — **opt-in**, and not used here.

**Impact:** Requires Infisical/env write (or H1).  A malicious URL can hit metadata/link-local/internal HTTP.  Payloads do **not** include API keys (alert text is provider + message; PD `custom_details` is id/code/time only).

**Fix:** HTTPS-only allowlist (`hooks.slack.com` + operator host).  Reject RFC1918 / link-local / metadata.  Optional HMAC signing secret.

#### M6 — `/api/health/mac` is bearer-only despite a session comment

**Evidence:** `src/app/api/health/mac/route.ts:7-11` checks only `isUsageReadAuthorized`.  Comment says “bearer OR dashboard session.”  Middleware treats `/api/health/*` as public (`src/middleware.ts:35,56`), so unauthenticated requests reach the handler and 401.  Session-only web clients also 401.

**Impact:** Broken dual-auth, not a bypass.  Dashboard session users cannot load Mac health without also sending the read token.

**Fix:** Dual-auth like `budget-status` (session **or** read bearer).

#### M7 — Owner financial history committed in a seed script

**Evidence:** `scripts/add-user-billing-receipts.mjs:35+` hardcodes purchase amounts, labels, and Apple/transaction-style refs.  Writes via Prisma, bypassing the HMAC import gate.

**Impact:** Anyone with repo access sees detailed owner spend.  The private HMAC importer (`scripts/import-private-billing-receipts.mjs`) is the hardened path (mode 0600, no symlink, size caps, production URL lock).

**Fix:** Move seed events out of git (encrypted local file).  Gate the script on an env flag.  Do not add more receipts to the repo.

#### M8 — No general mutation audit trail

**Evidence:** `BudgetControlEvent` is append-only for automated pause/recommend (`prisma/schema.prisma` budget-control block).  Provider/subscription/settings edits have no who/when/what log.  `PUT /api/settings` is silent.

**Impact:** After a stolen session or H1, IR cannot answer “what changed” from the app.  Infisical audit covers env, not SQLite operator edits.

**Fix:** Append-only `SettingsChangeEvent` (actor class, route, field names, timestamp — never values).  Document Infisical audit as the secret-change source.

#### M9 — No unified secret-rotation runbook

**Evidence:** `docs/runbooks/` contains only `sqlite-data-loss-incident.md` (still titled for the Oracle A1 VM).  Attribution HMAC rotation is documented piecemeal.  Receipt, ingest, Litestream, CF, and `ENCRYPTION_KEY` rotations are not in one place.

**Impact:** Ad-hoc rotation risks ciphertext/backup mismatch (H3) and stale Worker vs app tokens.

**Fix:** `docs/runbooks/secret-rotation.md` covering ingest, read, receipt, dashboard password, `SESSION_SECRET`, `ENCRYPTION_KEY`, B2, R2, inbox tokens, CF, alert webhooks.

#### M10 — Shared-dependency auto-merge lacks a same-repo guard

**Evidence:** `.github/workflows/auto-merge-shared-dependency.yml` is `pull_request_target` with `contents: write` and **no** `head.repo.full_name == github.repository` check.  `auto-merge-prs.yml:46` has that guard.  Both no-op without `GH_PAT` / `SHEPHERD_TOKEN`.  Effort log says `GH_PAT` is now set on UM.

**Impact:** A fork PR whose title/ref matches congress-trading-shared heuristics could be auto-merged if the PAT can merge forks.  No untrusted checkout today.

**Fix:** Copy the same-repo (and trusted-bot) guard before relying on `GH_PAT` for this workflow.

#### M11 — Receipt lifecycle auditor token is account-wide R2 read

**Evidence:** `workers/receipt-inbox/README.md` documents Workers R2 Storage Read on the auditor.  `workers/receipt-lifecycle-auditor/wrangler.jsonc` has `workers_dev: false` and no public route.  Inbox `/audit` is service-binding only.

**Impact:** Auditor-token leak can list/read R2 objects on that Cloudflare account, not only `usage-monitor-receipts`.  Inbox itself never holds billing HMAC keys.

**Fix:** Keep no public routes (already).  Rotate on any auditor compromise.  Prefer the narrowest CF scope available.

#### M12 — Producer `metadata` is bounded but not content-filtered

**Evidence:** Up to 50 keys × 500 chars (`src/lib/usage-telemetry.ts`).  Persisted on `ExternalUsageEvent`.  OTLP **does** allowlist metadata and excludes `user.email` / `session.id` (`src/lib/otlp/mapping-utils.ts:24-47`).  Generic ingest does not.

**Impact:** Any ingest credential can store email-like strings until raw-event retention (90 days default).  Daily-rollups omit metadata.

**Fix:** Blocklist keys matching `/email|phone|address|ssn|card/i` on generic ingest.  Keep OTLP allowlist.

#### M13 — Transitive `deepmerge-ts` 7.1.5 via Prisma

**Evidence:** `package-lock.json` pins `deepmerge-ts@7.1.5` under `@prisma/config`.  GHSA-ggr8-5vv4-36mx (stack exhaustion on deep merge).  CI runs `npm audit --audit-level=high` (`.github/workflows/ci.yml:276-277`).

**Impact:** Likely Prisma CLI / config merge, not a request-path primitive.  Still a gated advisory the next Prisma bump should clear.

**Fix:** Track Prisma upgrade.  Do not `--audit-level` downgrade to hide it.

---

### Low

#### L1 — Mac heartbeat ignores producer scope

**Evidence:** `src/app/api/ingest/mac-heartbeat/route.ts:7-11` accepts any ingest credential.  No `allowedSourceApps` check.

**Impact:** A scoped ST/CT token can POST fabricated Mac host telemetry.

**Fix:** Require a `mac-host` scoped token (or the unscoped token only while scoped mode is off).

#### L2 — Project name spoofing on ingest

**Evidence:** `src/app/api/ingest/usage/route.ts` resolves producer `project` case-insensitively.  Any authorized producer can attach cost to any existing `Project.name`.

**Impact:** Single-tenant mis-attribution, not cross-tenant.  `project` is not in the idempotency basis (shared contract).

**Fix:** Optional producer→project allowlist.

#### L3 — Sentry init has no PII scrubber

**Evidence:** `src/sentry.server.config.ts:14-20` — DSN-gated, traces default 0, no `sendDefaultPii: false` or `beforeSend`.

**Impact:** If a DSN is set, an uncaught error that includes request/env fragments could leave the host.  Current ingest paths do not log bodies.

**Fix:** `sendDefaultPii: false` plus a `beforeSend` strip of `Authorization`, cookies, `apiKey`, `secretConfig`.

#### L4 — Alert email HTML is unescaped

**Evidence:** `src/lib/alert-email.ts:10-17` interpolates `providerLabel` / `message` into HTML.

**Impact:** Self-injected alert text could HTML-phish the operator inbox (single owner).

**Fix:** HTML-escape all dynamic fields.

#### L5 — `.gitignore` covers `*.p8` but not `*.pem`

**Evidence:** `.gitignore:29-33`.

**Impact:** A PEM dropped in the repo root can be staged with `git add -A`.

**Fix:** Add `*.pem` and `*.key`.

#### L6 — Generic webhook is unsigned

**Evidence:** `postJson("Alert webhook", …)` with no HMAC header.

**Impact:** Receiver cannot prove origin.  MITM on the URL can inject fake alerts.

**Fix:** Optional `ALERT_WEBHOOK_SIGNING_SECRET`.

#### L7 — `dashboard_session` `Secure` only when `NODE_ENV=production`

**Evidence:** `src/app/api/auth/login/route.ts:104-108`.  HttpOnly and SameSite=Lax are set.  Session TTL is 30 days (`src/lib/auth.ts:4`).

**Impact:** Fine for local HTTP.  Any networked non-production host should force Secure.

**Fix:** `SESSION_COOKIE_SECURE=true` override.  Consider a shorter TTL or idle timeout.

#### L8 — Public `/api/ready` is an ops encyclopedia

**Evidence:** `src/app/api/ready/route.ts:321-387` — revision, scheduler, disk free/total, backup layers, admission metrics, budget-control counts, read-token **booleans**.  Absolute DB path is omitted.

**Impact:** Recon for attackers.  Accepted for uptime.  Rate-limited 30/min/IP.

**Fix:** Optional `?strict=1` remains the deploy gate; consider hiding `checks` behind session for anonymous callers.

#### L9 — OTLP logs rate-limit by shared IP

**Evidence:** Logs route limits before/without the metrics-route identity hash.  Logs are accept-and-drop (no DB).

**Impact:** One noisy CF egress IP can 429 others.  CPU/log spam only.

**Fix:** Authenticate first, then limit by token hash (metrics pattern).

#### L10 — `ENCRYPTION_KEY` validated on first use, not boot

**Evidence:** `src/lib/crypto.ts:8-19`.  `/api/ready` has no encryption-key boolean.

**Impact:** Misconfigured deploy serves until the first provider decrypt.

**Fix:** Secret-free `checks.encryptionKey` on `/api/ready` (present / valid-hex only).

---

### Info (positive or accepted)

| ID | Note |
|----|------|
| I1 | Receipt inbox cannot create cost events.  Distinct read vs evidence tokens; reuse rejected (`workers/receipt-inbox/src/index.mjs:343-351`).  Domain-scoped to `*@receipts.jays.services`. |
| I2 | Receipt cash requires distinct ingest token, HMAC verify, provider UUID/name bind, and signature strip before persist.  Tokens that match `USAGE_INGEST_TOKEN` 503 the route (`src/app/api/ingest/usage/route.ts:131-137`). |
| I3 | Session HMAC is HKDF from `SESSION_SECRET`, not the password.  Password compare is scrypt + `timingSafeEqual`.  CSRF Origin / `Sec-Fetch-Site` runs **before** public-path bypass when a cookie is present. |
| I4 | iOS stores the read token in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`TokenStore.swift:32-36`).  App Group holds widget snapshot, not the bearer.  Local app stores provider keys in Keychain, not SQLite. |
| I5 | Container runs as `USER node` (`Dockerfile:70`).  Secrets injected at start via Infisical, not image layers. |
| I6 | Pre-migration backups: dir 0700, umask 0077, symlink reject, integrity_check.  Restore scripts refuse to overwrite a live DB.  2026-08-14 UM B2 restore PASS. |
| I7 | Security workflow refuses fork PRs and untrusted bots; gitleaks on PR/push/weekly.  Dependabot weekly npm. |
| I8 | Repo secret scan (this audit): no `sk_live_` / `xoxb-` / `AKIA` / live 64-hex in `docs/rollouts`.  Test fixtures use obvious fakes (`sk_live_FAKE`).  No committed live secrets identified. |
| I9 | Privacy policy (`/privacy`) documents local wipe and “delete the instance database.”  No automated GDPR export/erasure API — acceptable for single-owner self-host, but R2 + fallback mailbox are extra stores (see §6). |

---

## 4. Domain notes

### 4.1 Authentication and authorization

| Route class | Gate |
|-------------|------|
| Pages + most `/api/*` | `dashboard_session` cookie (middleware) |
| Login | Password + 5/min tuple + 20/min CF-aware backstop; 4 KiB body |
| Cron | `x-cron-secret` vs `CRON_SECRET` (SHA-256 + `timingSafeEqual`) |
| Ingest / OTLP | Bearer or `x-usage-ingest-token`; optional producer scope |
| Receipt cash | Distinct bearer / `x-billing-receipt-ingest-token` + HMAC |
| Read APIs | Session **or** `USAGE_READ_TOKEN` (required in production) |
| Public probes | `/api/health`, `/api/ready`, `/api/openrouter-credits` |

Middleware prefix exclusions (`/api/ingest`, `/api/otlp`, `/api/cron`, `/api/apns`, `/api/settings`, `/api/health`, …) are load-bearing: security is the **handler**.  `/api/export/daily-rollups` **is** excluded for bearer (AGENTS.md note that it is not is stale).

`USAGE_READ_TOKEN` fallback to ingest is denied in production unless `USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK=true`.  `/api/ready` exposes that as booleans only.

CSRF: SameSite=Lax is **site**-scoped (`jays.services`), so sibling origins would attach the cookie.  `isCsrfSafeRequest` rejects `sec-fetch-site` other than `same-origin`/`none` and requires `Origin` host == `Host` when Origin is present.  Missing Origin is allowed for iOS URLSession.  Browsers send Origin on unsafe methods.

### 4.2 Token and key storage

| Secret | At rest | Client-visible |
|--------|---------|----------------|
| `Provider.apiKey` | AES-256-GCM `iv:tag:ct` | `keyPreview` first6…last4 only (null if length ≤ 10) |
| `Provider.secretConfig` | `v1:` + AES-GCM JSON | Field **names** only (`secretConfigMeta`) |
| `Provider.config` | Plain JSON (public subset) | After `splitProviderConfig` |
| `billingAccountIdentity` | HMAC digest | Never raw |
| Session | Cookie, HttpOnly | — |
| iOS read token | Keychain, this-device-only | — |
| Receipt transport HMAC | Stripped before persist | `evidenceRef` digest only |

Infisical sync logs names, counts, and status codes — not values.  Base URL is allowlisted.

### 4.3 Account isolation

This is **not** multi-tenant SaaS.  One SQLite file, one dashboard password, shared tokens.

| Question | Answer |
|----------|--------|
| Scoped producer write as another app? | No on `/api/ingest/usage` when `allowedSourceApps` is set.  Yes on mac-heartbeat (L1). |
| Unscoped ingest impersonation? | Yes on v1 (M1).  v2 binds `sourceApp` to `producerId`. |
| Forge subscription charges over HTTP? | No — reserved `sourceApp`. |
| Forge receipt cash with ingest token? | No. |
| Attribute to any project name? | Yes (L2). |

### 4.4 Receipt email and billing privacy

**Separation is the main control.**  Email → Worker → R2 evidence + fallback mailbox.  Money → private HMAC importer → `POST /api/ingest/usage`.  The Worker never holds `BILLING_RECEIPT_INGEST_TOKEN`, identity key, or HMAC key.

Intake: domain allowlist, daily 100 messages / 100 MiB **before** MIME parse, 180-day lifecycle ACK required, `senderAuthentication()` forced to `"unknown"` (Authentication-Results is untrusted).  Summary for `GET /api/operations` is hashed id, sender **domain**, sizes, attachment counts — no subject/body/From.

Schema has **no** card last4, billing address, or customer-email columns.  Intrinio adapter explicitly drops account email.  Stripe adapter stores balances/fees only.

Erasure is manual across SQLite + R2 + fallback mailbox.  Tombstones and daily rollups are long-lived financial aggregates.  Privacy page does not name the receipt Worker.

### 4.5 Logs

No ingest-body `console.log` found on the usage/OTLP routes.  Infisical logs names only.  Sentry is DSN-gated with no scrubber (L3).  Receipt Worker head sampling is 100% in wrangler (platform metadata in the CF dashboard).  Alert HTML is unescaped (L4).

### 4.6 Backups, R2, recovery

| Layer | Role | Who can write |
|-------|------|----------------|
| Live `/data/prod.db` | Source of truth | App container (`node`) |
| Pre-migration snapshots | Same-disk rollback | Startup wrapper; 0600 files |
| Litestream → B2 | Continuous PITR | `LITESTREAM_S3_*` write key |
| Weekly R2 | Historic archive | Separate weekly job; not live LTX |
| Receipt R2 `evidence/` | MIME quarantine | Inbox Worker only |

R2 free-tier kill switch does **not** stop B2 Litestream (`scripts/start-with-litestream.sh`).  `r2-usage.ts` can List/Delete via the same S3 creds Litestream uses **if** the endpoint is R2 — keep B2 as the only Litestream target.

Data-loss runbook (`docs/runbooks/sqlite-data-loss-incident.md`) is strong: pause, do not restart, capture `/proc/.../fd`.  Title still says Oracle A1; production is Hetzner/Coolify.  Update the audience line so the next incident is not run on the wrong host.

Restore: deploy dry-run + acceptance restore; 2026-08-14 UM B2 PASS.  Quarterly drill template in `docs/litestream.md`.  Restoring under a new `ENCRYPTION_KEY` without re-encrypt is a silent credential outage (H3).

### 4.7 Alert webhooks

Destinations are env-only except Pushover/email flags via `PUT /api/settings` (H1).  Slack/generic/PD URLs are **not** dashboard-editable.  Payloads are budget/ops text — no API keys.  Fixed hosts (Resend, Pushover, PD, APNs) are not SSRF-useful.  Operator-configured webhook URLs are (M5).

### 4.8 Dependencies and CI

| Item | State |
|------|--------|
| `next` | 16.3.1 exact |
| `prisma` | ^6.0.0 → `deepmerge-ts@7.1.5` (M13) |
| Shared contract | git URL `#v2.5.2` (tag; prefer commit SHA) |
| Dependabot | Weekly npm, monthly Actions |
| Renovate | Not configured |
| gitleaks | PR + main + weekly; forks refused |
| `pull_request_target` | Auto-merge only; no PR-head checkout |

---

## 5. Prioritized fixes

Do these in order.  This PR does not implement them.

### P0 — this week (privilege and recovery)

1. **H1 / H2** — Session-only `PUT /api/settings`.  Strip email addresses from bearer GET.
2. **H3** — Write the rotation runbook **before** any `ENCRYPTION_KEY` change.  Add previous-key decrypt or a re-encrypt script.
3. **M2** — Stop returning full APNs `deviceToken` on GET.  Decide whether POST stays read-token (iOS) or becomes session-only.

### P1 — next (isolation and blast radius)

4. **H4** — Per-account Cloudflare tokens; remove fleet fallback in prod resolution.
5. **M1** — `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true` after producer migration.
6. **M3** — Migration classifier + parity test + production `--apply`.
7. **M5** — Webhook URL allowlist + private-IP reject.
8. **M10** — Same-repo guard on `auto-merge-shared-dependency.yml`.

### P2 — harden

9. **M4 / M12** — Deep `rawData` redaction; ingest metadata blocklist.
10. **M6 / L1** — Fix Mac health dual-auth; scope mac-heartbeat.
11. **M7** — Remove or encrypt the committed receipt seed list.
12. **M8 / M9** — Mutation audit row + unified rotation runbook.
13. **L3 / L4 / L5** — Sentry scrubber, HTML escape, `*.pem` gitignore.
14. **M13** — Prisma bump for `deepmerge-ts`.
15.  Update the SQLite data-loss runbook host from Oracle A1 to Hetzner/Coolify.

### P3 — policy / product

16.  Document cross-store erasure (SQLite + receipt R2 + fallback mailbox) on `/privacy` and in a runbook.
17.  Optional producer→project allowlist (L2).
18.  Pin `congress-trading-shared` to a commit SHA.
19.  Dedicated `ATTRIBUTION_IDENTITY_HMAC_KEY` in production.

---

## 6. Incident-response readiness

| Question | Today |
|----------|--------|
| Detect stolen dashboard password? | Login 429s; no anomaly alert on success-from-new-IP |
| Detect stolen read token? | No.  H1 makes this worse (silent settings PUT) |
| Detect forged ingest? | Scoped tokens + reserved `subscription` + receipt HMAC.  Unscoped v1 is weak (M1) |
| Who changed a budget? | Not in-app (M8).  Infisical for env |
| SQLite gone under the writer? | Strong runbook — **pause, do not restart** |
| Restore proof? | UM B2 PASS 2026-08-14; quarterly template exists |
| Rotate ENCRYPTION_KEY after leak? | **Not safely** (H3) |
| Receipt MIME leak? | Rotate evidence token; R2 lifecycle 180d; fallback mailbox is a second copy |
| Fleet CF token leak? | Rotate; all four accounts in scope (H4) |

**IR first moves if this audit is wrong in production**

1.  Do not rotate `ENCRYPTION_KEY` until H3 exists.
2.  If a read token may be leaked: rotate `USAGE_READ_TOKEN`, restart (clears H1 env mutations), review Pushover/email flags.
3.  If ingest may be leaked: rotate ingest + producer tokens; enable scoped-only; do not reuse the receipt token.
4.  If the host is lost: treat B2 + Infisical + CF fleet token as compromised; follow the data-loss runbook if the writer is still up.

---

## 7. What this audit did not do

- Did not read Infisical, host env, or live SQLite.
- Did not print or fingerprint live tokens.
- Did not run a restore or `npm audit` against a registry advisory feed as a merge gate (lockfile pin recorded).
- Did not verify production `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` or `USAGE_READ_TOKEN` presence (code + `/api/ready` checks exist; live values unseen).
- Did not assess Coolify/Hetzner SSH or Infisical IAM beyond repo docs.

---

## 8. Strong controls to keep

1.  Distinct ingest / read / receipt / evidence / cron / session secrets, with production read/ingest split and receipt≠ingest 503.
2.  AES-256-GCM + versioned JSON envelope; client DTOs fail-closed.
3.  CSRF on cookie mutators; HKDF session key; scrypt password compare; CF-aware login rate limits.
4.  Receipt Worker isolated from cash; HMAC importer hardened; OTLP metadata allowlist.
5.  Ingest admission lock + per-token rate limit (not shared CF IP) on usage/metrics.
6.  B2-primary Litestream, pre-migration Online Backup, non-root container, Infisical-at-runtime.
7. gitleaks + fork refusal + Dependabot + high-severity `npm audit` in CI.

---

## Apple Notes handoff (local publication)

**Title:** `[UM, Grok] Security and privacy audit`

**Body (after the helper stamp):**

Read-only audit 2026-08-17.  Report: `docs/audits/2026-08-17-security-privacy.md` on `cursor/security-privacy-audit-f36a`.  No Critical.  High: read token can PUT `/api/settings` (Pushover/email), GET leaks alert emails, no ENCRYPTION_KEY rotation, CF fleet token spans four accounts.  Medium: unscoped v1 ingest impersonation, APNs full device tokens, migration `apiKey` drift, shallow rawData, webhook SSRF, committed receipt seed amounts, no mutation audit, shared-dep auto-merge missing fork guard.  Money path stay fail-closed (receipt HMAC, reserved subscription sourceApp, AES-GCM keys).  Report-only PR — no implementation.  Do not rotate ENCRYPTION_KEY until a re-encrypt path exists.
