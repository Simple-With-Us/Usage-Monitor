# 2026-08-31 — CI verify-job drift: wire the last three offline `test:*` scripts

## Context & Objective

`package.json`'s `verify` script runs fourteen gates.  The `verify` job in
`.github/workflows/ci.yml` ran eleven of them.  Three were in `npm run verify`
but had no CI step at all:

- `test:session-token-collectors` (`scripts/test-session-token-collectors.mjs`)
- `test:cf-token-map` (`scripts/test-cf-token-map.sh`)
- `test:replica-status-probe` (`scripts/test-replica-status-probe.sh`)

That is the same drift class this workflow file's own comment (above the
`Test receipt-inbox worker` step) describes fixing once already: "It was in
`npm run verify` but missing from CI."  Concretely, a regression in
`scripts/replica-status-heartbeat.sh`, `deploy/coolify/replica-status-probe.sh`,
`scripts/cf-token-map.sh`, or the session-token-collector parsers merged green.
The blast radius is not hypothetical — the replica probe test exists precisely
because a `nonlocal`-with-no-enclosing-function bug in the probe's embedded
Python heredoc is a `SyntaxError` at exec time that `bash -n` and every textual
grep miss, and the cf-token-map test asserts value-blind properties of a script
that handles a Cloudflare API token.

## Changes Made

One file, additive only:

- `.github/workflows/ci.yml` — three new steps in the `verify` job, placed
  immediately after `Test Antigravity collector parsing` and before
  `Audit high-severity dependencies`, matching the order these scripts appear in
  `npm run verify`.  A block comment above them records the drift class and the
  offline/secret-free evidence for each (below), so the next reader does not have
  to re-derive it.

No script, package.json, or product code changed.

## Decisions & Trade-offs

**Each script was read end-to-end before wiring, per the "verify it is genuinely
network/secret-free" requirement.  None needed CI-secret gating.**

- **`test:session-token-collectors`** — pure parser fixtures over inline JSONL
  string literals.  It imports `scripts/fleet-usage-collector.mjs`, which does
  contain a network POST and `execFileSync`, but both are inside functions behind
  the `import.meta.url` / `process.argv[1]` main guard at the bottom of that file;
  importing it only binds `fleetIngestJobs`.  Its module-level `INGEST_URL` reads
  an env var with a literal default and never dereferences it at import.  The
  Codex `~/.codex` archive-key assertions are `join()` string math — no path is
  ever stat'd or read.  `scripts/lib/run-session-token-collector.mjs` has no
  module-level side effects at all.  The one external dependency is the pinned
  `@jaywedgeworth22/congress-trading-shared` v2 schema installed by `npm ci`,
  which is the point of running it in CI: it catches a wire-schema break at the
  collector boundary.
- **`test:cf-token-map`** — `bash -n` plus greps over `scripts/cf-token-map.sh`.
  It asserts that script's value-blind properties (never echoes `$VAL`, no client
  secret on argv, auth header written only to a `0600` temp file).  It never
  *invokes* `cf-token-map.sh`, so no Infisical login and no Cloudflare call ever
  happens.  This is the case the task flagged as needing checking; the underlying
  `cf-token-map.sh` does need live credentials, but the `test:` wrapper
  deliberately does not, so no secret gating is required.
- **`test:replica-status-probe`** — `bash -n` + greps over
  `scripts/replica-status-heartbeat.sh` and
  `deploy/coolify/replica-status-probe.sh`, a `python3` block that extracts the
  probe's level-escalation source and `exec`s it against a mocked
  `subprocess.run`, and the heartbeat's own `--self-test`, which points
  `LITESTREAM_BIN` at a mock shell script in a `mktemp -d`.  No B2 or Litestream
  credential is read; the `LITESTREAM_S3_*` normalization at the top of the
  heartbeat uses `:=` defaults and tolerates all-empty.

**Runner-image dependencies:** the replica-probe test needs `python3` and `jq`.
Both are preinstalled on `ubuntu-latest`.  The heartbeat self-test degrades
gracefully rather than failing if `jq` ever disappears (it logs
`self-test skipped: jq required` and returns 0), so a future runner-image change
weakens the check instead of breaking the build.  `python3` is a hard
requirement; if the image ever drops it, that step fails loudly, which is the
correct direction.

**Placement:** appended to the existing `verify` job rather than split into a new
job.  These are seconds-long checks and the job already carries eleven siblings;
a separate job would pay a second `npm ci` for `test:session-token-collectors`
and would need adding to the required-check ruleset to actually gate anything.

**Left out of scope (flagged, not fixed):** `test:r2-archive` is *also* in
`npm run verify` with no CI step — a fourth instance of exactly this drift.  It
was not in this task's scope and is not touched here.  It should get the same
treatment in a follow-up.

## Verification State

Local, in the isolated worktree `~/apps/usage-claude-ci-drift` off `origin/main`
(`26103611`), Node 24.14.1:

```
npm ci
npm run test:session-token-collectors   # ok session-token-collectors
npm run test:cf-token-map               # ok  cf-token-map offline checks
npm run test:replica-status-probe       # probe escalation self-test: PASS
                                        # [replica-status-heartbeat] self-test ok: snapshot_only
                                        # ok  replica-status-probe offline checks
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

To demonstrate the offline claim rather than only asserting it, all three were
then re-run under a stripped environment with a throwaway `HOME`, which removes
every ambient credential and every real `~/.codex` / `~/.claude` / `~/.secrets`
path:

```
env -i PATH=... HOME=$(mktemp -d) CI=true bash -c '...'
# all three: exit=0
```

CI proof on the PR: the GitHub-hosted `ubuntu-latest` `verify` job is itself a
secret-free environment for these steps (the job declares only `CI: true`), so a
green run there is the real confirmation.  See the PR's `verify` check.

## Next Steps & Blockers

- No blockers.  Additive workflow change; no runtime, deploy, or product impact.
- Follow-up: wire `test:r2-archive` into the same `verify` job (same drift class,
  deliberately out of this task's scope).
- Standing lesson: any new `test:*` added to `package.json`'s `verify` chain needs
  a matching `ci.yml` step in the same PR, or it silently gates nothing.
