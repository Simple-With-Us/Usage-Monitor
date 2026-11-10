# 2026-08-31 — CI verify-job drift #4: `test:r2-archive`, and the main-guard bug that hid it

## Context & Objective

`package.json`'s `verify` script chains fifteen gates.  After #1381 the `verify`
job in `.github/workflows/ci.yml` ran fourteen.  The last one missing was
`test:r2-archive` (`scripts/test-r2-weekly-archive.mjs`) — the fourth instance of
the drift class #1381 fixed for `test:session-token-collectors`,
`test:cf-token-map`, and `test:replica-status-probe`, and explicitly flagged there
as out of scope for a follow-up.  This is that follow-up.

The script is the only automated coverage of the weekly R2 disaster-recovery
archive: the SigV4 signer, the retention/prune allowlist, the
verify-before-delete ordering contract, and the failure classifier that keeps
remote error text out of a file `/api/health` parses.  A regression in any of
those merged green.

## Changes Made

Two files:

- **`scripts/ops/r2-weekly-archive.mjs`** — replaced the CLI entrypoint guard.
  Was `process.argv[1].endsWith("r2-weekly-archive.mjs")`; now
  `Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href`,
  plus a `node:url` import and a comment recording why.  This was a prerequisite,
  not a drive-by — see below.
- **`.github/workflows/ci.yml`** — one new `Test R2 weekly archive` step in the
  `verify` job, after `Test pre-migration SQLite backup`, with a block comment
  recording the drift class, the offline evidence, and the guard bug.

No product code, no `package.json` change.

## Decisions & Trade-offs

### The step could not simply be added — the script exited 1 with every test passing

Reading the script end-to-end, as the task required, turned up the reason this
one was left behind.  On a clean `origin/main`:

```
  ok  dry run uploads nothing

18 passed, 0 failed
EXIT=1
```

`scripts/ops/r2-weekly-archive.mjs:390` detected its own CLI entrypoint with a
**bare filename suffix match**:

```js
const isMain = process.argv[1] && process.argv[1].endsWith("r2-weekly-archive.mjs");
```

`"test-r2-weekly-archive.mjs".endsWith("r2-weekly-archive.mjs")` is `true`.  So
while the *test* was the entrypoint, the module it imported believed it was the
CLI.  At import time it ran a real `runArchive()` against the ambient process
environment, threw missing-credentials, and set `process.exitCode = 1`.  The
test's own footer only ever *sets* that exit code (`if (failures > 0)`), never
clears it — so 18 green assertions still produced a failing process.

This was the only bare-filename main guard in `scripts/`.  Every other script
already compares the resolved module URL:

```
scripts/check-shared-package-pin.mjs:220     import.meta.url === pathToFileURL(process.argv[1]).href
scripts/antigravity-usage-collector.mjs:553  (same)
scripts/copilot-usage-collector.mjs:105      (same)
scripts/grok-usage-collector.mjs:108         (same)
scripts/codex-usage-collector.mjs:108        (same)
```

The fix adopts that idiom.  It is one line plus an import, and it is the minimum
required to wire the CI step at all.

### This corrects the record, not just the code

`docs/rollouts/2026-08-12-pagerduty-alert-correctness.md:158` observed the exit 1
and concluded:

> `npm run verify` additionally chains `npm run test:r2-archive`, which **exits 1
> on a dev Mac** — it needs `R2_ARCHIVE_ENDPOINT` / `R2_ARCHIVE_ACCESS_KEY_ID` /
> `R2_ARCHIVE_SECRET_ACCESS_KEY` and writes to `/data/`.

That diagnosis was wrong, and it is why the drift survived three weeks: the test
looked like a legitimately credential-dependent test that could not run in CI,
rather than a broken main guard.  The test needs no credential and writes nothing
to `/data/`.  The accidentally-triggered archive run was the only thing that did.

### It was also a live-bucket hazard, not only a bad exit code

The credential check is what failed on a dev Mac.  On any host where
`R2_ARCHIVE_ENDPOINT` / `R2_ARCHIVE_ACCESS_KEY_ID` /
`R2_ARCHIVE_SECRET_ACCESS_KEY` **are** present — the production container, or an
operator shell with the Infisical environment loaded — running the test suite
would have passed that check and proceeded: snapshot the real database, PUT to
the live `usage-monitor-prod-v3` bucket, and `DELETE` superseded generations,
using the default `fetchImpl = fetch`.  Nothing about running a test file
suggests that.  The guard fix removes it.

### Offline evidence for the step itself

Read end-to-end before wiring, per the #1381 precedent:

- The whole upload → verify → prune flow runs against `makeS3Stub()`, an
  in-memory `Map` injected as `fetchImpl` — no socket is opened.
- Every credential in the file is a fake literal (`"test-key"`, `AKIDEXAMPLE`,
  the public AWS documentation example secret) passed through an explicit `env`
  object.  `resolveArchiveConfig` and `runArchive` both take `env` as a
  parameter; the test never lets either default to the process environment.
- `scripts/lib/s3-sigv4.mjs` is pure `node:crypto`, with no module-level side
  effects and no environment reads.
- The two `runArchive` calls that omit `fetchImpl` are precisely the two
  asserting it fails closed (missing credentials, kill switch); both throw on a
  config check before a request is ever built.
- Temp files go to `mkdtempSync(join(tmpdir(), ...))` and are removed in
  `finally`.
- `node:sqlite` (`DatabaseSync`, `backup`) is stable on the pinned Node 24.14.1
  in `.node-version`; `test:sqlite-backup` already relies on it in CI.

No CI-secret gating is needed.

### Placement

After `Test pre-migration SQLite backup`, which is where `npm run verify` chains
it, following the convention #1381's note set ("matching the order these scripts
appear in `npm run verify`").  It also sits with the other SQLite snapshot test.
The task suggested grouping it with the #1381 steps instead; the steps are
independent and sequential, so this is presentation only — trivially moved if the
owner prefers the other grouping.

### The step is now the guard fix's own regression test

If the entrypoint guard ever regresses, the imported module resumes setting
`process.exitCode = 1` and this CI step goes red.  No extra assertion was added
for that; the exit code already carries it.

## Verification State

Isolated worktree `~/apps/usage-claude-r2-ci` off `origin/main` (`00384203`),
Node 24.20.0 (`.node-version` pins 24.14.1; CI uses the pin).

Offline proof, the #1381 format — stripped environment, throwaway `HOME`, no
network, no ambient credential:

```
env -i HOME=$(mktemp -d) TMPDIR=$HOME PATH=/usr/bin:/bin CI=true \
  node scripts/test-r2-weekly-archive.mjs
# before: 18 passed, 0 failed  ->  EXIT=1   (+ "[r2-weekly-archive] FAILED: missing R2 archive credentials")
# after:  18 passed, 0 failed  ->  EXIT=0   (no archive run at all)
```

The CLI entrypoint still fires after the guard change — checked both the way the
Coolify scheduled task invokes it (relative path from the repo root) and by
absolute path:

```
node scripts/ops/r2-weekly-archive.mjs --dry-run          # -> enters main, reports missing credentials
node "$PWD/scripts/ops/r2-weekly-archive.mjs" --dry-run   # with fake creds -> "DRY RUN - would upload ..."
```

Full gate:

```
npm ci
npm run verify
```

`verify` now runs *through* `test:r2-archive` for the first time — previously the
chain died there.  Reached, in order: `lint`, `typecheck`, `test`
(199 files, 2338 passed | 1 skipped), `test:receipt-inbox-worker` (8 passed),
`test:migrate-safe`, `test:sqlite-backup`, **`test:r2-archive` (18 passed,
0 failed)**, `test:startup-config`, `test:oracle-deploy`, then
`test:apple-projects`.

`test:apple-projects` fails **on this Mac only** and is unrelated to this change:
`xcodebuild` reports `iOS 26.5 is not installed` for the simulator destination.
Per AGENTS.md, agents do not run or debug `xcodebuild` locally — that gate runs on
hosted `macos-latest`.  Because it short-circuits the `&&` chain, the remaining
gates were run individually, all exit 0:

```
npm run test:antigravity-collector     # antigravity collector parsing checks passed
npm run test:session-token-collectors  # ok session-token-collectors
npm run test:cf-token-map              # ok  cf-token-map offline checks
npm run test:replica-status-probe      # ok  replica-status-probe offline checks
npm run build                          # exit 0
```

Workflow YAML parsed and the step order asserted:

```
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Drift audit — every gate in `npm run verify` cross-checked against the `verify`
job's `run:` lines:

```
15 gates in verify; missing from CI: none
```

CI proof on the PR: the hosted `ubuntu-latest` `verify` job carries no R2
credentials, so a green `Test R2 weekly archive` step there is the real
confirmation of the offline claim.

## Next Steps & Blockers

- No blockers.  The workflow change is additive; the script change is a one-line
  entrypoint guard with no effect on the scheduled production run.
- **The drift class is now closed.**  All fifteen `npm run verify` gates have a
  matching CI step, verified programmatically rather than by eye.  Any *new*
  `test:*` added to the `verify` chain still needs its `ci.yml` step in the same
  PR, or it silently gates nothing.
- Worth a separate look: `scripts/test-r2-weekly-archive.mjs` sets
  `process.exitCode = 1` on failure but never resets it to 0, which is what let an
  unrelated import set the process's fate.  Harmless now that nothing else writes
  it, and left alone here to keep this PR to the guard fix.
