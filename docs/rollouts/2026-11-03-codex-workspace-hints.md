# Codex BotFleet Workspace Hints

The Codex collector may emit `metadata["workspace.botfleetHint"] = "configured-root"` when the transcript's first valid `session_meta` identifies a session and gives an absolute cwd beneath an explicitly configured `BOTFLEET_WORKSPACES_DIRS` root.

This is a non-authoritative workspace match.  It does not establish that BotFleet launched the session, owns every process beneath the directory, or billed any of the session's calls.  BotFleet creates ordinary account-owned directories and sends Codex a client name and launch environment; the collected cwd has no authenticated binding to those launch markers.

Configured-root membership never sets `agent.launcher`, expands the existing exclusion switch, or authorizes receiver suppression.  The coverage matcher does not consume the workspace hint.  The collector keeps every event ID, measurement and session identity, and sends neither the cwd nor the configured root.

A newly added or absent hint is compatible with an idempotent replay.  If both versions carry different hint values, they still collide, as do changed measurements.  Existing persisted rows are not rewritten or retrospectively given launch or billing authority.

Regression coverage checks sibling-root and traversal boundaries, later and missing session metadata, row preservation with the exclusion flag enabled, unchanged measurement payloads, replay compatibility, and rejection of hint-only suppression even when a signed exact BotFleet receipt exists.

Validation passed with `node scripts/test-session-token-collectors.mjs`, targeted ESLint over all six changed scripts and TypeScript files, `tsc --noEmit`, `git diff --check`, and 57 tests across `botfleet-coverage.test.ts`, `external-usage-events-replay-correlation.test.ts` and `claude-code-mapper.test.ts`.

The publication check compared current main `61919ad` with held PR #1879 at `ed1a951`.  Their only shared file is `scripts/lib/run-session-token-collector.mjs`; PR #1879 changes strict credential lookup near the top, while this candidate adds a session-cwd helper farther down.  The candidate is independent of injector activation and must remain a held draft pending independent review.
