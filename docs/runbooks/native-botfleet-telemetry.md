# Native BotFleet Turn Telemetry

`scripts/botfleet-session-collector.mjs` forwards native BotFleet turn aggregates to Sentry through the authenticated telemetry hub.  It makes no Usage Monitor ingest request and creates no second cash ledger.  The operation and span name are `botfleet.turn`; per-call CLI telemetry remains a separate signal.

## Source And Privacy

The source is the running BotFleet instance's actual `OMB_DATA_DIR/events`, containing per-thread `.ndjson` and `.ndjson.1` files.  Verify the non-secret native data-directory scalar before configuring the collector; an empty guessed directory does not establish inactivity.  Set `BOTFLEET_EVENTS_DIR` through the approved per-host Infisical configuration when the native directory differs from the default `~/.botfleet/events`.

The reader selects native event identity, exact thread/turn/driver identity, timestamps, reported model, outcome and finite token counters.  Raw protocol payloads, prompts, responses, tool content, paths and arbitrary errors never reach the durable journal.  Cash and billing fields are excluded.  Driver names do not establish an AI vendor, so the collector leaves that vendor unreported.

Only an unambiguous matching native start/completion pair becomes a timed aggregate span.  Missing or ambiguous timing or outcome becomes an aggregate observation log.  Missing input/output counters remain unreported.  Cache counters remain subsets of the native inclusive input figure, and reasoning is never added to output.  Native history-gap markers are counted without forwarding their messages.

The current Sentry privacy allowlist excludes session/conversation identifiers.  Aggregate session and turn correlation therefore remains unavailable in Sentry; the stable host/native-event hash provides replay identity only.

## Durable Delivery

An explicit operational lookback of 1 to 168 hours is required through `BOTFLEET_SENTRY_LOOKBACK_HOURS` or `--hours`; the staged schedule uses 24 hours.  Native completion timestamps select that window, with exact counts for retained completions before and after it.  Source files remain unchanged, and their mtimes are not used to omit possibly current rows.  Rotated-file overlap is deduped only by exact event identity.  The stable hash includes the host identity and native event ID.  The common metadata-only outbox commits before delivery and retains separate acknowledged, pending and quarantined states.

The reader accepts at most 10,000 source files and holds at most 100,000 bounded native projections (including starts) and 100,000 bounded history-marker identities in memory.  Exceeding a budget returns `complete:false` and `projectionBudgetExceeded:true`, exits unsuccessfully and publishes no partial source pass; previously durable outbox rows still drain independently.  It never skips old source files to claim current coverage, deletes source records or advances a replay watermark.  A larger retained source requires a separately reviewed streaming or partitioned replay before enabling its scheduled publication.

Native delivery alternates newer unnarrowed batches with oldest pending work, preserving durable rejected-group narrowing and the invocation request/time budgets.  Confirmed singleton rejection enters quarantine; malformed destination acknowledgements remain pending.  Unsupported historical records stay retained in quarantine.  Coverage is bounded by the native files still available at the source.

Receipt pruning requires a verified source replay horizon and the common minimum retention.  Pending and quarantined telemetry remain retained.  Historical native replay is a separate explicitly reviewed operation, with its source window and destination retention checked before publication.

## Install And Verify

Refresh the installed collector copy from the reviewed commit with `scripts/install-collectors.sh`.  The existing copy filter includes the native entry point and its shared library.  Verify imports using the actual scheduled job's Node executable, then run the installed entry point with `--dry-run --hours 24`; dry-run emits counts only and performs no network delivery or outbox writes.

Use the existing host-scoped configuration keys `COLLECTOR_SENTRY_ENABLED`, `COLLECTOR_TELEMETRY_HUB_ENDPOINT` and `COLLECTOR_TELEMETRY_HUB_TOKENS_JSON`, with the `botfleet` producer mapped to that host's `botfleet` source bearer.  Infisical remains the source of truth.  Keep runtime values and routing out of source control.

Create one scheduled invocation per host.  The Mac template is `scripts/com.jays.botfleet-session-collector.plist.example`, with a 900-second interval and disabled placeholder configuration.  The existing server wrapper accepts `botfleet-session-collector.mjs` as its collector-file argument; schedule it once at the existing collector cadence.  Register the actual program, schedule, logs and purpose in the canonical process inventory, its master Note and repository mirror before enabling either job.

The hub must first run this revision's `botfleet.turn` metadata allowlist.  Rebuild its reviewed merged image, recreate or restart the same service, verify authenticated canaries and durable state, then enable the native jobs.  Include explicit numeric reasoning/context values in generated span and log canaries, then query actual stored Sentry attributes to verify `gen_ai.usage.reasoning_count` and `context.used` survive the full route.  Record that generated alias verification separately from real producer receipts.  Existing CLI collectors can be activated independently under their own rollout gates.

Verify unauthenticated rejection, durable authenticated ACKs, then actual stored Sentry receipts with `agent.platform=botfleet` and operation `botfleet.turn`.  Keep generated `telemetry-verification` canaries separate from native source receipts.  Record empty/unavailable source counts separately from verified producer activity.

## MiniMax Workspace Correlation

The MiniMax runtime collector links each usage row to `local_runtime_sessions` by the exact native `session_id`.  A single explicit `workspace_dir` may establish BotFleet launcher attribution; missing schema, duplicate session matches or missing workspace leave the launcher unreported.  The native session ID uses the existing additive correlation key.  Raw workspace paths and project-name guesses are excluded, every usage row is preserved, and event identities and quantities remain unchanged.
