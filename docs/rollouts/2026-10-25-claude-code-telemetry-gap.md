# Claude Code telemetry gap, and the two defects it exposed (2026-10-25)

Tracking: UM-1636.  Related: UM-1614 (Mac telemetry hub), UM-1625 (collector freshness).

Goal of this unit: get as much LLM-usage telemetry from every AI platform into Usage Monitor and Sentry as the sources can honestly give, and make a dead feed visible instead of silent.

## What was broken, and the evidence

Production read-only checks against the ledger and the request table (no prompt, response, tool content, session identity, credential, or raw log was read):

- `ExternalUsageEvent` rows with `sourceApp = "claude-code"` and `metricType = "usage"`: 4,482 rows on Oct 21, 2,468 on Oct 22, 161 on Oct 23, 78 on Oct 24, 7 on Oct 25.
- Every metric that carries a `model` attribute stopped together: `claude_code.token.usage` (last real rows Oct 24), `claude_code.cost.usage` (Oct 24), `claude_code.lines_of_code.count`, `claude_code.commit.count`, `claude_code.pull_request.count`, and `claude_code.code_edit_tool.decision` (all last Oct 22).
- The metrics that carry no `model` attribute kept arriving: `claude_code.session.count` and `claude_code.active_time.total` were still landing on Oct 25.
- The Mac transcripts say the sessions really were calling the model: 25,057 assistant messages with a `usage` block across the last 36 hours, the newest file written seconds before the check.
- The request table (`AiRequest`) shows the same cliff: 2,208 Claude Code rows on Oct 22, 76 on Oct 23, 25 on Oct 24, none on Oct 25.

Two canaries were POSTed to production to separate a server fault from a producer fault, and both canary rows were deleted afterwards:

- A hand-built `claude_code.token.usage` plus `claude_code.cost.usage` OTLP metrics payload was accepted (`202`, `accepted: 2`) and persisted as two `ExternalUsageEvent` rows.
- A hand-built `claude_code.api_request` OTLP logs record was accepted (`202`, `inserted: 1`) and persisted as one `AiRequest` row.

So the ingest paths, the mapper, and the database were all healthy.  The exporter stopped producing the request-scoped signals; the receiver was not dropping them.

## Defect 1: Claude Code trace batches were refused with 403

`/api/otlp/v1/traces` authorizes a producer-scoped credential against the turn dimension (`AgentTurn.platform`) and the request dimension (`AiRequest.harness`).  Claude Code's spans carry `gen_ai.system = "anthropic"` and no `agent.platform`, so the turn dimension resolved to the model vendor, and a credential minted for the producer `claude-code` was refused for the entire batch with `403 Credential is not authorized for platform "anthropic"`.

The failure was invisible from the outside in the worst way: the same session's metrics batch and logs batch still landed, so the feed looked alive while the trace batch died on every export.  The Claude Code debug log on the Mac said `First traces export: FAILED (Forbidden)`.

Fix: `src/lib/otlp/traces-mapper.ts` now resolves the turn platform from the span prefix (`claude_code.*` means the `claude-code` harness) and from `service.name`, before falling back to `gen_ai.system`.  An explicit `agent.platform` attribute still wins, and every other producer keeps the previous resolution order.

The turn dimension is also now correct on its own terms: `AgentTurn.platform` is a coding-platform value (`claude-code`, `codex`, `cursor-agent`), not a model vendor.

## Defect 2: a heartbeat row satisfied the token-coverage rule

`src/lib/producer-staleness.ts` judged each producer stream by the newest row of that `metricType`.  Claude Code's `session.count` and `active_time.total` rows are `metricType = "usage"`, so the stream looked fresh for the whole two days while the token rows were missing.  The rule existed precisely to catch a dead collector, and a heartbeat satisfied it.

Fix: a rule may declare `requiresTokens`, and then it is judged by the newest row with `unit = "token"` instead of any row of the metric type.  The six token streams (`claude-code`, `openai-codex`, `grok-build`, `deepseek-dsh`, `opencode`, `botfleet`) now use it; the quota streams are timer-driven and carry no tokens, so they are unchanged.

The Pushover message names those streams as `claude-code usage (token rows)` so the alert says what is missing.

## Defect 3: a scope refusal was silent

A credential that presents a producer id the receiver does not recognise gets a `403` and nothing else: no counter, no log, no dashboard row.  That is how the trace failure above stayed invisible.

Fix: `src/lib/sentry-ops.ts` gains `recordIngestScopeRejected`, and the four ingest routes (`/api/ingest/usage`, `/api/otlp/v1/metrics`, `/api/otlp/v1/logs`, `/api/otlp/v1/traces`) count every scope refusal as `ingest.scope_rejected` with the route and the refused dimension.

## What is still missing, honestly

Claude Code's own OTLP exporter stopped emitting `claude_code.token.usage`, `claude_code.cost.usage`, and the `claude_code.api_request` log event after Oct 23, while `claude_code.session.count` and `claude_code.active_time.total` kept flowing.  The same binary (2.1.303) emitted the request-scoped metrics on Oct 22 and on the morning of Oct 23, and the Mac's Claude Code settings, credentials, token, and endpoint were unchanged across the cliff.  No local configuration change reproduces the cutoff, so this is a producer-side (Anthropic) behaviour change, not a Usage Monitor fault.

The consequence is large: roughly one day of the owner's heaviest coding tool's tokens and requests are missing from the ledger, and the request-performance table lost its `claude-code` harness rows.

The exact source still exists: the Mac transcripts under `~/.claude/projects/**.jsonl` carry per-message `usage` for every request.  `scripts/claude-usage-collector.disabled.mjs` in this repo already parses that shape and is disabled precisely because the native OTLP path used to cover the same usage.  Re-enabling it needs one decision that has not been made yet: how to keep the transcript collector and the native exporter from double counting if the native path ever comes back.

## Next steps

1. Decide the native-vs-transcript precedence for Claude Code, then re-enable the transcript collector as a gap filler rather than as a second full feed.
2. Keep the staleness rule on token rows; it is what makes the next version of this failure loud.
3. UM-1614's Mac hub stays the place where the Sentry-side scrubbed signal is produced; it is still not installed on the Mac.

## Verification

- `npx vitest run src/lib/otlp/__tests__/traces-mapper.test.ts src/app/api/otlp/v1/__tests__/traces-route.test.ts src/lib/__tests__/producer-staleness.test.ts` covers the harness-label fix, the scoped-credential regression, and the token-coverage rule.
- `npm run typecheck` and `npm run lint` pass in the hosted CI run linked from the PR.
