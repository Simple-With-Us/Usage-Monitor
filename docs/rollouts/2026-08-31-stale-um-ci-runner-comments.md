# 2026-08-31 — Five workflows documented a runner-offload feature that does not exist

## Context & Objective

Spotted while wiring the CI verify-drift steps in #1381: `ci.yml`'s `verify` job
carries a ten-line comment describing a self-hosted-runner offload gated on a
`UM_CI_RUNNER` repo variable, complete with a fallback runbook — directly above a
`runs-on:` line whose value is a literal `ubuntu-latest`.

The comment is not merely stale.  It describes a control that **does not exist**,
and the runbook it hands the reader cannot do anything.

## What actually happened

- **#583** landed the gate dormant, as
  `${{ (github.actor != 'dependabot[bot]' && vars.UM_CI_RUNNER) || 'ubuntu-latest' }}`
  across five workflows: `ci.yml`, `security.yml`, `codeql.yml`,
  `uptime-monitor.yml`, `effort-issues-sync.yml`.
- **`bbf540a0` (#834, 2026-07-29, owner-authored, "ci: migrate to hosted
  ubuntu-latest runners")** replaced that expression with a literal
  `ubuntu-latest` in all five files — 5 files, 5 insertions, 5 deletions.  It
  changed only the `runs-on:` lines and **left every explanatory comment in
  place.**

So for over a month, five files documented a live runner-offload feature that had
been deleted.  `vars.UM_CI_RUNNER` is now read nowhere in the repo; setting it has
no effect whatsoever.

Consequences, in rough order of severity:

1. **The documented emergency runbook is inert.**
   `gh variable set UM_CI_RUNNER --repo jaywedgeworth22/Usage-Monitor --body ""`
   is presented as an "instant, global hosted fallback."  It reads nothing and
   changes nothing.  Someone reaching for it during a CI incident would believe
   they had failed over and would not have.
2. **It invites reintroducing retired infrastructure.**  The comments name the
   target label (`usage-ci`) and describe the migration as pending.
   `codeql.yml` goes furthest: *"before setting UM_CI_RUNNER, dispatch this
   workflow ... If it does not, keep codeql.yml on 'ubuntu-latest' (revert this
   line)"* — an instruction to revert a line that no longer exists, framing the
   current correct state as a temporary fallback.  `uptime-monitor.yml` calls its
   own 5-minute cron "the steady hosted-minutes drain, so moving it is the main
   saving," which reads as an open work item.  Fleet policy since the same
   2026-07-29 date is hosted-only, with self-hosted Actions runners retired.
3. **The effort board asserts the opposite of reality.**  `docs/EFFORT-LOG.md`'s
   closeout for that lane says "UM_CI_RUNNER gating on main."

## Changes Made

**Comments and docs only.  No `runs-on:` value is touched.**  Hosted-only is the
correct, owner-directed end state; the code is right and the prose was wrong.

- `.github/workflows/ci.yml` — replaced the canonical block with an accurate one
  that records what the gate was, that #834 removed it, and that the variable is
  read nowhere.  Keeping the history here (rather than deleting it silently) is
  deliberate: the next reader who finds `UM_CI_RUNNER` in the effort log or in
  #583 needs to land somewhere that explains it.
- `.github/workflows/security.yml`, `codeql.yml`, `uptime-monitor.yml`,
  `effort-issues-sync.yml` — replaced their pointer comments with a two-line note
  that the hosted runner is deliberate and points at `ci.yml`.  Dropped
  `codeql.yml`'s "revert this line" paragraph and rewrote `uptime-monitor.yml`'s
  "moving it is the main saving" so the cron cadence, not a runner swap, is named
  as the lever if that cost is ever revisited.  Kept its genuinely useful
  dependency note (readiness gate needs only curl + jq).
- `AGENTS.md` — added two durable rules to the `Verify` section, which is where a
  reader lands before touching CI: (1) every `verify` gate needs a matching
  `ci.yml` step in the same PR, with a one-liner audit command; (2) fleet CI is
  GitHub-hosted only, do not reintroduce a self-hosted label or the
  `UM_CI_RUNNER` gate, and **trust the `runs-on:` value over any comment
  describing runner routing.**  This is the durable fix; the comment edits alone
  would just drift again.
- `docs/EFFORT-LOG.md` — appended a dated correction beneath the CURSOR closeout
  rather than editing it, per effort-log protocol (correct in place, never delete
  a peer's row).

## Decisions & Trade-offs

- **Did not restore the gate.**  Tempting to "make the code match the comment,"
  but that inverts the fix: #834 was a deliberate owner-authored migration and
  the fleet rule is hosted-only.  The comment is what is wrong.
- **Did not delete the history outright.**  A bare "runs-on: ubuntu-latest, don't
  change" would leave the next reader unable to reconcile the effort-log rows and
  #583 with the file.
- **Left `docs/EFFORT-LOG.md`'s original row text intact.**  Effort-log protocol
  is explicit that peer rows are corrected in place with a note, not rewritten.

## Verification State

```
python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"
# all workflows parse ok
grep -rn 'UM_CI_RUNNER' .github/
# only the single canonical historical explanation in ci.yml survives
```

The `${{ ... }}` sequence quoted inside the ci.yml comment is inert — GitHub
Actions does not evaluate expressions in YAML comments, and the file parses.

Drift audit from the new AGENTS.md snippet, run on this branch:

```
15 gates in npm run verify; missing from ci.yml: none
```

(#1381 wired three, #1383 wired the last one, so that class is now fully closed.)

No behavioral change: not one `runs-on:` value, step, or trigger was modified, so
CI routing is byte-identical to `main`.

## Next Steps & Blockers

- None.  Comment/doc-only.
- Related, separate branch: three collector scripts carry a fragile
  `import.meta.url.endsWith(process.argv[1])` main guard — see
  `docs/rollouts/2026-08-31-collector-main-guard-hardening.md`.
