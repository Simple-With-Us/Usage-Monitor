# `agent-hook-otlp.mjs` — land-stage hardening (2026-09-25)

Follow-up to PR #1535 (shared hook-to-OTLP shim), #1540 (Sentry-only endpoint allowlist),
and #1542 (Antigravity `Stop` no-op reply). All three had already merged when a land-stage
adversarial review found real gaps that survived them. This PR fixes the P2/P3 findings
from that review. See `docs/observability/agent-hook-otlp.md` for the operational detail
this doc only summarizes.

## What was wrong

1. **(P2, #1535) Foreground network POST inside the host's hook budget.** Every hook
   invocation `await`ed `postOtlp()` directly, bounded to a 2s `HTTP_TIMEOUT_MS`, inside a
   3s host hook timeout (agy/Cursor/Copilot CLI all set `timeout: 3`). On this Mac, under
   heavy concurrent-agent load, a cold `node` start alone was observed taking 2.0-3.85s —
   agy's own CLI logs showed 44 hook kills across two bursts on 2026-09-24. Each kill both
   dropped the telemetry record and stalled the host's hook wait for the full timeout.

2. **(P2, #1535) Hooks wired at a path inside the human integration tree.**
   `~/Code/Usage-Monitor` is reset by a daemon and can be checked out on any branch at any
   time — it was on an unrelated branch when this was caught. A hook wired directly there
   would silently break (`MODULE_NOT_FOUND`) or transiently reintroduce an already-fixed
   bug depending on what happened to be checked out.

3. **(P2, item-level) Codex's `trace_exporter` put a `cwd` (workspace path) span
   attribute on every span sent to Sentry**, confirmed live via a `seat:codex has:cwd`
   Sentry search, and added roughly 50k low-value internal spans/week. Codex has no
   per-attribute redaction knob.

4. **(P3) agy's `PostToolUse` wiring was dead** — confirmed via `agy -p "/hooks"
   --output-format json` that the installed CLI build never lists it as a registered hook,
   with or without an added `"matcher"` key. A separate edit on 2026-09-24 had also
   silently dropped `moshi-hook`'s own `Stop` entry from the same file.

5. **(P2, #1540) The PR's test-suite change deleted the only real end-to-end privacy
   regression guard**, replacing a subprocess test that inspected the actual wire body
   with mock-based tests asserting only that `session.id` is present. Mutation-testing
   confirmed the suite would not have caught routing raw prompt/tool-arg content into an
   allowlisted field.

6. **(P3, #1540) A test pointed at a real `*.sentry.io` host**, so CI made a real
   (fake-credentialed, but real) outbound POST to production Sentry infrastructure.

7. **(P3) Doc/comment drift**: the script header pointed at a `docs/observability/` note
   that did not exist; `MAC-LOCAL-PROCESSES.md` said "Always-on" for an on-demand script
   and understated the hook-kill frequency as "observed once."

## What changed

- `scheduleBackgroundSend()`: the foreground hook process now only builds the OTLP log
  record and hands `{credentials, body}` to a **detached** `node <script> --send` child
  (own stdio pipe for input, `unref()`ed), then returns immediately. The grandchild's
  `--send` mode (a new branch in `main()`) reads that payload off its own stdin and
  performs the real `postOtlp()` call, fully decoupled from the parent's lifetime.
  Proven with a real (non-mocked) child process in
  `scripts/__tests__/agent-hook-otlp.test.mjs`.
- `scripts/install-agent-hook-otlp.mjs`: installs a pinned copy at
  `~/.local/share/agent-hook-otlp/agent-hook-otlp.mjs` by reading the file's content
  straight out of `origin/main` via `git show` (never off the working tree). Idempotent;
  re-run after any merge that touches `scripts/agent-hook-otlp.mjs`.
- Local-machine only (not in this diff, done directly on the Mac as part of this land
  stage): `~/.codex/config.toml`'s `trace_exporter` line commented out (original preserved
  in a timestamped backup); `~/.gemini/config/hooks.json`'s dead `PostToolUse` entry
  removed and `moshi-hook`'s `Stop` entry restored; all three hooks.json repointed at the
  pinned install path; `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` row corrected.
- Test suite: added a real-subprocess timing proof for the detached-send fix, a
  dependency-injected privacy-regression suite covering every (platform, event) pair
  wired in the three live hooks.json configs with sentinel-stuffed adversarial payloads
  (asserts no sentinel string and only allowlisted attribute keys in the built body), and
  restored a meaningful `buildLogRecord` "ignores anything beyond the known five fields"
  test (the old one asserted on values that could never fail). Fixed the CI-hits-real-Sentry
  symlink test to use a fake, never-`sentry.io` host instead.
- New `docs/observability/agent-hook-otlp.md` for the detached-send and pinned-path
  rationale, plus the wiring reference table (referenced by the script header, which
  previously pointed at a doc that did not exist).

## Verification

- `npx vitest run` (full suite): 2765 passed, 1 skipped, 11 todo, 0 failed.
- `npx eslint` on all touched files: clean.
- `npx tsc --noEmit`: only the two pre-existing, unrelated errors already documented in
  prior rollout notes (a stray `~/node_modules` on this Mac); nothing new.
- Local machine (not CI-verifiable): `agy -p "/hooks" --output-format json` confirms
  `moshi-hook`'s `Stop` is registered again and `agent-hook-otlp`'s `PostToolUse` is gone;
  `~/.codex/config.toml` parses as valid TOML with `trace_exporter` absent and `exporter`
  (logs) intact.
