# 2026-08-31 — Three collectors had a main guard that silently no-ops on paths with spaces

## Context & Objective

#1383 fixed a main guard in `scripts/ops/r2-weekly-archive.mjs` and stated it was
"the only bare-filename main guard in `scripts/`."  That is true as written, but
it is a narrow claim, and my own offline reasoning in #1381 had leaned on
`scripts/fleet-usage-collector.mjs`'s guard being sound.  So rather than take it
on faith I audited every entrypoint guard in the repo.

There are four idioms in use.  Seven scripts use the correct one.  Three do not:

| Script | Guard |
|---|---|
| `scripts/claude-usage-collector.mjs` | `import.meta.url.endsWith(process.argv[1])` |
| `scripts/fleet-usage-collector.mjs` | `import.meta.url.endsWith(process.argv[1])` |
| `scripts/antigravity-session-collector.mjs` | `import.meta.url.endsWith(process.argv[1])` |

## The defect

`import.meta.url` is a URL and **percent-encodes** the path.  `process.argv[1]`
is a plain filesystem path and does not.  So the moment the checkout lives at a
path containing a space (or `#`, `?`, `%`), the two stop sharing a suffix and the
guard is `false`.

This is not a theoretical path shape for this fleet — the Socratic.Trade
integration worktree is `~/Code/Agentic Trading`.

Demonstrated with an isolated probe:

```
argv[1]        : /tmp/.../guard demo/probe.mjs
import.meta.url: file:///tmp/.../guard%20demo/probe.mjs
endsWith guard : false   <-- CLI body SKIPPED
pathToFileURL  : true
```

**The failure mode is the dangerous part: it is completely silent.**  The CLI
body is skipped, nothing is collected, and the process exits **0**.  End-to-end,
running the real collector from a spaced-path copy of `scripts/` with a throwaway
`HOME`:

```
===== BEFORE FIX, spaced path =====
(no output at all)
exit=0 , lines of output: 0

===== AFTER FIX, same spaced path =====
[fleet-usage-collector] Starting fleet collection pass (since ...)
[fleet-usage-collector] Quota events collected: 0
...
exit=0
```

A LaunchAgent would report success forever while telemetry quietly stopped
arriving — in the app whose entire purpose is not missing usage telemetry.
`scripts/com.jays.fleet-usage-collector.plist.example` exists precisely to
schedule `fleet-usage-collector.mjs`, so this is on the path to being a cron job.

**Current blast radius is latent, not firing.**  The four collectors registered
in `launchctl` today (`antigravity`, `copilot`, `codex`, `grok`) all already use
the correct idiom, and `/Users/jay/Code/Usage-Monitor` has no space.  These three
are reachable via `npm run fleet:collect` / `claude:collect` /
`antigravity-session:collect` and via that plist template.

Note this is a *different* failure direction from #1383's.  There, a too-loose
guard fired when it should not have, and running the test against a credentialed
host would have pruned the live R2 bucket.  Here, a too-strict guard fails to
fire when it should.  Same root cause: comparing path *fragments* instead of
resolved URLs.

## Changes Made

- `scripts/claude-usage-collector.mjs`, `scripts/fleet-usage-collector.mjs`,
  `scripts/antigravity-session-collector.mjs` — switched to
  `import.meta.url === pathToFileURL(process.argv[1]).href`, the idiom the other
  seven scripts already use, with a comment recording why the suffix form is
  wrong.  Added the `pathToFileURL` import to each.
- `scripts/test-session-token-collectors.mjs` — added a repo-wide main-guard
  audit that walks `scripts/**/*.mjs` and fails on either bad idiom
  (`import.meta.url.endsWith(...)` or `process.argv[1].endsWith(...)`), skipping
  comment lines and its own file, since both the fixes and the audit quote the
  bad patterns.  This test is already a CI gate as of #1381, so the guard costs
  no new CI time.

## Decisions & Trade-offs

- **Put the audit in the collectors' test rather than a new script.**  It needs
  no new `verify` entry or `ci.yml` step (which is the very drift class #1381
  and #1383 just closed), and main-guard correctness is genuinely a collector
  property — it decides whether the collector runs at all.
- **Left the two `new URL(process.argv[1], "file:")` guards alone**
  (`import-private-billing-receipts.mjs`, `import-manual-subscription-events.mjs`).
  Non-idiomatic, but verified correct: `new URL()` percent-encodes the same way
  `import.meta.url` does, so it returns `true` on a spaced path.  Tested.  Not
  worth churn.
- **Did not add `process.argv[1]` presence checks** to the three collectors that
  omit them (`copilot`, `codex`, `grok` call `pathToFileURL(process.argv[1])`
  unguarded, which throws if `argv[1]` is undefined).  That only happens under
  `node --eval`/REPL import, which is not how these run.  Out of scope; noted
  here so it is on the record.

## Verification State

```
node --check scripts/{claude-usage-collector,fleet-usage-collector,antigravity-session-collector}.mjs   # all ok
npm run test:session-token-collectors                                                                   # ok
npm run lint
```

Negative test — the audit is proven to catch a reintroduction, not just to pass:

```
# temporarily revert fleet-usage-collector's guard
npm run test:session-token-collectors
FAIL fragile main guard(s) -- use import.meta.url === pathToFileURL(process.argv[1]).href:
  .../scripts/fleet-usage-collector.mjs:280 import.meta.url.endsWith(...)
```

Still offline, re-confirmed under a stripped env with a throwaway `HOME`:

```
env -i PATH=... HOME=$(mktemp -d) CI=true node scripts/test-session-token-collectors.mjs   # exit=0
```

The import-safety property #1381 relies on is unchanged and still asserted by
this same test: importing `fleet-usage-collector.mjs` must not execute the CLI.

## Next Steps & Blockers

- None.  No behavioral change on any path without a percent-encoding character,
  which includes every host in the fleet today.
- If `com.jays.fleet-usage-collector.plist.example` is ever installed, this fix is
  what keeps it from silently collecting nothing on a spaced checkout.
