# Mac Collector Install (installed copy, not ~/Code)

Owner rule: `~/Code/<App>` is the human integration tree and a daemon resets it.
A LaunchAgent that executes `~/Code/Usage-Monitor/scripts/...` runs whatever
that tree happens to hold, and breaks when the tree moves.  The Mac collector
LaunchAgents therefore run from an installed copy:

```
~/apps/usage-monitor-collectors/        (override: UM_COLLECTORS_HOME)
  scripts/                              collector entry points + scripts/lib
  node_modules/zod                      only third-party import the collectors have
  VERSION                               git sha, install time, source checkout
```

## Install or refresh

From any Usage-Monitor lane or checkout that holds the code you want live:

```bash
scripts/install-collectors.sh            # copy files, smoke-check every entry point
scripts/install-collectors.sh --plists   # also repoint + reload the LaunchAgents
```

`--plists` touches only the `com.jays.*collector` LaunchAgents that still
reference a `Usage-Monitor/scripts/` path, plus the Antigravity CLI `statusLine`
hook in `~/.gemini/antigravity-cli/settings.json`.  The script refuses a
destination under `~/Code`.  Re-run it after merging collector changes; the
copy does not update itself.

Check what is live with `cat ~/apps/usage-monitor-collectors/VERSION`.

Before copying, the installer checks that incoming managed scripts and the root
package manifest match their tracked Git commit.  The manifest must specify an
explicit stable major-4 npm Zod version or caret/tilde range; that verified value
is passed to dependency installation.  Existing scripts may be replaced or removed only when they
already match the incoming version, or their bytes and executable flag match
the prior `VERSION` commit in the source checkout's verified local history.
Unknown helpers, changed entries, symlinks, unsupported paths, or unavailable
baseline history stop the install before copying, dependency installation, or
receipt changes.  Fresh installations require a verified Git source checkout;
`VERSION` records its full checked source SHA.  A failed preflight does not
authorize deleting files, fabricating a baseline, or copying unreviewed installed
code into a canonical release.

The `VERSION` output is checked for safe regular-file custody even when script
comparison needs no baseline; an absent receipt remains valid in that case.  Before
a needed dependency installation, the destination must have no existing
lockfile, shrinkwrap, local npm configuration, or occupied dependency directory,
and its package manifest must be absent or the installer's exact minimal
manifest.  Symlinks, hardlinks, and independently managed package contents are
preserved by refusing the write.  Existing Zod is left unchanged when dependency
installation is skipped; this check does not attest its dependency identity.

This is a read-only preflight, not an atomic installation transaction.  Source
and installed trees must remain unchanged through copying and validation, with
all independent writers coordinated beforehand.  The flat-copy installer does
not provide interruption recovery; a later rollout needs a verified backup and
recovery plan as well as this drift check.

For scoped-token composition, start from approved `main` containing merged
[#1885](https://github.com/Simple-With-Us/Usage-Monitor/pull/1885), preserving its
idle outbox drains and tests.  Obtain each independent owner's exact old/new
entry and helper source, hashes, dependencies, and installed-versus-prepared
receipts.  Review and merge only the intended credential initialization into
that canonical source, preserving all later collector behavior; credentials and
custody-file contents stay outside the source artifact.  Commit approved helper
source and test the composed imports and idle/retry paths before producing a
release.  Immediately before an authorized rollout, freeze independent writers
and verify the installed graph against the agreed hashes again.  Unbound
installed helper bytes are not automatically admitted into a content-addressed
release.

## Why a collector can sit at HTTP 409 for weeks (UM-1469)

Every v2 event is stamped with `metadata._producerInstanceId`, the sending
host's name.  When macOS renamed this Mac (`jays.services` to
`Mac.Jays.Services`, Sep 17 2026), every collector replay of an older event
differed from its stored row only in that label, ingest answered
`409 idempotency_conflict` for the whole batch, and because collectors advance
their checkpoint only after a clean ack, the same batch was re-sent every 15
minutes until Oct 15.

Fixes now in place:

* Ingest ignores the host label (and a `machine` field that merely echoes it)
  when deciding whether a replay is the same event.  Real content differences
  still collide.
* Collectors isolate a conflicting event by halving the batch, log its
  `eventId`, skip it and let the rest land, so one bad event can no longer
  freeze a stream.  The 409 body is now part of the thrown error.
* Maintenance sends one Pushover per UTC day when a watched
  (`sourceApp`, `metricType`) stream goes quiet (`src/lib/producer-staleness.ts`;
  allowances live in `PRODUCER_STREAM_RULES`, measured from prod gaps (UM-1616:
  `deepseek-dsh` 120h, `opencode` 96h); disable with
  `USAGE_PRODUCER_STALENESS_DISABLED=1`).

## Known non-collector gaps

* `claude-code` quota from this Mac (UM-1616): the subscription-quota collector
  does not read the Keychain itself (PR #1592).  The LaunchAgent now runs
  `scripts/run-subscription-quota-collector.sh`, which reads the login Keychain
  item `Claude Code-credentials` with `/usr/bin/security`, passes it in
  `CLAUDE_CODE_OAUTH_CREDENTIALS_JSON` and execs the collector.  The credential
  is never printed.  If the read fails (denied, locked, item missing, no answer
  to the prompt within 20 seconds) the wrapper logs one line starting
  `[run-subscription-quota-collector] keychain:` to
  `~/Library/Logs/subscription-quota-collector.log` and the collector still runs
  for Codex, Grok and MiniMax.  Owner step, once:
  1. Run `scripts/install-collectors.sh --plists` from a checkout that has this
     change.  It copies the wrapper to the installed collectors and rewrites the
     `com.jays.subscription-quota-collector` LaunchAgent to run it, then reloads
     that agent.
  2. When macOS asks whether `security` may use "Claude Code-credentials", click
     **Always Allow**.  Click it on the first prompt; a Deny or a timeout just
     repeats the one-line log on the next 15 minute pass.
  3. Within one pass `claude-code` `quota` rows resume and the
     "no Claude Code OAuth credential found" line stops.  If the symptom is
     instead "Claude Code access token is expired; skipping this tick", the
     read succeeded but the stored token's `expiresAt` has passed.  The
     collector deliberately never refreshes it (that would race Claude Code's
     own refresh), so rows resume only once the CLI refreshes that token — run
     Claude Code once.  Clicking "Always Allow" does not address this case.
* `fx` usage: unwatched.  No rows since Sep 16 while the collector stays
  installed; `PRODUCER_STREAM_RULES` has no fx rule until usage resumes.
* `agent-bar` quota: retired.  The app was renamed CodeCaps and reports as
  `codecaps` since Sep 21 2026.
* `com.jays.mac-server-watchdog` still runs from the checkout; it is a host
  heartbeat, not a collector, and is not covered by the installer.

## Harness feeds: DSH, opencode, fx, Kimi, ZCode (UM-1594, UM-1649)

Five LaunchAgents feed the harnesses that have no complete vendor billing API.  Create
each from its template (`scripts/com.jays.<name>-usage-collector.plist.example`),
replacing every absolute-path placeholder with the installed node, detached collector
runtime, and home paths, and replacing the hub-host placeholder with the approved
telemetry hub endpoint, then `launchctl bootstrap`:

| Label | Source | Producer |
|---|---|---|
| `com.jays.deepseek-usage-collector` | `~/.dsh/sessions` and `~/.clutch/dsh/sessions` (`session.jsonl.zstd` and `session.v3.jsonl.zstd`) | `deepseek-dsh` |
| `com.jays.opencode-usage-collector` | `~/.local/share/opencode/opencode.db`, opened read-only | `opencode` |
| `com.jays.fx-usage-collector` | `~/.fx/usage.jsonl` | `fx` |
| `com.jays.kimi-usage-collector` | `$KIMI_CODE_HOME/sessions/**/agents/*/wire.jsonl` (`~/.kimi-code` by default) | `kimi-code` |
| `com.jays.zcode-usage-collector` | `$ZCODE_DATA_BASE_DIR/.zcode/cli/db/db.sqlite` (`~` by default), opened read-only | `zcode` |

All five run on `/opt/homebrew/opt/node@24/bin/node` (opencode and ZCode need
`node:sqlite`) and use `USAGE_INGEST_TOKEN` until scoped tokens for `opencode`
and `fx` are added to `USAGE_INGEST_PRODUCER_TOKENS`.  Kimi and ZCode resolve
`KIMI_CODE_INGEST_TOKEN` and `ZCODE_INGEST_TOKEN` first, then the unscoped
fallback.  Their Sentry bridge resolves `KIMI_CODE_TELEMETRY_HUB_TOKEN` and
`ZCODE_TELEMETRY_HUB_TOKEN` from process environment or `fleet-secrets`; the
plist contains no bearer value.  Provision each producer in the receiver maps
before bootstrap, and verify both an ingest ACK and a hub ACK before calling it
live.  Infisical is optional for the collector: a host environment can supply
the same scoped names, while an Infisical-backed host must use its approved
read-only service-token route rather than the retired shared Automation
identity.  The DSH agent sets
`USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1`, because BotFleet already reports
its own workspaces.  A first run backfills the source's retained history and then keeps a watermark
in `~/.cache/usage-monitor/collector-state/`.

Kimi emits only durable `usage.record` rows whose `usageScope` is `turn`;
session-scope or omitted-scope totals are cumulative and are not added again.  ZCode
emits terminal `model_usage` rows, including failed or cancelled requests that
still reported usage.  ZCode retains only 30 days of these rows, so a broken
collector must be repaired before that source history expires.
