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

## Dev-only knobs not copied to prod

Twelve keys exist only in the `dev` environment and were deliberately not copied.  Prod reads the schema defaults in `APP_SETTING_DEFS` (which is what the production container already did): `ADAPTER_HTTP_TIMEOUT_MS` (30000), `ADAPTER_PROVIDER_TIMEOUT_MS` (90000), `ALERT_DELIVERY_MAX_ATTEMPTS` (3), `ALERT_DELIVERY_TIMEOUT_MS` (10000), `ALERT_DISABLE_EMAIL` (false), `ALERT_EMAIL_ENABLED` (true), `ALERT_UNASSIGNED_SPEND_FLOOR_USD` (25), `INFISICAL_SETTINGS_REFRESH_MS` (5 minutes), `INGEST_COST_DERIVATION_ENABLED` (false), `OTLP_SYSTEM_METRICS_INGEST_ENABLED` (false), `READY_DISK_WARN_FREE_BYTES` (5 GiB), `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` (false).  The owner decides later whether any should be set in prod.  Two keys, `ALERT_MIN_SEVERITY` and `PROVIDER_MANIFEST_JSON`, differ between dev and prod and prod's value was kept.

## Left alone

`deploy/retired/oracle/*` (retired stack), and the operator scripts `scripts/infisical-secrets-safe.sh` and `scripts/cf-token-map.sh`, whose `INFISICAL_ENV` default is already `prod`.
