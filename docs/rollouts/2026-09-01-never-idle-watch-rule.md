# 2026-09-01 — Land + extend the "never idle-watch a PR" rule

## Context & Objective

Owner ruling, 2026-09-01: agents "should never just wait and watch for things to merge
since that wastes tokens/time and they inevitably almost invariably end up slowly wasting
money/quota while the PR sits there with conflicts or comments/issues unresolved."

Two things happened here, and the second is the interesting one.

**The rule was already written for this repo — and was never committed.**  A peer seat
added a `## Never wait and watch for PRs to merge / Idle-polling forbidden` section to
`AGENTS.md` earlier on 2026-09-01, but left it as an **uncommitted working-tree edit in the
owner's integration tree** (`/Users/jay/Code/Usage-Monitor`, ` M AGENTS.md`, 12 insertions
against `origin/main`).  Nothing was on `main`, so no other seat could see it: a fresh
clone, a cloud session, or any agent worktree read an `AGENTS.md` with no such rule.  That
is precisely the "always commit + land finished work" failure the fleet protocol names —
and it happened to the rule about not letting work sit.

## Changes Made

Docs/rules only.  No app code, no schema, no deploy.

- `AGENTS.md` — the peer's section is adopted **verbatim** (heading, framing paragraph, and
  binding rules 1–5 byte-identical) so their authorship and wording survive and no
  duplicate section appears, then extended with the parts the fleet ruling requires that it
  did not yet cover:
  - a symptom → diagnosis → action table (unresolved threads, conflict, failing check,
    never-dispatched check, auto-merge never armed);
  - **arm auto-merge once its preconditions hold** (non-draft, no hold label or
    title, fleet reviewer approval of the current HEAD; `gh pr merge <n> --squash --auto`);
  - the **bounded wait** carve-out — one five-minute-capped
    `timeout --kill-after=5s 300 gh pr checks <n> --watch` is legal, an open-ended
    `sleep` loop is not, and when a bounded wait ends unmerged you diagnose rather
    than start a second one;
  - review-bot thread triage discipline (fix real findings, reply with a specific
    technical reason on the rest, then resolve; never blind-resolve);
  - background jobs — end the turn rather than narrate "standing by";
  - a closing line naming this section itself as canonical (the fleet protocol
    manual does not repeat repo working rules).
- `docs/rollouts/2026-09-01-never-idle-watch-rule.md` — this note.

Outside this repo, the same rule in each file's own voice:

- `/Users/jay/apps/AGENT-SYNC.md` (since retired; the file is now
  `FLEET-PROTOCOL.md`) — at the time, a canonical `## Never idle-watch a PR`
  section after `## Merge requirements`.  The current protocol manual no longer
  repeats repo working rules, so the live home of this rule is each repo's
  `AGENTS.md` — including this one.
- `/Users/jay/.claude/CLAUDE.md` — stanza beside "Always commit + land finished work".
- `Socratic.Trade` and `Congress.Trade` `AGENTS.md`.

## Decisions & Trade-offs

- **Adopt verbatim rather than rewrite.**  Replacing the peer's wording with my own would
  have clobbered their text and, once they eventually commit their tree, produced either a
  conflict or two near-identical sections.  Keeping rules 1–5 byte-identical means their
  pending local diff becomes a subset of what is now on `main`.
- **Owner's integration tree left untouched.**  Fleet rules forbid working in
  `/Users/jay/Code/Usage-Monitor`; this landed from an isolated worktree on
  `claude/never-idle-watch-rule`.  The owner's tree still shows its uncommitted
  `AGENTS.md` edit; a pull there will refuse to overwrite the locally modified
  file, so the remedy is to discard the stale local edit
  (`git restore AGENTS.md`) — its content is already on `main` — and then pull.
- **Extended rather than left alone.**  The existing text banned idle-polling but did not
  say what to do instead beyond "inspect", and did not carve out the bounded wait.  A rule
  that only prohibits leaves an agent with no legal way to wait when it genuinely must;
  naming the one allowed form prevents the ban from being quietly ignored.
- Not machine-enforceable — no lint or CI gate detects idle polling.  Behavioral rule, same
  class as "always commit + land finished work".

## Verification State

Docs-only change.  Repo gate:

```bash
npm run verify   # eslint, tsc, vitest, migration/backup/startup checks, build
```

No `verify`-chain script was added, so the `AGENTS.md` rule about every `verify` gate
needing a matching `.github/workflows/ci.yml` step does not apply to this change.

## Next Steps & Blockers

None.  Sibling changes land on their own paths: two live files edited in place, three repo
PRs, plus the ai-fleet-coordinator mirror.

Worth flagging for whoever holds the owner's integration tree: `git status` there will
still show ` M AGENTS.md` until the stale local edit is discarded
(`git restore AGENTS.md`) — a pull alone will refuse to overwrite it, and the
content is already on `main`.
