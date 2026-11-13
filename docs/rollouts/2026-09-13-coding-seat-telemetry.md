# Coding-seat telemetry

Usage Monitor now treats coding-seat telemetry as a source-specific contract.  Exact provider counters stay exact, API-equivalent estimates stay separate from cash billing, and unavailable dimensions remain unknown rather than zero.

## Local runtime

Scheduled collectors run from `~/apps/usage-monitor-collector-runtime/current/scripts`.  `current` is an atomic symlink to a detached, exact commit under `releases/<sha>`; it never points at a seat feature branch or the read-only integration checkout.

The updater copies the invoking checkout's installed `zod` package into each
release and verifies the collector imports before forward activation.  Install
the checkout's dependencies before updating; a missing dependency stops activation.
Before replacing a pre-injector release, the updater copies missing launcher,
verifier, and Muse collector entrypoints from the validated new release into the
previous release as an untracked runtime compatibility overlay.  It validates
the overlay and dependency before switching, so rollback keeps the configured
launcher available while the release Git HEAD remains its original commit.
Forward activation still requires those entrypoints to exist in the target commit.

Install or update after the commit is merged to `origin/main`:

```bash
/opt/homebrew/opt/node@24/bin/node scripts/update-local-collector-runtime.mjs --sha <full-origin-main-sha>
```

The updater verifies that the requested SHA is reachable from current `origin/main`, checks every collector entrypoint with Node 24, preserves the prior release, atomically replaces `current`, and records only SHAs and timestamps in `runtime-state.json`.  Roll back with:

```bash
/opt/homebrew/opt/node@24/bin/node ~/apps/usage-monitor-collector-runtime/current/scripts/update-local-collector-runtime.mjs --rollback
```

The updater is on-demand.  The LaunchAgents are scheduled jobs: Codex, Grok, Copilot, DSH, and Antigravity session usage every 15 minutes; MiniMax quota and Antigravity quota every four hours.  Existing plist intervals, environment, and credential resolution are preserved when their script path is moved to the stable runtime.

## Activation order

1. Merge and pass the exact-head hosted gate.
2. Install the merged SHA into the detached runtime and point collector plists at `current/scripts`.
3. Configure Antigravity's official status-line command while preserving unrelated settings.
4. Update `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` and refresh the pinned `⭐️ Background Jobs Master List` note in the same operational change.
5. Kick each job and record only acknowledgement aggregates.  Never record credentials, prompts, transcripts, workspace paths, or tool content.
6. Keep BotFleet-child exclusion off until the durable BotFleet outbox is deployed and its exact receiver acknowledgement is verified.  After that proof, enable the exclusion in Codex and DSH collectors and kick both again.

Overflow or destination-change drops in BotFleet remain explicit coverage gaps.  Cursor and Kimi currently expose no exact local token ledger, Antigravity cannot attribute missed cumulative deltas to a model or cache split, and MiniMax exposes exact quota percentages but no token counts.  These surfaces remain unavailable or incomplete in the dashboard.
