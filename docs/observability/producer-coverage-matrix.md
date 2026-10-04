# Producer coverage matrix — UM v2 ingest (2026-09-13)

Authoritative map of every known producer of `/api/ingest/usage` (and `/api/otlp/v1/metrics`) data, the v2 fields they send, the fields UM accepts, and any gap.  When this list drifts from reality, fix the list, not the contract: the v2 wire is owned by `@jaywedgeworth22/congress-trading-shared` and changes there require a cross-app PR.

## How the wire works

- v2 batch envelope = `{ schemaVersion: 2, producerId, producerInstanceId?, events: UsageTelemetryV2Event[] }` parsed by `src/lib/usage-telemetry.ts` against `UsageTelemetryV2BatchSchema` and `UsageTelemetryV2EventSchema` from `@jaywedgeworth22/congress-trading-shared`.  `sourceVersion` and `environment` are NOT batch-level fields in the strict v2 schema; `environment` lives on each event.
- Auth: `Authorization: Bearer ${USAGE_INGEST_TOKEN}` (or per-producer `USAGE_INGEST_PRODUCER_TOKENS` mapping when `USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true`).
- Idempotency: `eventId` is the producer's durable key; UM re-derives the same length-prefixed SHA-256 from the shared contract when absent.
- Persisted result semantics (narrower than request acceptance): `attempted` = submitted events, `persisted` = newly inserted rows, `skippedPrunedDuplicates` = blocked by retention tombstones.  Never derive `persisted` from `activeEvents.length`.
- Reserved `metadata` keys (producer spoof-proof): the four `_derivedCost*` keys, the `tokenType` split, the `coverage.*` echoes, the `project` mirror, and the per-source anchors.  Producers can add their own keys; see `src/lib/usage-telemetry.ts`.

## OTLP path (parallel to v2)

`POST /api/otlp/v1/metrics` accepts `Content-Type: application/json` (primary) or `application/x-protobuf`.  Does **not** accept gRPC (Claude Code's default `OTEL_EXPORTER_OTLP_PROTOCOL` value) — a gRPC-configured client gets `415` telling it to switch to `http/json` or `http/protobuf`.  Same bearer token as v2 ingest.  Both routes are excluded from the dashboard-session middleware (`src/middleware.ts`'s `api/otlp(?:/|$)` exclusion).

`POST /api/otlp/v1/logs` is a 200 accept-and-drop stub: errors and health stay in Sentry per the owner goal split; only metrics land here.

## Producer matrix (v2 ingest)

Rows distinguish a live feed from parser code that merely exists in the repository.  A local file format is not coverage until an installed collector delivers it successfully.

| Producer | Repo | Transport | `metricType` | Provider values | Service values | `billingMode` | `confidence` | `tokenType` split | `producerKeyRef` | `coverage` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code` (OTLP) | UM `/api/otlp/v1/metrics` | OTLP JSON/protobuf | usage, cost | anthropic | claude-code | n/a (from metric) | actual | input/output/cacheRead/cacheCreation | n/a | n/a | Mapped from `claude_code.token.usage` + `claude_code.cost.usage` by `src/lib/otlp/claude-code-mapper.ts`; idempotency key = hash(metric + attrs + window + value) |
| `claude-code` (local fallback) | UM `scripts/claude-usage-collector.disabled.mjs` | v2 batch | usage, cost | anthropic | claude-code | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Parser is shipped but intentionally `.disabled.mjs`'d (audit #1509); the `.disabled.mjs` extension is not picked up by the collector manifest or LaunchAgent installer. Native Claude OTLP is the active path. To re-enable, rename to `claude-usage-collector.mjs` and flip this row to active before installing any LaunchAgent. |
| `claude-code` (fleet collector Claude section) | UM `scripts/fleet-usage-collector.mjs` (Claude Code block at line ~131) | v2 batch | usage, cost | anthropic | claude-code | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | **Default OFF** as of 2026-09-21 (Codex re-review P1 follow-up, audit #1509): the section is skipped unless `USAGE_MONITOR_FLEET_ENABLE_CLAUDE=1` is set. Native Claude OTLP is the documented active path; an operator who runs both would double-count Claude Code usage (v2-batch and OTLP idempotency keys do not dedup). Re-enabling this section requires acknowledging that native OTLP must NOT also be running. |
| `openai-codex` | UM `scripts/codex-usage-collector.mjs` | v2 batch | usage | openai | codex-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Live LaunchAgent; parses `last_token_usage`, skips total-stagnant replays, and resumes from a successful-through watermark with a 24-hour idempotent catch-up overlap.  BotFleet-child exclusion is gated by `USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1` until BotFleet's durable sender is deployed |
| `grok-build` | UM `scripts/grok-usage-collector.mjs` | v2 batch | usage, cost | xai | grok-build | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | `~/.grok/sessions/**/updates.jsonl` `sessionUpdate=turn_completed` + `usage.modelUsage`; costUsd is `costUsdTicks / 1e10` |
| `github-copilot` | UM `scripts/copilot-usage-collector.mjs` | v2 batch | usage | github-copilot | copilot-cli | estimated | estimated | input/output/cacheRead/cacheCreation | model | n/a | Live LaunchAgent; `session.shutdown` `modelMetrics[].usage` totals are cumulative, so the parser emits deltas; resumes from the same durable watermark |
| `antigravity-cli` / `antigravity-statusline` | UM quota + status-line collectors | v2 batch | quota / usage | google-antigravity | antigravity-cli | actual quota / estimated API equivalent | actual | cumulative input/output; cacheRead/cacheCreation only when current usage reconciles | resolved model only for a reconciled request; otherwise unknown | n/a | Official `/usage` quota windows plus cumulative CLI status-line totals.  The sink captures each total change, handles counter resets with a new generation, and accepts current model/cache fields only when they reconcile to the cumulative delta.  It stores only hashed session ID, model, counters, and timestamp |
| `minimax-code` | UM `scripts/minimax-usage-collector.mjs` | v2 batch | quota | minimax | minimax-code | actual | actual | n/a | model | n/a | Official `mmx quota show --output json`; rolling and weekly remaining percentages.  MiniMax Code Desktop exposes no exact local per-turn token ledger |
| `muse` | UM `scripts/muse-usage-collector.mjs` (VM cron, NOT Mac LaunchAgent) | v2 batch | quota | muse | muse-cli | actual | actual | n/a | n/a | n/a | Parsed from `/opt/hatch/bin/subscription-status status` text on the hatch VM; cron every 15 min; two windows — `free-weekly` (with reset) + `additional-tokens` (balance, no reset).  Per-producer scoped ingest token `MUSE_INGEST_TOKEN`; falls back to `USAGE_INGEST_TOKEN`.  Plan-active hours only on this VM, not on the laptop, because the binary is hatch-only. |
| `deepseek-dsh` | UM `scripts/deepseek-usage-collector.mjs` | v2 batch | usage | deepseek | deepseek-harness | estimated | actual | input/output/cacheRead/cacheCreation; reasoning detail on output metadata | model | n/a | Exact `assistant/message.data.usage` from `session.jsonl.zstd`; BotFleet-workspace exclusion uses the same post-deployment gate |
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
| MiniMax Code | Quota model only | `minimax-code`; `mmx` native quota command | Unavailable | Unavailable | Quota fetch outcome only | Actual remaining-percent quota; token and API-equivalent cost unavailable |
| Kimi Code | Request model exists in wire log but exact token split is unavailable | Process presence only in UM | Unavailable | Unavailable | Unavailable | Unavailable; measured-plus-estimated internal turn totals are excluded |
| Cursor | Process presence only | Cursor/ACP process | Unavailable | Unavailable | Unavailable | Unavailable |
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
7. **Cursor has no unauthenticated local token ledger.**  Its ACP `store.db` exposes blobs and metadata, not trustworthy input/output usage.  Process state is reported; token and cost values stay unavailable rather than zero.
8. **MiniMax Code and Kimi Code have no durable exact local per-turn feed.**  MiniMax exposes exact Token Plan quota via `mmx quota`, which is collected, but the desktop app has no input/output ledger.  Kimi's wire log exposes model requests and an internal measured-plus-estimated turn count.  Its experimental authenticated web server exposes live session snapshots and plan usage only while that separate server is running; no always-on server is added solely for monitoring.
9. **DeepSeek V4 API-equivalent price is time-dependent.**  Peak/off-peak depends on the request's UTC weekday and hour.  Grouped token buckets cannot choose a truthful flat rate, so these models remain explicitly unpriced until request-time derivation is supported.
10. **Sentry is diagnostic, not a second billing ledger.**  UM records low-cardinality ingest failures, admission drops, and schema-rejected event counts.  It does not copy event IDs, validation details, prompts, tool arguments, transcript text, session paths, credentials, tokens, or costs into those signals.
11. **BotFleet-child exclusion is not loss-free until its durable sender is deployed.**  The standalone collectors therefore keep child sessions eligible by default.  Enabling `USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1` is an activation step after BotFleet confirms durable replay and a real receiver acknowledgement.  BotFleet outbox overflow or destination-change drops remain explicit coverage gaps even after activation.

## Verifying a new producer against this matrix

Before a new producer is wired:

1. Implement the producer side using `createUsageTelemetryV2Event` and `createUsageTelemetryClient` from `@jaywedgeworth22/congress-trading-shared`.
2. Send a single-event batch in dry-run mode to a local UM instance (`npm run dev`, `USAGE_MONITOR_INGEST_URL=http://localhost:3000/api/ingest/usage`).
3. Confirm `/api/ingest/usage` returns `200`, `attempted: 1`, `persisted: 1`, `duplicates: 0`, `rejected: 0`, `pruned: 0`.  Any non-zero `rejected` is a schema mismatch — read the typed error in the response body.
4. Replay the same batch and confirm `persisted: 0, duplicates: 1` — that proves idempotency works.
5. Add a row to the matrix above (PR, even if no code change).

## Update cadence

This matrix is updated every time a new producer lands or a producer changes its v2 event shape.  It is the canonical reference; the code comments at the top of `src/lib/usage-telemetry.ts` are the wire reference; the shared package `UsageTelemetryV2EventSchema` is the absolute truth.
