# Telemetry correctness and BotFleet de-duplication (2026-10-29)

Related: UM-1614 (Mac telemetry hub), UM-1636 (Claude Code gap), UM-1637 (complete telemetry).  BotFleet sends the matching join keys in its own PR.

## What was wrong

**Claude Code transcripts counted every call two to three times.**  Claude Code writes one assistant line per content block (thinking, text, each tool use), and every line repeats the same `message.usage`.  The transcript parser emitted rows per line.  Over 6,523 recent lines on the server there were 2,999 distinct calls (2.18x), and every repeated line carried identical usage.  Since native Claude OTLP stopped on Oct 23, the transcript feed is what reaches the ledger on both hosts.

**Claude Code cache reads were reported as zero.**  The parser ran Claude usage through `splitInclusiveCache`, which assumes Codex semantics (input includes cached reads).  Anthropic's `input_tokens` excludes cache reads and writes.  Whenever cache reads exceeded the uncached input, which is 6,778 of 6,798 calls over three days on the server, the cache-read row was dropped: about 2.35 billion tokens in those three days on that one host.

Measured on the server's last three days with the installed parser against this one (read-only, nothing posted):

| Token type | Before | After |
|---|---|---|
| output | 11,458,451 | 4,256,810 |
| cacheCreation | 47,296,578 | 18,574,620 |
| cacheRead | 0 | 1,006,955,204 |
| input | 22,362 | 9,928 |

Every row the new parser emits that the old parser also emitted keeps the same eventId: over those three days the only new ids are the 4,821 cache-read rows.

**The BotFleet exclusion never matched.**  `isBotFleetSessionPath` looked for `/.botfleet/workspaces/`, but Claude Code names its projects folder after the cwd with every non-alphanumeric character turned into `-`, so a BotFleet workspace appears as `-Users-jay--botfleet-workspaces-<id>`.  BotFleet-server's workspaces live under `OMB_DATA_DIR`, with no `.botfleet` in the path at all.  opencode and the MiniMax runtime collector had no BotFleet check of any kind.

**AgentTurn had no idempotency.**  A retried OTLP trace export (OpenRouter Broadcast, the agent hook shim) inserted the same turns again.

## What changed

1. **Claude transcript parser** (`scripts/lib/session-token-collectors.mjs`):
   - one row set per `message.id`, kept from the call's FIRST line so its eventId is the one already stored, and shared across the files of one pass (oldest first) so a call copied into a forked session counts once;
   - Anthropic's exclusive cache semantics.  The input row keeps the quantity the old split gave it, so it replays byte-identical, and the part the old split took away is sent as a separate `input-exclusive` row;
   - `requestId` sent as `providerRequestId` (not part of the key or the replay comparison), and the transcript's `sessionId` as `metadata["session.id"]`.
2. **Correlation metadata** (`src/lib/telemetry-correlation.ts`): `session.id`, `agent.launcher` and `agent.launcher.session` say where an event came from, not what it measured.  A replay that carries one the stored row lacks is no longer a 409; when both sides carry it, it is compared as before.
3. **BotFleet children are tagged, not silently dropped or missed.**  The Claude, Codex and opencode collectors recognise a BotFleet-launched session and stamp `agent.launcher=botfleet` and `session.id`:
   - Claude: the transcript's own `cwd` (lossless), or a projects folder named exactly `…--botfleet-workspaces-<id>`; subagent (sidechain) lines are never tagged, because BotFleet bills only its own main-thread turns;
   - Codex: `session_meta.originator=botfleet` or a BotFleet workspace cwd;
   - opencode: a session whose directory is a BotFleet workspace;
   - `BOTFLEET_WORKSPACES_DIRS` (comma-separated absolute paths) adds a BotFleet whose data dir is not `~/.botfleet`;
   - `USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1` still excludes them outright.
4. **Ingest-time BotFleet coverage** (`src/lib/botfleet-coverage.ts`), **off by default** (`BOTFLEET_CHILD_COVERAGE_DROP=1`).  When on, a tagged child row is dropped only when a stored `botfleet` turn that actually billed usage (`usageReported` true, no `usageGap`, quantity above 0) names the same child session and spans the row (two seconds of rounding margin).  It stays off because same session and same time is still not proof that BotFleet billed a given call: the Claude CLI can run a turn of its own inside a BotFleet turn, and BotFleet discards that turn's usage.  The exact fix is for BotFleet to name the calls it billed.  Until then every row is kept, and the tag lets a reader separate the two producers exactly.
5. **AgentTurn retries** (`src/lib/agent-turn-dedupe.ts`): a turn with a generation id is written once per (platform, generationId, end time), and only fresh turns fan out to Sentry.

## Rollout order

The server must be deployed BEFORE the collectors on any host are updated.  The updated collectors add `session.id` to rows the monitor already stored, and only the new replay rule accepts that.  An updated collector talking to an old server would get a whole-batch 409 and stall until the server is updated (no data is lost; its checkpoint holds).

1. Merge and deploy; verify the live revision.
2. Update the installed collectors on the server (`/mnt/fleet-extra/apps/usage-monitor-collectors`) and on the Mac, then confirm one clean pass each.
3. BotFleet's join-key change can land in either order.

## What this does not do

- Rows the old parser already stored stay stored: history before the deploy is still over-counted for Claude output and cache writes, and missing cache reads.  A backfill pass (`--days N`) adds the missing cache-read rows (new ids, no conflict).  Removing the repeated-line rows needs a reviewed cleanup of production data and is left for the owner's decision.
- MiniMax runtime rows carry no cwd, so BotFleet-driven mcode sessions cannot be recognised there yet.
- opencode cost and context rows are not tagged; only its token rows are.
- Native Claude OTLP rows from a BotFleet child are not yet recognised (BotFleet sets `agent.launcher` in the child's `OTEL_RESOURCE_ATTRIBUTES`; the OTLP mapper does not read it yet).
- `scripts/__tests__/` is excluded by `vitest.config.ts`, so its parser tests do not run in CI; `npm run test:session-token-collectors` does.
