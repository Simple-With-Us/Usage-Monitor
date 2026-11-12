# 2026-08-11 — Google Antigravity quota collector (local, not GitHub Actions)

## Summary

A local collector script, not a new API route. Antigravity's per-model quota
only exists where the `agy` CLI is installed and authenticated — it reads
from the local Antigravity language server / cached Google Cloud Code OAuth
session, not a server-pollable API. A GitHub Actions runner (Gemini's
original suggestion) has neither, so it can only report fabricated numbers.
This pushes real readings through the **existing** generic ingest contract
instead of adding a bespoke endpoint.

## Why not the originally proposed design

An external draft proposed a new `pages/api/v1/telemetry/ingest.ts` route
plus a scheduled GitHub Action. Both are wrong for this repo:

- This app is Next.js **App Router** (`src/app/api/**/route.ts`), not Pages
  Router, and already has a versioned, idempotent, rate-limited generic
  ingest route at `POST /api/ingest/usage` (`src/lib/usage-telemetry.ts` /
  `src/app/api/ingest/usage/route.ts`). A second bespoke route would
  duplicate that contract instead of reusing it.
- A GitHub Actions runner cannot see the user's local Antigravity/`agy`
  session, so the proposed workflow could only ever push placeholder data
  (its own draft hardcoded `prompt_tokens: 0` / `quota_percentage: 100.0`).

## What ships here

- `scripts/antigravity-usage-collector.mjs` — runs
  `agy -p "/usage" --output-format json`, maps each quota bucket to
  a v2 usage-telemetry event (`provider: "google-antigravity"`,
  `metricType: "quota"`), and POSTs a batch to
  `https://usage.jays.services/api/ingest/usage` with
  `x-usage-telemetry-version: 2`. Supports `--dry-run` (print, don't send)
  and `--debug` (dump the raw CLI output).
- `scripts/com.jays.antigravity-usage-collector.plist.example` — macOS
  launchd template to run it every 4h (inside Antigravity's ~5h Pro/Ultra
  quota refresh window) on the machine where Antigravity is actually used.
- `npm run antigravity:collect` — convenience alias for the script.
- `scripts/test-antigravity-collector.mjs` (`npm run test:antigravity-collector`,
  wired into `npm run verify` and CI) — replays a real captured envelope
  through the parser. `agy` doesn't exist on a CI runner, so this fixture is
  the only place a payload-shape regression gets caught before the launchd
  job starts failing unwatched.

No server-side code changes were needed: `USAGE_INGEST_PRODUCER_TOKENS`
(`src/lib/ingest-auth.ts`) already supports adding an arbitrary
`producerId:token` pair without a deploy.

## Output shape

**Verified against a real authenticated `agy` on 2026-08-12** (this section
previously described a guess based on the published headless docs and the
v1.1.11 changelog; the guess was wrong in two ways worth recording).

```json
{
  "conversation_id": "",
  "status": "SUCCESS",
  "response": "Gemini Models\tWeekly Limit Remaining\t93%\t2026-08-19T02:08:16Z\n…",
  "duration_seconds": 0,
  "num_turns": 0,
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "command": {
    "name": "usage",
    "data": {
      "description": "Within each group, models share a weekly limit and a 5-hour limit. …",
      "groups": [
        {
          "name": "Gemini Models",
          "description": "Models within this group: Gemini Flash, Gemini Pro",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "description": "You have used some of your weekly limit, it will fully refresh in 6 days, 18 hours.",
              "window": "weekly",
              "remaining_fraction": 0.9267072081565857,
              "reset_time": "2026-08-19T02:08:16Z"
            }
          ]
        }
      ]
    }
  }
}
```

The envelope's `usage` block is the token cost of *running the CLI query
itself* (e.g. what it cost to ask `/usage`) — it is unrelated to account
quota and the collector never sends it as telemetry.

Two corrections to the original design:

1. **There is a fully structured payload.** `command.data.groups[].buckets[]`
   carries full-precision fractions, stable bucket ids, and an explicit
   window kind. `response`'s TSV is only a rendered view of it (rounded to
   "93%"), so the collector reads `command` first and falls back to parsing
   `response` only if a CLI version omits it. The real `response` also has
   **no header row**, so the original header-only parser would have refused
   every real reading; the fallback now reads the observed positional layout
   (group, bucket, percent, reset), anchored on the percent cell.
2. **Quota is not per model.** Antigravity meters per model *group* ("Gemini
   Models", "Claude and GPT models"), and each group has two independent
   windows — weekly and 5h. One reading is therefore four series, and series
   identity is `(group, bucket)`. Keying on the model/group name alone —
   which the first draft did — made the two windows of a group hash to the
   same `eventId`, and since the v2 idempotency key is derived from
   `(producerId, eventId)`, ingest would have silently dropped one of the two
   readings. `assertUniqueSeriesKeys()` now fails loudly on any such
   collision.

## Setup (owner)

**Done 2026-08-12** — recorded here as the reproducible procedure.

1. **Infisical** — in the `usage-monitor` project
   (`<UM_INFISICAL_PROJECT_ID>`), env `prod`, set **two** secrets
   from one freshly generated random token:
   - `USAGE_INGEST_PRODUCER_TOKENS` = `antigravity-cli:<token>` (append
     comma-separated if other `producerId:token` pairs already exist)
   - `ANTIGRAVITY_INGEST_TOKEN` = `<token>` — the collector reads this from
     the env `infisical run` injects. Easy to miss: without it the script
     exits on its missing-token guard even though the server side is correct.

   Mint the token where it is used and write it straight to the secret store;
   never paste it into a doc or commit. `scripts/infisical-secrets-safe.sh` is
   the value-blind helper for this (`names` / `has` / `set`).
2. **Restart** the usage-monitor app (a Coolify restart is enough — no
   rebuild). `USAGE_INGEST_PRODUCER_TOKENS` is read once at startup by
   `src/lib/ingest-auth.ts`, not hot-reloaded. Note this is additive: a
   producer-scoped token does not disturb existing `USAGE_INGEST_TOKEN`
   producers unless `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`.
3. **Local Mac** — `infisical login` once (interactive, caches a session;
   this is why the plist can call `infisical run` without embedding a client
   secret). Confirm `agy` is on `PATH` and authenticated.
4. Dry-run: `infisical run --projectId <UM_INFISICAL_PROJECT_ID> \
   --env prod -- node scripts/antigravity-usage-collector.mjs --dry-run --debug`
5. Once the parsed output looks right, install the launchd job (see the
   `.plist.example` header for exact steps) and drop `--dry-run`.

### launchd gotchas (both cost real time on 2026-08-12)

- **`agy` is not on launchd's PATH.** launchd hands a job a bare PATH, not
  your shell's, and the Antigravity CLI installs to `~/.local/bin`. Leave it
  out of the plist's `EnvironmentVariables` and every tick dies with
  `spawnSync agy ENOENT` while a manual run keeps working fine.
- **Two `agy` invocations at once break the second one.** It does not queue —
  it decides it has no usable session, prints an OAuth URL, and waits ~160s
  for a code that a launchd job can never supply, returning
  `status: "ERROR", error: "authentication failed or timed out"`. If a tick
  fails that way, check whether something else was calling `agy` at the same
  moment before suspecting the session. The collector's CLI budget is 90s and
  its error text names this case.

## Dashboard

`provider: "google-antigravity"` events show up in the existing telemetry
panels (`GET /api/usage-events`, `GET /api/llm-burn`) with no further code
changes — provider names are free-form strings. Four series land per tick,
labelled `Gemini Models (weekly)`, `Gemini Models (5h)`,
`Claude and GPT models (weekly)`, and `Claude and GPT models (5h)`, each on a
0-100 percent-remaining scale (`limit: 100`, `credits: <percent remaining>`,
`metadata.scale: "percent_0_100"`). Antigravity only ever reports fractions,
never absolute credit counts. A `Provider` row (for a monthly-budget card) is
optional and out of scope here; mirror
`scripts/add-cursor-subscription.mjs` if/when wanted.
