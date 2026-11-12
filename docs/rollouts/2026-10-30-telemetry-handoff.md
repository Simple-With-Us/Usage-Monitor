# Telemetry Handoff Follow-Up

Refs UM-1646.

## SQLite Ingest

Production reported `externalUsageEvent.createMany()` failures as “Operation has timed out.”  The installed Prisma SQLite adapter maps SQLite busy errors to `SocketTimeout`/`P1008`; that wording alone does not establish a slow insert or expired transaction.

A two-connection WAL regression reproduces the same error when a deferred transaction reads replay/tombstone state, another writer commits, and the reader attempts its insert (`SQLITE_BUSY_SNAPSHOT`).  The persistence transaction now reserves the SQLite writer with an indexed, zero-row update before its first read.  It changes no event values and keeps collision checks, tombstone protection and inserts atomic.  An existing external writer can still hold the database; explicit SQLite busy/locked errors return `503 receiver_busy` with a five-second retry delay and log only the bounded SQLite error code.  Other errors remain failures.  The HTTP admission lease remains held until all work settles.

The regression uses the adapter's own SQLite library for both connections.  Using two separately compiled SQLite libraries inside one process does not provide a valid lock-contention test because their process-local lock bookkeeping differs.

## Preserve Child Telemetry

### Implementation snapshot recorded October 30 (superseded by the November 3 source audit)

The former BotFleet drop flag could discard rows from the same child session and time window without proving that BotFleet billed them.  It is now inert, even when configured as `1`, and performs no database query.  A future replacement needs authoritative per-call identities and quantities reconciled to the sender's billed aggregate; session and timing are insufficient.  Native OTLP mapping retains the two allowlisted launcher correlation fields.  No existing stored data is deleted or rewritten.

The collector parser/runtime suites already run explicitly in CI.  Opencode non-token correlation enrichment is prepared in a separate collector delivery slice, preserving event identities and using the existing one-sided replay compatibility rule.

### Deployment verification recorded October 30 (not refreshed by the source audit)

This document is implementation evidence, not a claim of deployment or Sentry receipt.  Live ingest needs a restart and collector backlog check after deployment.  Sentry coverage needs a durable, privacy-preserving path for transcript collectors; activating the existing OTLP hub alone does not connect those collectors.  Exact BotFleet billed-call suppression, historical overcount cleanup and credential rotation remain separate work until their evidence and owner decisions are recorded.

SQLite reference: [Isolation And Concurrency](https://www.sqlite.org/isolation.html).

## 2026-11-03 Source And CI Reconciliation

This appendix records repository source and CI wiring, not production deployment, runtime configuration, or telemetry receipt.  It supersedes the October 30 implementation snapshot above.

MiniMax runtime usage is correlated to workspace data by exact `session_id` and `workspace_dir`; duplicate or ambiguous session rows receive no launcher attribution, and usage events retain their existing IDs and quantities.  OpenCode token, cost, and context rows carry session correlation, and BotFleet workspace sessions receive launcher attribution without changing event identity.  The native OTLP metadata allowlist preserves `agent.launcher` and `agent.launcher.session`.

Aggregate native coverage remains fail-open and performs no database lookup.  Separate BotFleet child suppression requires the opt-in `BOTFLEET_CHILD_COVERAGE_DROP=1`, a BotFleet-scoped receiver credential, and a persisted signed single-call receipt with matching session, call, model, host, and token-component quantities.  Missing authorization or incomplete evidence preserves the child event; no time-window fallback is used.

CI explicitly runs the parser, native telemetry, and collector runtime suites:

- `npm run test:session-token-collectors`
- `node --test scripts/collector-sentry-bridge.node-test.mjs scripts/telemetry-hub-auth.node-test.mjs scripts/telemetry-hub-bootstrap.node-test.mjs scripts/telemetry-native-followup.node-test.mjs`
- `npm run test:collector-runtime`

Related implementation and review: PRs #1844, #1847, #1848, and #1850.  This source audit did not verify deployed flag state or production receipts.
