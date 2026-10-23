# Coding Platform Telemetry Completeness — October 23, 2026

Tracking: UM-1624.  Related hub campaign: UM-1614.  This audit distinguishes code support, configured collection, and confirmed receipt.

## Production Evidence

The public strict readiness endpoint returned `ok: true`, revision `ab901907910263d87ea4f33f148c2760477bd8d9`, with a healthy database and scheduler.  The R2 historic archive separately reported `archive_failed`; primary B2 replication was healthy.  Readiness is evidence of service health, not platform telemetry completeness.

The seven-day request-performance endpoint returned 27,317 requests with `truncated: false`.  The following counts came from a later bounded read-only SQLite aggregation of the rolling seven-day window; ingestion continued between the two samples.  No prompt, response, tool content, session identity, credential, or raw log was read for this audit.

| Request harness | Requests | Duration known | TTFT known | Both input/output known | Reported cost known | Latest event |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Claude Code | 15,930 | 15,930 | 15,706 | 15,930 | 15,683 | Oct 22, 8:57 PM |
| Codex | 9,655 | 9,601 | 8,863 | 9,018 | 0 | Oct 23, 11:40 AM |
| Claude Code CI | 1,080 | 1,080 | 0 | 1,080 | 0 | Oct 23, 1:51 PM |
| BotFleet | 181 | 181 | 178 | 33 | 0 | Oct 21, 6:29 AM |
| Socratic.Trade | 518 | 0 | 0 | 518 | 518 | Oct 23, 1:37 PM |

These are receipt counts, not completeness percentages against all real calls: no independent denominator for all coding activity was available.  A null cost is not zero cost; request analytics already derives catalog estimates separately where possible.  The performance response still contained unpriced MiniMax, Muse, and DeepSeek model variants.  No prices were guessed or substituted.

The separate seven-day `ExternalUsageEvent` ledger aggregation showed:

| Platform or producer | Token events | Tokens | Latest token event | Other receipt evidence |
| --- | ---: | ---: | --- | --- |
| Claude Code | 24,451 | 5,885,832,108 | Oct 23, 1:49 PM | Native cost events also present |
| Codex | 26,506 | 1,395,025,049 | Oct 20, 6:21 PM | Quota current on Oct 23; newer request telemetry exists |
| OpenCode | 20,907 | 2,123,159,422 | Oct 22, 8:05 PM | Entire token stream omitted from Agents Overview before this fix |
| DSH / Clutch shared producer | 204 | 12,934,157 | Oct 20, 3:00 PM | Collector distinguishes the harness in metadata |
| BotFleet | 1,124 | 78,872,208 | Oct 22, 6:56 AM | Request feed has fewer rows and different field coverage |
| CI autofix | 1,080 | 1,411,940,815 | Oct 23, 1:51 PM | Request feed reports harness `claude-code-ci` |
| Grok Build | 0 | — | — | 607 quota events; latest Oct 23, 1:55 PM |
| Antigravity | 0 | — | — | 170 quota events; latest Oct 23, 1:31 PM |
| MiniMax Code | 0 | — | — | 3,135 quota events; latest Oct 23, 1:55 PM |
| Muse | 0 | — | — | 202 quota events; latest Oct 22, 9:55 PM |
| Muse Code | 0 | — | — | 1,012 quota events; latest Oct 23, 1:45 PM |
| Cursor, Fx, Kimi, Copilot | 0 | — | — | No ledger rows from these source IDs in the window |

Absence from this window does not establish a broken collector or zero activity.  It establishes a receipt gap requiring source-side correlation.  Copilot was operationally retired by the owner on October 20 (UM-1618), so its absence is expected.  Quota receipts establish quota delivery only; they do not establish per-call model, tokens, context, or latency parity.

Sentry verification used the existing runtime token in place without exporting its value.  Project lookup, project received-event statistics, and an organization aggregate event query all returned HTTP 403.  No current Sentry receipt or field retention is claimed from these queries.  UM-1614 contains an earlier real canary probe that verified scrubbing and found custom numeric attribute loss; this change fixes that demonstrated loss in code and tests.

## Changes

- Include OpenCode and Fx in Agents Overview's raw/rollup source queries, cards, and model totals.  Keep their API-equivalent estimates in the existing analytics classification rather than cash billing.  Unknown models remain unpriced.
- Qualify the overview's Claude and Codex descriptions to match the implemented feeds.  A local CLI collector does not establish cloud or separate Desktop coverage.
- Serialize the four existing custom TTFT/context measurements as strings on Sentry paths, preserving zero and fractional values.  Keep recognized token counters numeric and preserve typed Usage Monitor input and content filtering.
- Give accepted spans missing native IDs a stable source-payload identity so unrelated spans no longer collapse into one journal event.  Preserve historical IDs for spans with native trace/span IDs.  A producer retrying an old missing-ID payload after upgrading can produce a new identity once; this compatibility limit affects malformed spans only and is another reason source deployment is separate from merge.
- Add OpenCode and Fx to generic gen_ai metric overlap exclusions and Fx to the hub's existing exclusion set.  An allowlist does not override deduplication; the existing explicit overlap switch still does.
- Correct the coverage matrix's obsolete accept-and-drop logs description and document request enrichment, hub signal limits, and delivery caveats.

## Remaining Gaps

1. Correlate source activity with old Codex and DSH ledger receipts and missing Grok/Antigravity token receipts (UM-1625).  Newer quota or request receipts do not prove those token collectors are current.  No source-side cause or required owner action was inferred.
2. MiniMax, Muse, Muse Code, Kimi, separate Desktop applications, and cloud coding sessions need native usage evidence or supported instrumentation before exact per-call parity can be claimed.  The MiniMax local model-column gap is already tracked as UM-1615; hub rollout remains UM-1614.
3. The hub rejects metrics with 501.  A future durable Usage Monitor metrics channel needs its own offset, retries, admission/auth behavior, and overlap policy.  Native Claude metrics should retain their working direct destination meanwhile.
4. Generic turn delivery can duplicate `AgentTurn` detail after a network timeout because receiver persistence has no durable event key.  A complete fix requires a compatible receiver identity and migration, not merely the hub's local sent set.
5. Modern GenAI semantic-convention aliases need a separate compatibility pass.  In particular, cache/reasoning attribute aliases, distinct requested/served models, and whether an input total includes cache must be reconciled across producers before changing ledger semantics.  [OpenTelemetry specifies input totals including cache](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/); guessing uncached versus inclusive totals risks incorrect cost attribution.
6. Current Sentry delivery and numeric-field retention require a credential with suitable read access.  This runtime credential's three read queries returned 403; no authentication or permissions were changed.

## Verification

Focused regression suites cover source inclusion, model totals, analytics classification, Sentry string encoding, unchanged input objects, content exclusion, stable span identities, and overlap policy.  Lint and typechecking passed.  The full Vitest run had 3,571 passing tests and nine failures in R2 storage/maintenance tests; a detached checkout of unchanged base `ab9019079` reproduced all nine failures.  The separate legacy Oracle deployment test also failed locally reading its temporary restore-command log.  Remaining repository checks and PR review receipts are recorded on UM-1624 and in the PR.  Native Apple builds and live Mac collector activation are outside this Linux verification environment.

The web deployment and collector rollout are separate artifacts.  Merging server code does not install a new Mac collector or hub build.  This task does not restart exporters, enable a listener, alter disabled hooks, or modify security/trust settings.
