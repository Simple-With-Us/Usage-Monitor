# Producer coverage matrix — UM v2 ingest (2026-10-23)

Authoritative map of every known producer of `/api/ingest/usage` (and `/api/otlp/v1/metrics`) data, the v2 fields they send, the fields UM accepts, and any gap.  When this list drifts from reality, fix the list, not the contract: the v2 wire is owned by `@jaywedgeworth22/congress-trading-shared` and changes there require a cross-app PR.

The tables describe supported code paths.  Installed configuration and current delivery require separate evidence; see the [October 23 receipt audit](../rollouts/2026-10-23-telemetry-completeness.md).  That audit found working OpenCode ingestion omitted from Agents Overview, stale token-ledger receipts alongside newer request telemetry, and quota-only feeds that must not be presented as exact token coverage.  Copilot was retired operationally by the owner on October 20 (UM-1618); its retained parser and historical rows do not establish a live feed.

## How the wire works

- v2 batch envelope = `{ schemaVersion: 2, producerId, producerInstanceId?, events: UsageTelemetryV2Event[] }` parsed by `src/lib/usage-telemetry.ts` against `UsageTelemetryV2BatchSchema` and `UsageTelemetryV2EventSchema` from `@jaywedgeworth22/congress-trading-shared`.  `sourceVersion` and `environment` are NOT batch-level fields in the strict v2 schema; `environment` lives on each event.
- Auth: `Authorization: Bearer ${USAGE_INGEST_TOKEN}` (or per-producer `USAGE_INGEST_PRODUCER_TOKENS` mapping when `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`).
- Idempotency: v2 requires the producer's durable `eventId`; UM derives its producer-scoped persistence key with the shared length-prefixed SHA-256 algorithm.  Legacy v1 receipts have a separate fallback key.
- Persisted result semantics (narrower than request acceptance): `attempted` = submitted events, `persisted` = newly inserted rows, `skippedPrunedDuplicates` = blocked by retention tombstones.  Never derive `persisted` from `activeEvents.length`.
- Reserved `metadata` keys (producer spoof-proof): the four `_derivedCost*` keys, the `tokenType` split, the `coverage.*` echoes, the `project` mirror, and the per-source anchors.  Producers can add their own keys; see `src/lib/usage-telemetry.ts`.

## OTLP path (parallel to v2)

`POST /api/otlp/v1/metrics` accepts `Content-Type: application/json` (primary) or `application/x-protobuf`.  Does **not** accept gRPC (Claude Code's default `OTEL_EXPORTER_OTLP_PROTOCOL` value) — a gRPC-configured client gets `415` telling it to switch to `http/json` or `http/protobuf`.  Same bearer token as v2 ingest.  Both routes are excluded from the dashboard-session middleware (`src/middleware.ts`'s `api/otlp(?:/|$)` exclusion).

`POST /api/otlp/v1/logs` persists allowlisted Claude Code and Codex model-call records into `AiRequest`, including native tokens, model, duration, and TTFT when supplied.  Other log records are accepted and dropped.  Prompt/response bodies and user email are not read by this mapper; request performance never feeds the cash ledger.  Errors and health stay in Sentry.

`POST /api/otlp/v1/metrics` also accepts generic OTel gen_ai client metrics (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `gen_ai.usage.cost`) via `src/lib/otlp/gen-ai-mapper.ts`, keyed by `gen_ai.system`/`agent.platform` + `gen_ai.request.model`.  Platforms with an exact local collector (codex, grok, copilot, deepseek, antigravity, opencode, fx) are skipped by default to avoid double counting.  `cursor` and `cursor-agent` are skipped the same way because billed Cursor usage, when a team opts into the Admin API poller below, is that poller and not an estimated gen_ai point.  Allow one side per platform via `OTLP_GEN_AI_PLATFORM_ALLOWLIST` / `OTLP_GEN_AI_ALLOW_OVERLAP=1`.  An allowlist does not override the overlap block.

`POST /api/otlp/v1/traces` accepts OTLP `resourceSpans` (or a direct `{ turns: [...] }` relay payload) and persists per-turn rows to the `AgentTurn` model (platform, seat, repo, conversation, model, tokens, cost, duration, tools, error, truncated prompt/response with retention limits).  It never writes `ExternalUsageEvent`, so token/cost ledger math cannot double count against `/metrics` or the JSONL collectors.

Claude Code `llm_request` spans instead upsert `AiRequest` on their request identity and can enrich a log-derived row with TTFT.  Only `claude_code.interaction` spans become Claude turns.  Generic `AgentTurn` insertion currently has no durable unique span key, so an HTTP retry can duplicate turn detail even though it does not duplicate the cash ledger.

A Claude Code trace batch is authorized against the turn dimension, so the turn platform must name the coding harness (`claude-code`), not the model vendor (`anthropic`): Claude Code's spans carry `gen_ai.system = "anthropic"` and no `agent.platform`, so before 2026-10-25 the turn resolved to `anthropic` and a producer-scoped credential was refused with `403` for the whole batch.  `src/lib/otlp/traces-mapper.ts` now resolves the platform from the span prefix (`claude_code.*`) and from `service.name` first, and an explicit `agent.platform` still wins.

## Local telemetry hub and Sentry

`scripts/telemetry-hub/` supplies a loopback OTLP JSON receiver, a durable local journal, and independent Usage Monitor and Sentry delivery offsets.  Its receiver accepts traces and logs; `/v1/metrics` returns 501.  Keep native metrics targeting Usage Monitor's metrics route until a durable hub metrics path exists.  Sentry's lack of an OTLP metrics endpoint does not imply Usage Monitor lacks one.

The Sentry path rebuilds spans and logs from the existing attribute allowlist and strips content.  The four custom measurements `ttft_ms`, `context.tokens`, `context.limit`, and `context.utilization_pct` are encoded as string attributes because a real UM-1614 probe found Sentry dropped their numeric OTLP values.  Native recognized token counters remain numeric; the internal journal and Usage Monitor data remain typed.  These strings support indexed filtering; they are not numeric metric series.

The hub's Usage Monitor ledger path skips platforms with another authoritative collector, including OpenCode and Fx.  An explicit overlap override is a deliberate double-counting risk, not an activation prerequisite.  Its generic turn delivery remains at least once because the receiver's `AgentTurn` table lacks a unique event identity.  Accepted spans require both source trace and span IDs and retain their existing persistence identity.  Missing/partial IDs are explicitly rejected and counted as ignored; timestamps, labels, content hashes, and session identity cannot reliably replace per-span source identity.

Source code and passing tests do not establish installed hub operation.  The October 23 audit did not inspect or change the Mac's launch configuration, install collectors, redirect exporters, or activate a listener.

## OpenRouter Broadcast

OpenRouter request traces use two independent Broadcast destinations: the Sentry `agent-sessions` project for privacy-redacted searchable traces, and Usage Monitor's private OTLP traces endpoint for `AgentTurn` detail.  The latter uses a trace-only `OTLP_TRACES_PRODUCER_TOKENS` credential and never writes `ExternalUsageEvent`, so `src/lib/adapters/openrouter.ts` remains the account cash and credit authority without double counting.  See [`docs/runbooks/openrouter-observability.md`](../runbooks/openrouter-observability.md) for the destination fields, privacy requirement, and receipt checks.

OpenRouter's OTLP span reports the underlying model provider in `gen_ai.system`.  The traces mapper therefore recognizes `openrouter.trace.id` as the gateway marker and assigns platform `openrouter`; an explicit `agent.platform` still wins when a caller can supply a reliable coding-harness identity.

## Native-vs-local coverage rule (UM-1636)

Claude Code can describe the same call twice: once through its native OTLP exporter and once through the local transcript collector.

The receiver therefore applies a native-preference rule in `/api/ingest/usage`: a transcript-sourced event (it carries `metadata.collector = "transcript"`) is dropped when a native Claude Code token row sits within five minutes of it, because the native feed already covers that call.

The comparison is machine-scoped when both sides know their machine, so the Mac's native feed never silences a different machine's transcript feed; a native row without a machine identity covers every machine near it, which is the shape of the native rows Claude Code wrote before the Mac's `OTEL_RESOURCE_ATTRIBUTES` carried `host.name`.

The dropped events are counted as `duplicates` in the v2 ACK, because the usage they describe is already in the ledger, and the ACK's `received` count still includes them.

## Producer matrix (v2 ingest)

Rows distinguish a live feed from parser code that merely exists in the repository.  A local file format is not coverage until an installed collector delivers it successfully.

| Producer | Repo | Transport | `metricType` | Provider values | Service values | `billingMode` | `confidence` | `tokenType` split | `producerKeyRef` | `coverage` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code` (OTLP) | UM `/api/otlp/v1/metrics` | OTLP JSON/protobuf | usage, cost | anthropic | claude-code | n/a (from metric) | actual | input/output/cacheRead/cacheCreation | n/a | n/a | Mapped from `claude_code.token.usage` + `claude_code.cost.usage` by `src/lib/otlp/claude-code-mapper.ts`; idempotency key = hash(metric + attrs + window + value).  **Request-scoped metrics stopped on 2026-10-23**: `claude_code.token.usage` / `claude_code.cost.usage` / `lines_of_code` / `commit` / `pull_request` / `code_edit_tool.decision` all went quiet, while the model-less `session.count` and `active_time.total` kept arriving, and the same Claude Code binary emitted them the day before.  A canary payload POSTed to production was accepted and persisted, so the receiver is healthy and the exporter is the side that stopped.  See `docs/rollouts/2026-10-25-claude-code-telemetry-gap.md` |
| `claude-code` (local transcript feed) | UM `scripts/claude-usage-collector.mjs` | v2 batch | usage | anthropic | claude-code | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | **Active on the Mac since 2026-10-25** (UM-1636).  Reads `~/.claude/projects/**.jsonl`, which carry the exact per-request usage (model, input, output, cache read, cache write) for every assistant message.  Re-enabled because Claude Code's native OTLP request-scoped metrics stopped on 2026-10-23; the transcripts are the exact source that is still there.  Every event carries `metadata.collector="transcript"` and the machine identity in `metadata["host.name"]`, and the receiver drops a transcript event when the native OTLP feed already covers it (`src/lib/native-telemetry-coverage.ts`), so the two feeds never double-count.  The shipped parser was `.disabled.mjs`'d by audit #1509 because the native path used to cover the same usage; that condition no longer holds. |
| `claude-code` (fleet collector Claude section) | UM `scripts/fleet-usage-collector.mjs` (Claude Code block at line ~131) | v2 batch | usage, cost | anthropic | claude-code | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | **Default OFF** as of 2026-09-21 (Codex re-review P1 follow-up, audit #1509): the section is skipped unless `USAGE_MONITOR_FLEET_ENABLE_CLAUDE=1` is set. Native Claude OTLP is the documented active path; an operator who runs both would double-count Claude Code usage (v2-batch and OTLP idempotency keys do not dedup). Re-enabling this section requires acknowledging that native OTLP must NOT also be running.  It is still off: the local transcript feed (row above) is the Claude Code fallback that is actually installed, and it carries the native-preference marker. |
| `openai-codex` | UM `scripts/codex-usage-collector.mjs` | v2 batch | usage | openai | codex-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Live LaunchAgent; parses `last_token_usage`, skips total-stagnant replays, and resumes from a successful-through watermark with a 24-hour idempotent catch-up overlap.  BotFleet-child exclusion is gated by `USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1` until BotFleet's durable sender is deployed |
| `grok-build` | UM `scripts/grok-usage-collector.mjs` | v2 batch | usage, cost | xai | grok-build | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | `~/.grok/sessions/**/updates.jsonl` `sessionUpdate=turn_completed` + `usage.modelUsage`; costUsd is `costUsdTicks / 1e10` |
| `github-copilot` | UM `scripts/copilot-usage-collector.mjs` | v2 batch | usage | github-copilot | copilot-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Live LaunchAgent; `session.shutdown` `modelMetrics[].usage` totals are cumulative, so the parser emits deltas; resumes from the same durable watermark |
| `antigravity-cli` / `antigravity-statusline` | UM quota + status-line collectors | v2 batch | quota / usage | google-antigravity | antigravity-cli | actual quota / estimated API equivalent | actual | cumulative input/output; cacheRead/cacheCreation only when current usage reconciles | resolved model only for a reconciled request; otherwise unknown | n/a | Official `/usage` quota windows plus cumulative CLI status-line totals.  The sink captures each total change, handles counter resets with a new generation, and accepts current model/cache fields only when they reconcile to the cumulative delta.  It stores only hashed session ID, model, counters, and timestamp |
| `minimax-code` | UM `scripts/minimax-usage-collector.mjs` + `scripts/minimax-runtime-usage-collector.mjs` | v2 batch | quota, usage | minimax | minimax-code | actual | actual (tokens), estimated (cost) | input/output/cacheRead/cacheCreation from the runtime ledger | model when the runtime writes one (the Mac build leaves it empty, UM-1615) | n/a | Official `mmx quota show --output json` for rolling and weekly remaining percentages, plus the desktop runtime's exact per-turn ledger `local_runtime_token_usage` (UM-1637): one row per agent turn (mavis, worker, explore, verifier) with split token counts, read read-only from the runtime sqlite.  `cost_usd` is 0 there, so no cost event is sent and Usage Monitor derives an API-equivalent estimate |
| `muse` | UM `scripts/muse-usage-collector.mjs` (VM cron, NOT Mac LaunchAgent) | v2 batch | quota | muse | muse-cli | actual | actual | n/a | n/a | n/a | Parsed from the `subscription-status` CLI stdout at the `SUBSCRIPTION_STATUS_BIN` runtime path; cron every 15 min; two windows — `muse:free-weekly` (with reset) + `muse:additional-tokens` (balance, no reset).  Per-producer scoped ingest token `MUSE_INGEST_TOKEN`; falls back to `USAGE_INGEST_TOKEN`.  Plan-active hours only on this VM, not on the laptop, because the binary is collector-VM-only. |
| `muse-code` | UM `scripts/muse-code-usage-collector.mjs` | v2 batch | quota | muse-code | muse-code | actual | actual | n/a | n/a | n/a | macOS keychain credential (`ai.meta.dev.credentials` / `meta`); official Meta CLI quota poll; 5h rolling + weekly remaining-percent windows from `subs_usage`.  First read from a non-GUI session blocks on a keychain ACL prompt until the owner grants "Always Allow" for the collector process; until then the script logs the hint and exits 0 with zero events.  Token and response body never logged or persisted.  No exact per-turn token ledger |
| `deepseek-dsh` | UM `scripts/deepseek-usage-collector.mjs` | v2 batch | usage | deepseek / minimax / muse-code (by `source.provider`) | deepseek-harness | estimated | actual | input/output/cacheRead/cacheCreation; reasoning detail on output metadata; `durationMs`, `harness` (dsh or clutch), `billingMode` (payg or subscription) | model | n/a | Exact `assistant/message.data.usage` from `session.jsonl.zstd` and `session.v3.jsonl.zstd` under `~/.dsh` and `~/.clutch/dsh`; v1/v3 twins dedupe by message id; DeepSeek messages through 2026-09-09 keep the pre-v3 event shape so replays do not 409; BotFleet-workspace exclusion uses the same post-deployment gate |
| `opencode` | UM `scripts/opencode-usage-collector.mjs` | v2 batch | usage | opencode / minimax / muse-code (by `model.providerID`) | opencode | estimated | actual | input/output/cacheRead/cacheCreation; reasoning folded into output with `reasoningTokens` and `outputTokensExcludingReasoning` in metadata; `durationMs`, `harness`, `billingMode` (free, subscription or payg), `reportedCostUsd` when opencode reports one | model | n/a | `session_message` assistant rows in `~/.local/share/opencode/opencode.db`, opened read-only; only rows with `time.completed`; no cost event, UM derives cost from tokens |
| `fx` | UM `scripts/fx-usage-collector.mjs` | v2 batch | usage | xai | fx | estimated | actual | input (cache reads split out)/output/cacheRead/cacheCreation; reasoning detail on output metadata; `harness`, `billingMode` | model | n/a | `generation` facts in `~/.fx/usage.jsonl` keyed by fact id; `total_cost` is always 0 so no cost event is sent |
| `botfleet` | BotFleet `server/telemetry.ts` | v2 batch | usage, cost, limit | anthropic/openai/xai/google-ai/deepseek/moonshot/cursor/minimax/box/openai-compat | claude-code/codex-cli/grok-build/gemini-cli/deepseek-dsh/moonshot-kimi/cursor-agent/minimax-cli/box-api/openai-compat/... | actual or estimated per event | source-specific | input/cacheRead/output | model | `{ scope: "conversation", mode: "aggregate", relationship: "self", reportThrough: "botfleet" }` | BotFleet owns child-turn telemetry; standalone collectors must exclude those sessions because ingest deduplication is producer-scoped |
| `socratic-trade` | Socratic.Trade `src/lib/usage-monitor-push.ts` | v2 batch | usage | tradier, finnhub, polygon, alphavantage, tiingo, twelvedata, sec, fmp, ... (per call-volume row) | `<provider>`-call-volume | actual | actual | n/a | n/a | n/a | events are call-volume rollups, not token events; `requests`+`successes`+`failures`; `label` echoes the source window id; `keySource`+`userId` ride metadata |
| `congress-trade` | Congress.Trade `app/src/shared/thirdPartyTelemetry.ts` | v2 batch | usage, cost, limit | mapped via `remapOpenRouterTelemetry` (openrouter → upstream provider) + raw providers (tradier, ...) | per descriptor | actual | actual | n/a (n/a for the wired sources) | n/a | n/a | Uses `createUsageTelemetryClient` from the shared package; routes through the same `/api/ingest/usage` |

## Coding-seat dimension audit

`Exact` means the native source supplies the value.  `Included` means a native total contains that component but does not break it out.  `Unavailable` stays null and must never be inferred from text length or treated as zero.

| Source | Requested / resolved model | App, surface, version | Cache read / write | Reasoning | Outcome, latency, retries | Cost provenance |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code OTLP | Resolved model | `claude-code`; exporter version only when OTLP supplies it | Exact / exact | Included in output | Native OTLP attributes only | Native reported cost when present; otherwise catalog-derived API equivalent |
| Codex CLI | Resolved model from turn/session usage; requested model unavailable | `codex-cli`; CLI version unavailable in session event | Exact / exact when supplied | Included in output; separate count unavailable | Unavailable | Catalog-derived API equivalent; OAuth subscription is not API cash billing |
| Grok Build | Resolved model per `modelUsage` | `grok-cli`; version unavailable | Exact / exact when supplied | Included in output | Completion outcome only; latency/retries unavailable | Native `costUsdTicks` retained as provider-reported estimate |
| Copilot CLI | Resolved model per shutdown metric | `copilot-cli`; version unavailable | Exact / exact | Included in output | Shutdown completion only | Catalog-derived API equivalent; subscription cash cost is separate |
| Antigravity CLI | Resolved model only when current usage reconciles; otherwise unknown | `antigravity-cli`; CLI version unavailable in snapshot | Exact only when current-request fields reconcile to cumulative input; otherwise unavailable | Included in output | Each cumulative change and counter-reset generation; latency/retries unavailable | Mixed/missed deltas are unpriced under `unknown-antigravity-model`; plan quota is actual remaining percent |
| Antigravity Desktop | Unavailable | Process presence only | Unavailable | Unavailable | Unavailable | Unavailable |
| DeepSeek Harness | Resolved `message.source.model`; requested model unavailable | `deepseek-harness`; archive version unavailable | Exact / exact when supplied | Exact diagnostic count, included in output total | Assistant completion; latency/retries unavailable | Agents PAYG prices each raw event from `occurredAt` UTC peak/off-peak (cache read = hit, uncached input = miss).  Flat catalog rates stay unused.  Daily rollups older than the raw cutoff have no hour and stay incomplete |
| MiniMax Code | Runtime model only when the build writes it (the Mac build never does, UM-1615) | `minimax-code`; `mmx` quota command plus the desktop runtime ledger | Exact / exact | Included in output; separate reasoning count rides metadata | Turn completion only; latency and retries unavailable | Exact tokens from `local_runtime_token_usage`; actual remaining-percent quota; API-equivalent cost derived from tokens because the ledger's `cost_usd` is 0 |
| Muse Code | Quota model only | `muse-code`; Meta CLI's `/muse-code/key` quota windows | Unavailable | Unavailable | Quota fetch outcome only | Actual remaining-percent quota for the 5h rolling and weekly windows; token and API-equivalent cost unavailable |
| Kimi Code | Request model exists in wire log but exact token split is unavailable | Process presence only in UM | Unavailable | Unavailable | Unavailable | Unavailable; measured-plus-estimated internal turn totals are excluded |
| Cursor | Resolved model on each Admin API usage event | `cursor-client` (connected editor or CLI; the API does not split them), `cursor-headless`, or `cursor-cloud-agent` | Exact read / write on token-based events; unavailable on request-priced events | Unavailable | Optional, team-plan only.  Hourly Admin API poll when `CURSOR_ADMIN_POLLER_ENABLED` and `CURSOR_ADMIN_API_KEY` are both set.  Off otherwise.  Per-event latency and retries are not in the payload | Billed `chargedCents` (includes the Cursor Token Rate) as `costUsd`.  Included-plan events keep Cursor's attributed cents.  The seat fee stays a separate Subscription and is not this number.  Hook turns are AgentTurn detail and carry no billed cost |
| BotFleet child turns | Resolved per-turn model; requested model is available at the harness selection boundary but is not yet sent separately | `botfleet` plus driver/service; build version unavailable | Exact read cache; write cache unavailable in current turn contract | Included in output | Success and latency field when supplied; retry count unavailable | Provider actual cost when supplied; otherwise metadata marks API-equivalent estimate |

Collector acknowledgements expose `received`, `persisted`, `duplicates`, `pruned`, and `rejected`.  Durable watermarks advance only after a complete scan and every batch receives a rejection-free acknowledgement; explicit backfills never move the recurring checkpoint.  A 24-hour idempotent overlap catches delayed shutdown records and late writes.  Retryable errors retain the watermark and replay stable event IDs.  Delivery lag is observable as event `occurredAt` versus persistence time, but no collector currently exports a separate lag series.

## Mac receipt verification (2026-09-13)

The live receiver acknowledged these bounded passes without credentials or payload content in the evidence: Codex `556 received / 555 persisted / 0 rejected`, DeepSeek Harness `524 / 524 / 0`, MiniMax quota `4 / 4 / 0`, and Grok replay `344 / 0 / 0`.  Grok's zero persisted count proves receiver idempotency for a full replay.  Copilot had no new events.  Antigravity's exact status-line sink had no new native snapshot yet, so activation is verified separately from receipt coverage.

## Producer matrix (poll adapters — non-v2 path)

UM poll adapters do **not** go through `/api/ingest/usage`; they write `UsageSnapshot` rows directly.  The two ingest paths are kept separate by design (per `AGENTS.md` "Push-primary providers"): the v2 ingest is the only event-stream; poll snapshots are point-in-time balance/total reads.

| Provider | Adapter | Poll cadence | Writes | Notes |
| --- | --- | --- | --- | --- |
| `anthropic` (org) | `src/lib/adapters/anthropic.ts` | every POLL_INTERVAL_MS (15 min) | `UsageSnapshot` (balance, totalCost, totalRequests) | `orgId`-keyed, pollable |
| `voyage` | blind (push only) | n/a | n/a (events only) | `ExternalUsageEvent` from the v2 ingest |
| `robinhood` | blind (push only) | n/a | n/a | `ExternalUsageEvent` from the v2 ingest |
| `tiingo`, `fmp`, `alphavantage`, `finnhub`, `polygon`, `tradier`, `twelvedata`, `sec`, `massive`, ... | `src/lib/adapters/*.ts` | 15 min | `UsageSnapshot` | Cost-coverage caveat tracked in `costCoverageCaveat`; keySource attribution via `key-attribution` |

## In-process billed pollers (not v2, not snapshots)

These write `ExternalUsageEvent` from a vendor API.  They do not go through `/api/ingest/usage`, and they do not write `UsageSnapshot` (a snapshot of the same cents would double count under `max(snapshot, pushed)`).

| Producer | Module | Cadence | Endpoint | Persisted row | Notes |
| --- | --- | --- | --- | --- | --- |
| `cursor-admin` | `src/lib/cursor-admin-poller.ts` | optional; at most hourly, from the 15-minute scheduler, and only when enabled | `POST https://api.cursor.com/teams/filtered-usage-events` | `sourceApp=cursor-admin`, `provider=cursor`, `metricType=cost`, `billingMode=actual`, `confidence=actual` | Optional and team-plan only.  Off unless `CURSOR_ADMIN_POLLER_ENABLED` is `true`, `1`, `on`, or `yes` and `CURSOR_ADMIN_API_KEY` is set.  When the flag is unset the job and the Sentry cron monitor are not registered (no skip logs, no check-ins).  Enabled without the key fails startup with `CURSOR_ADMIN_API_KEY is required`.  Basic auth uses the key as the username and an empty password.  One row per usage event.  `costUsd = chargedCents / 100`.  `keyRef` is the model.  `label` is the kind (`Usage-based`, `Included in Business`, …).  Tokens and `userEmail` ride metadata.  `service` is `cursor-client`, `cursor-headless`, or `cursor-cloud-agent`.  Idempotency key is `cursor-admin:` plus a length-prefixed SHA-256 of the event identity (the API has no event id).  Daily-usage-data has no dollars.  `/teams/spend` is the same charged cents totaled, so it is not stored again.  When both are set, Sentry cron slug `usage-monitor-cursor-admin` (60 minutes) is upserted by the poller's check-ins.  New rows fan out through `fanoutPersistedUsage(..., "poll")`.  Hook script turns stay on `AgentTurn`. |

## Field-level coverage (v2)

Fields the schema makes optional, and which producers actually send them.

| Field | Schema | Producers sending it | UM treatment |
| --- | --- | --- | --- |
| `eventId` | optional (re-derived if absent) | botfleet, socratic-trade, congress-trade, claude-code, all local collectors | Persisted; if absent, derived via shared `deriveUsageTelemetryIdempotencyKey` |
| `environment` | optional, defaults to producer's `env` | all v2 producers | Persisted; falls back to `process.env.SENTRY_ENVIRONMENT ?? "production"` |
| `provider` | required | all | Persisted; `Provider` row case-insensitive match in `budget-status.ts` (JS, not Prisma `mode: insensitive` — SQLite) |
| `service` | required | all | Persisted |
| `project` | optional | botfleet, socratic-trade, congress-trade | Resolved at ingest via `src/lib/project-resolver.ts` (case-insensitive); unknown names ride metadata + can be back-filled |
| `producerKeyRef` | optional | botfleet (model), all local collectors (model) | Persisted as `keyRef`; used by `/api/key-attribution` |
| `providerConnectionRef`, `billingAccountRef` | optional | congress-trade, socratic-trade (via `keySource`, `userId`) | Persisted |
| `coverage` | optional | botfleet | Persisted as `coverage` JSON; not in idempotency basis |
| `billingMode` | optional | all (actual or estimated) | Persisted |
| `metricType` | required | all (usage, cost, subscription, quota) | Persisted; **`quota_sync` and `credit_balance` are monitor-only** — the shared schema does not advertise them as producer-supplied.  A producer emitting them will pass Zod parse but the row will land in monitor-owned code paths only. |
| `quantity` | optional | local collectors, claude-code OTLP | Persisted |
| `unit` | optional | all | Persisted; defaults to `event` |
| `costUsd` | optional | all (botfleet: actual, local: estimated) | Persisted; cash math is recorded-wins, derived is metadata-only |
| `requests` | optional | socratic-trade, congress-trade | Persisted |
| `credits`, `limit`, `limitWindow` | optional | some producers | Persisted |
| `tier` | optional | some | Persisted |
| `confidence` | optional | all (actual or estimated) | Persisted |
| `windowStart`, `windowEnd` | optional | quota/budget producers | Persisted |
| `occurredAt` | required | all | Persisted; defaults to producer's `windowEnd` |
| `providerRequestId` | optional | some | Persisted; used by `/api/external-usage-events-provider-request-id` and the key-attribution link |
| `metadata` | optional (record) | all (tokenType, model, roomId/roomName, keySource, userId, ...) | Persisted; reserved keys enforced at the producer-ownership layer in `src/lib/usage-telemetry.ts`; idempotency basis is the shared contract, NOT including `project` or any other metadata |

## Coverage gaps and known honest limitations

1. **`project` is excluded from the idempotency basis** — by design (`AGENTS.md` "Per-project cost attribution").  Adding a `project` field to a v2 producer does not rekey existing events.  If you mirror `project` into the shared package's `UsageTelemetryV2EventSchema`, do not put it into `deriveUsageTelemetryIdempotencyKey`.
2. **BotFleet's `roomId`/`roomName`/driver hint ride `metadata` only** — they are not first-class fields.  This is intentional: the v2 schema is intentionally narrow, and the metadata bag is the producer-extension point.  If we ever want to query "all token events in a BotFleet room", we'd add a `roomId` column on `ExternalUsageEvent` (a separate UM-side change, not a wire change).
3. **OTLP host `system.*` metrics** are routed but **not persisted** by default (`OTLP_SYSTEM_METRICS_INGEST_ENABLED=false`).  Owners can opt in.  The reason: a single Coolify process exporting host gauges would write thousands of `ExternalUsageEvent` rows per tick (UM AGENTS.md "OTLP metrics" + "system-mapper").
4. **Socratic.Trade's `provider-call-volume` events are not token events.**  They are request counts, not LLM token counts.  The v2 schema is designed to accept both; `metricType: "usage"` with `unit: "request"` is the right shape.
5. **Per-producer scoped tokens** (`USAGE_INGEST_PRODUCER_TOKENS`) are optional and default off.  When `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true` is set, the unscoped `USAGE_INGEST_TOKEN` is denied — producers must use their scoped token.  This is the recommended posture for new producers.
6. **The four `_derivedCost*` metadata keys are reserved.**  Producers cannot set them; UM's `derive-ingest-cost.ts` is the only writer.  This is the producer spoof-proofing boundary.
7. **Cursor has no unauthenticated local token ledger.**  Its ACP `store.db` exposes blobs and metadata, not trustworthy input/output usage.  Billed editor, CLI, and cloud-agent usage is optional and team-plan only.  It lands when `CURSOR_ADMIN_POLLER_ENABLED=true` and `CURSOR_ADMIN_API_KEY` are both set, from `POST /teams/filtered-usage-events` as `sourceApp=cursor-admin`.  Unset leaves the job and its Sentry cron monitor unregistered.  Enabled without the key fails startup.  The published event does not split editor from CLI; both land as `cursor-client` unless `isHeadless` or `cloudAgentId` says otherwise.  Hook turns stay on `AgentTurn` and are not cash.  gen_ai points for `cursor` and `cursor-agent` are overlap-skipped so they cannot sit beside these billed rows when the poller is on.
8. **Kimi Code has no durable exact local per-turn feed.**  Its wire log exposes model requests and an internal measured-plus-estimated turn count.  Its experimental authenticated web server exposes live session snapshots and plan usage only while that separate server is running; no always-on server is added solely for monitoring.  MiniMax Code is no longer in this class: its desktop runtime ledger is collected (UM-1637), though the Mac build's empty model column (UM-1615) still limits it to tokens and agent names there.
9. **DeepSeek V4 API-equivalent price is time-dependent.**  Peak/off-peak depends on the request's UTC weekday and hour.  Grouped token buckets cannot choose a truthful flat rate, so these models remain explicitly unpriced until request-time derivation is supported.
10. **Sentry is diagnostic, not a second billing ledger.**  UM records low-cardinality ingest failures, admission drops, and schema-rejected event counts.  It does not copy event IDs, validation details, prompts, tool arguments, transcript text, session paths, credentials, tokens, or costs into those signals.
11. **BotFleet-child exclusion is not loss-free until its durable sender is deployed.**  The standalone collectors therefore keep child sessions eligible by default.  Enabling `USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1` is an activation step after BotFleet confirms durable replay and a real receiver acknowledgement.  BotFleet outbox overflow or destination-change drops remain explicit coverage gaps even after activation.
12. **A producer stream can look alive while its tokens are missing.**  The producer-staleness rules judge a token stream by its newest row of that `metricType`, which a heartbeat satisfies: Claude Code's `session.count` and `active_time.total` rows are `metricType = "usage"`, so the stream stayed fresh for two days after `claude_code.token.usage` stopped.  Rules with `requiresTokens` are judged by the newest row with `unit = "token"` instead, and the six token streams use it (`src/lib/producer-staleness.ts`).
13. **A credential that does not own the row it carries gets a `403` and no other signal.**  Every scope refusal is now counted as `ingest.scope_rejected` in Sentry with the route and the refused dimension (`src/lib/sentry-ops.ts`), because a refused trace batch leaves the metrics and logs batches of the same session landing and looks like a healthy feed.

## Sentry fanout for per-request telemetry (UM-1637)

Ledger rows have always fanned out to the fleet-infra Sentry project as aggregate `usage.persisted` counters.  Per-request rows (`AiRequest`) now do the same: each persisted batch emits an `ai.request` counter per harness and model, plus mean `ai.request.duration_ms` and `ai.request.ttft_ms` gauges where the harness reported them, from `fanoutAiRequests` in `src/lib/usage-fanout.ts`, called by the logs, traces, and generic ingest routes.

Nothing else leaves the process: no prompts, responses, tool arguments, session ids, or costs.  Usage Monitor stays the ledger for tokens and cost; Sentry gets counts, durations, model names, and status, as the existing contract requires.

`ingest.scope_rejected` and `ingest.events_rejected` are mirrored to fleet-infra too, like `ingest.failed` already was, so a refused or rejected producer is visible in the shared fleet health view and not only in this app's own Sentry project.

## Verifying a new producer against this matrix

Before a new producer is wired:

1. Implement the producer side using `createUsageTelemetryV2Event` and `createUsageTelemetryClient` from `@jaywedgeworth22/congress-trading-shared`.
2. Send a single-event batch in dry-run mode to a local UM instance (`npm run dev`, `USAGE_MONITOR_INGEST_URL=http://localhost:3000/api/ingest/usage`).
3. Confirm `/api/ingest/usage` returns `200`, `attempted: 1`, `persisted: 1`, `duplicates: 0`, `rejected: 0`, `pruned: 0`.  Any non-zero `rejected` is a schema mismatch — read the typed error in the response body.
4. Replay the same batch and confirm `persisted: 0, duplicates: 1` — that proves idempotency works.
5. Add a row to the matrix above (PR, even if no code change).

## Update cadence

This matrix is updated every time a new producer lands or a producer changes its v2 event shape.  It is the canonical reference; the code comments at the top of `src/lib/usage-telemetry.ts` are the wire reference; the shared package `UsageTelemetryV2EventSchema` is the absolute truth.
