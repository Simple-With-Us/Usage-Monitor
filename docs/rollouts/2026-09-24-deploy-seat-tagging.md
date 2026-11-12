# 2026-09-24 — Deploy seat + PR tagging (Claude, `claude/deploy-seat-tagging`)

## Context

Item 4 of a 4-part Sentry agent-telemetry plan.  The prior three items (THE
BOARD session linkage, UM cost-by-session view, weekly fleet-mode digest) are
separate work by sibling sessions and are not touched here.  This item's ask:
where a fleet app already sends a Sentry release *deploy* record in CI, add
which seat's branch produced it and the PR number, so a Sentry deploy is
traceable back to the agent and PR that shipped it — without inventing a
metadata field Sentry does not actually support.

## What changed (Usage-Monitor only)

`.github/workflows/sentry-deploy.yml` — the existing `record-production-deploy`
job (`workflow_run` after `CI` succeeds on a push to `main`, soft-fail,
`npx @sentry/cli releases deploys "$VERSION" new -e production`) gets two
additions:

1. **A new first step, "Derive deploying seat and PR number."**  The workflow
   triggers on `workflow_run`, so `github.event.workflow_run.head_branch` is
   already `main` by the time this runs — the branch that produced the merge
   has to be recovered from the GitHub API.  It calls
   `gh api repos/<owner>/<repo>/commits/<sha>/pulls` (the "list pull requests
   associated with a commit" endpoint) using the default `GITHUB_TOKEN`, reads
   the first result's PR number and `head.ref`, and derives the seat as the
   branch prefix up to the first `/` (fleet convention: branch prefixes are
   lowercase `<seat>/<slug>`, e.g. `claude/deploy-seat-tagging` — this is
   deliberately NOT the ALL-CAPS Slack/board tag casing, since the value comes
   straight off the branch name with no transformation).  Two graceful no-op
   paths, both of which just skip the tag rather than fail the build: no PR
   found at all (a direct push to `main` with no PR), or a PR found whose
   `head.ref` has no `/` (seat recorded as `unknown`, PR number still tagged).
   Needs `permissions: pull-requests: read` added alongside the existing
   `contents: read` — nothing else changed in `permissions:`.
2. **The existing deploy step now passes `-n "seat:<seat> pr:#<number>"`** to
   `sentry-cli releases deploys ... new` when a PR was found, omitted
   entirely otherwise.

### Why `--name`, not a custom tag or the release version

Before writing any code, `npx @sentry/cli@2.58.6 releases deploys new --help`
was run directly (Usage-Monitor already pins this exact legacy `@sentry/cli`
version) to see what the deploy-creation subcommand actually accepts, rather
than guessing from memory or the newer `sentry` CLI's docs (this repo does not
use that newer CLI). Its flags are: `-e/--env` (required), `-n/--name`,
`-u/--url`, `-r/--release`, `--started`/`--finished`/`--time`. There is no
generic custom-metadata or tag flag — this matches the Sentry deploys API,
whose deploy object has exactly `environment`, `name`, `url`, `dateStarted`,
`dateFinished`. So the only place free-text metadata can go is `--name`
("optional human readable name for this deployment") — chosen over:

- **Baking it into the release name/version.**  `VERSION` here is not an
  invented string — it must exactly match the release version the Next.js
  `@sentry/nextjs` webpack plugin already created at build time (the full git
  SHA, which equals Coolify's `SOURCE_COMMIT`). Changing that format would
  break the match between this workflow's deploy record and the
  already-created release, and would need a matching change in the Next.js
  Sentry webpack config, which is out of scope here.
- **`set-commits`.**  That associates the release with a git commit range,
  not the PR/seat that produced it — different piece of data.
- **A raw HTTP call to the deploys API for undocumented extra fields.**  The
  documented deploy schema is the four fields above; nothing else is
  guaranteed to persist, so this would risk silently dropping data on a
  future Sentry API version.

`--name` is the one field the API guarantees will store and surface arbitrary
text, so `seat:<seat> pr:#<number>` goes there.

## Portable recipe (for BotFleet / Socratic.Trade / Congress.Trade)

All three already have their own `.github/workflows/sentry-deploy.yml` with
the identical shape (confirmed by reading `origin/main` of each, read-only,
2026-09-24): `record-production-deploy` job, `workflow_run` trigger after
`CI` on `main`, `VERSION = github.event.workflow_run.head_sha` (raw SHA, no
prefix), `sentry-cli releases deploys "$VERSION" new -e production`,
soft-fail. None call `releases new` or use `getsentry/action-release`; the
release itself is created by each app's own build-time mechanism (Next.js
bundler plugin for Socratic.Trade, matching Usage-Monitor; the Deno SDK for
Congress.Trade; BotFleet's release-creation source was less clearly commented
but the deploy step never calls `releases new` there either).

To apply the same pattern in one of those repos:

1. Confirm the app still pins the **legacy** `@sentry/cli` npm package (not
   the newer unified `sentry` CLI) — run `<that app's pinned invocation>
   releases deploys new --help` in that repo to re-verify flags, since CLI
   versions differ across repos and flags can change between versions. Do not
   assume this doc's flag list still applies without checking.
2. Add a step before the existing deploy step that looks up the PR via
   `gh api repos/<owner>/<repo>/commits/<sha>/pulls` (default `GITHUB_TOKEN`,
   needs `permissions: pull-requests: read` added to the workflow), derives
   `seat` as the branch prefix before the first `/`, and writes `pr_number`
   and `seat` as step outputs — both empty when no PR is found (skip
   gracefully, never fail the build).
3. Pass `-n "seat:${SEAT} pr:#${PR_NUMBER}"` to that app's existing
   `releases deploys ... new` invocation, only when a PR was found.
4. Keep it additive: do not restructure the existing release/deploy flow,
   don't touch `VERSION`/release-naming, and keep the soft-fail behavior
   (a lookup or sentry-cli failure warns, never fails CI).

Each app's own agent should still confirm its exact `sentry-deploy.yml`
contents and pinned `@sentry/cli` version at implementation time rather than
trusting this doc's Usage-Monitor line numbers — this doc describes the
pattern and the decision, not a literal patch to paste.

## Verification performed

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sentry-deploy.yml'))"` — parses clean.
- `actionlint .github/workflows/sentry-deploy.yml` — one shellcheck style
  note (SC2181, `if [ $? -eq 0 ]`) that is **pre-existing** in the original
  file (unrelated to this change, not introduced by it); no new findings.
- `npx --yes @sentry/cli@2.58.6 releases deploys new --help` run directly to
  confirm the `-n`/`--name` flag before relying on it.
- No `.ts`/`.mjs` files touched, so `npm run lint` / `tsc --noEmit` were not
  required for this change (workflow YAML only).

## Not done here

- **The actual deploy-tagging behavior in a real CI run is unverified.**  A
  GitHub Actions workflow cannot be dry-run locally; this can only be
  confirmed once this PR merges and a subsequent `workflow_run` fires for
  real, producing a Sentry deploy record with the `seat:... pr:#...` name
  visible in the Sentry UI. Check the next production deploy after merge.
- BotFleet, Socratic.Trade, and Congress.Trade were **not** edited — board
  rows were filed instead, per this task's explicit scope (see the umbrella
  board row `52452cb2e406492a8b240977acdeef23` for links).
- No new secrets were added; `GITHUB_TOKEN` is Actions-native and
  `SENTRY_AUTH_TOKEN` already existed on this workflow.
