# Usage-Monitor reads Infisical prod only (2026-10-10)

Owner directive (2026-10-10): the `dev` and `staging` environments of the usage-monitor Infisical project (`86e35e51-91bc-4dfd-a045-4484726b9c40`) are being retired.  Every code and config path now selects `prod`.

## What changed

- New `src/lib/infisical-environment.ts` holds the one prod-only resolver.  It always returns `prod`.  A non-prod override logs one warning that names the variable (never the value) and is ignored.  It never throws, because the selectors run at container boot and in periodic probes.
- `resolveInfisicalEnvironment()` in `src/lib/app-settings.ts` uses it.  The old `NODE_ENV` mapping (production to `prod`, anything else to `dev`) is gone, so local development, `next build` and tests no longer select `dev`.  `UM_INFISICAL_ENV` is refused unless it says `prod`.
- `src/lib/infisical-provider-sync.ts` and the secrets probe in `src/lib/platform-status/probes/secrets.ts` used the same override through `INFISICAL_ENV`.  Both now resolve through the helper.  Their default was already `prod`.
- `scripts/infisical-run.mjs` drops the `INFISICAL_ENV || NODE_ENV || "dev"` fallback, which could produce non-Infisical slugs such as `production` and `development`.  It uses `prod` and exits 2 on any other `INFISICAL_ENV`.
- The Infisical coordinates file under `.cursor/` selects `prod`.  `scripts/cursor-cloud-start.sh` defaults to `prod` (shell and the embedded Python fallback) and exits 1 on any other `INFISICAL_ENV`.  An uncredentialed boot still exits 0.
- `INFISICAL.md` describes the prod-only contract.  Tests cover the helper, `resolveInfisicalEnvironment()`, the prod environment query on `appSettings.init()`, and the probe ignoring a non-prod `INFISICAL_ENV`.

## Production impact

None.  The Dockerfile has baked `INFISICAL_ENV=prod` since #1211, `NODE_ENV=production` already mapped to `prod`, `render.yaml` pins `INFISICAL_ENV: prod`, and neither `INFISICAL_ENV` nor `UM_INFISICAL_ENV` is set on the Coolify application (names checked 2026-10-10).

## Readers that now see prod

The Cursor Cloud boot, local `npm run dev` through `scripts/infisical-run.mjs`, and any local run with machine-identity credentials.  They now receive the prod secret set (156 keys).  Treat a Cursor cloud agent for this repo as holding production secrets.

## Update Sat Oct 10 (owner decision)

Later on Sat Oct 10 the owner decided "ok to do all" and "if values differ defer to prod, all the rest move to prod".  That replaces the plan in the first version of this note, which was to leave the twelve dev-only knobs out of prod and let prod read the schema defaults in `APP_SETTING_DEFS`.

- Copied to prod:  all 12 dev-only keys, and each was verified identical to dev afterwards.  They are `ADAPTER_HTTP_TIMEOUT_MS`, `ADAPTER_PROVIDER_TIMEOUT_MS`, `ALERT_DELIVERY_MAX_ATTEMPTS`, `ALERT_DELIVERY_TIMEOUT_MS`, `ALERT_DISABLE_EMAIL`, `ALERT_EMAIL_ENABLED`, `ALERT_UNASSIGNED_SPEND_FLOOR_USD`, `INFISICAL_SETTINGS_REFRESH_MS`, `INGEST_COST_DERIVATION_ENABLED`, `OTLP_SYSTEM_METRICS_INGEST_ENABLED`, `READY_DISK_WARN_FREE_BYTES` and `USAGE_INGEST_REQUIRE_SCOPED_TOKENS`.
- Behavior changes to watch:  three of these can change what production does, because prod used to read the schema defaults for them.  `ALERT_EMAIL_ENABLED` is the master enable for the Resend email alert channel, `ALERT_DISABLE_EMAIL` hard-disables email alert delivery, and `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` denies unscoped `USAGE_INGEST_TOKEN` ingest when true, so only per-producer scoped tokens work.  Watch alert email delivery and ingest token acceptance.
- Value conflicts, prod's value kept:  `ALERT_MIN_SEVERITY` and `PROVIDER_MANIFEST_JSON` differ between dev and prod, and prod's value stays.
- Environments:  the `dev` and `staging` environments of the usage-monitor Infisical project are deleted.  Prod is the only environment.

## Left alone

`deploy/retired/oracle/*` (retired stack), and the operator scripts `scripts/infisical-secrets-safe.sh` and `scripts/cf-token-map.sh`, whose `INFISICAL_ENV` default is already `prod`.
