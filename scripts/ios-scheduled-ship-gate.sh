#!/usr/bin/env bash
# ios-scheduled-ship-gate.sh - Decide whether a SCHEDULED ios-ship run ships.
#
# Why this exists
# ---------------
# .github/workflows/ios-ship.yml gained a `schedule:` trigger because a PR
# merged by github-actions[bot] lands on main under GitHub's recursion guard
# and dispatches no workflow run at all -- so `push:` alone could not be
# trusted to notice that iOS code had landed. Measured fleet-wide 2026-08-13:
# PR #1145 here (bot-merged, touches ios/) produced no ios-ship run, and
# #1159 (human-merged) produced the only ios-ship run this repo has ever had.
# On Congress.Trade the same A/B was sha c38b6787 (bot) -> 0 runs vs ceaca097
# (human) -> 5 runs.
#
# But a cron carries no `paths:` filter, and ship-testflight.sh's own gate only
# tests "is HEAD the sha I last shipped" plus a time interval. Without this
# script, a backend-only commit sitting past the rate-limit window would ship a
# TestFlight build for changes no tester can see. The owner does not want
# TestFlight spammed, so the scheduled path ships only when a path the push
# trigger would have shipped on actually changed since the last successful
# ship. The gate step passes the workflow's own on.push.paths list, one
# --path-prefix each, so a missed push event still ships on the next tick.
#
# Usage:
#   ios-scheduled-ship-gate.sh --path-prefix <pattern> [options] <key> [key...]
#   (this repo ships two apps from one tree: `usage` and `usage-local`)
#
# Options:
#   --path-prefix P   One push-trigger path that counts as shippable source.
#                     Repeatable: pass EVERY entry of the workflow's own
#                     on.push.paths list (the gate step does). A single
#                     --path-prefix 'ios/' keeps working as before.
#                     Each pattern is passed straight through to git as a
#                     pathspec, which matches push-filter glob behavior: '*'
#                     does not cross '/', '**' does, '?' and [...] work, and a
#                     leading '!' excludes (translated to git :(exclude)).
#   --event NAME      GitHub event name (default: $GITHUB_EVENT_NAME).
#                     Anything other than "schedule" votes ship=1 for every
#                     app: a push already passed the workflow's paths filter,
#                     and a manual dispatch is an explicit instruction.
#   --repo-root PATH  Repo to inspect (default: cwd)
#   --state-dir PATH  Where ship-testflight.sh records successful ships
#                     (default: $IOS_FLEET_STATE_DIR, else ~/.cache/ios-fleet)
#
# Output:
#   Human-readable reasoning on stdout, plus, when $GITHUB_OUTPUT is set:
#     should_ship=0|1        1 if ANY listed app should ship
#     ship_<app_key>=0|1     per app, with '-' in the key replaced by '_'
#
# Exit code is always 0 on a decision. Deciding "skip" is a normal outcome and
# must never turn a scheduled tick red.
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

PATH_PREFIXES=""
EVENT="${GITHUB_EVENT_NAME:-}"
REPO_ROOT=""
STATE_DIR="${IOS_FLEET_STATE_DIR:-${HOME}/.cache/ios-fleet}"
APPS=""

die() { echo "error: $*" >&2; exit 2; }
log() { echo "[ship-gate] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path-prefix)
      p="${2:-}"; shift 2
      [[ -n "$p" ]] || die "--path-prefix needs a value"
      if [[ -z "$PATH_PREFIXES" ]]; then PATH_PREFIXES="$p";
      else PATH_PREFIXES="${PATH_PREFIXES}"$'\n'"${p}"; fi ;;
    --event) EVENT="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    -*) die "unknown option: $1" ;;
    *) APPS="${APPS} $1"; shift ;;
  esac
done

[[ -n "$PATH_PREFIXES" ]] || die "--path-prefix is required (repeatable; at least one)"
[[ -n "${APPS// /}" ]] || die "at least one app key is required"

# One git pathspec per --path-prefix. Git's own glob rules ('*' stays inside
# one directory, '**' crosses, '?' and [...] work) are the push filter's rules
# as closely as a shell script can reasonably get; a leading '!' becomes a
# git :(exclude) pathspec the same way it negates in on.push.paths.
SPEC_ARGS=()
HAVE_POSITIVE=0
while IFS= read -r _pat; do
  [[ -n "$_pat" ]] || continue
  case "$_pat" in
    '!'*)
      [[ -n "${_pat#!}" ]] || die "empty '!' exclusion in --path-prefix"
      SPEC_ARGS[${#SPEC_ARGS[@]}]=":(exclude)${_pat#!}" ;;
    *)
      SPEC_ARGS[${#SPEC_ARGS[@]}]="$_pat"; HAVE_POSITIVE=1 ;;
  esac
done <<<"$PATH_PREFIXES"
if [[ "$HAVE_POSITIVE" -eq 0 ]]; then
  # Push filters with only exclusions still match everything else; git needs
  # one positive pathspec, so scope to the whole tree.
  SPEC_ARGS[${#SPEC_ARGS[@]}]="."
fi
PREFIX_DISPLAY="$(printf '%s' "$PATH_PREFIXES" | tr '\n' ' ')"

if [[ -z "$REPO_ROOT" ]]; then REPO_ROOT="$(pwd)"; fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)" || die "bad --repo-root"

emit() {
  # emit <key> <value>
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

out_key() {
  # App keys carry '-' (usage-local); GitHub step outputs read better with '_'.
  printf 'ship_%s' "$(printf '%s' "$1" | tr '-' '_')"
}

if [[ "$EVENT" != "schedule" ]]; then
  log "event='${EVENT}': not the scheduled backstop, so intent is already explicit."
  for app in $APPS; do emit "$(out_key "$app")" 1; done
  emit should_ship 1
  exit 0
fi

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$HEAD_SHA" ]]; then
  # No git, no ability to reason about what changed. Do NOT ship on a guess.
  log "cannot resolve HEAD in ${REPO_ROOT}; scheduled tick skips."
  for app in $APPS; do emit "$(out_key "$app")" 0; done
  emit should_ship 0
  exit 0
fi

log "watching ship paths: ${PREFIX_DISPLAY}"
SHOULD_ANY=0
for app in $APPS; do
  state="${STATE_DIR}/last-ship-${app}.txt"
  decision=0

  if [[ ! -f "$state" ]]; then
    log "[${app}] no prior ship recorded (${state}); letting ship-testflight.sh decide."
    decision=1
  else
    # Format written by record_successful_ship(): "<unix_ts> <git_sha>"
    last_sha="$(awk 'NR==1{print $2}' "$state" 2>/dev/null || true)"
    if [[ -z "${last_sha:-}" || "$last_sha" == "unknown" ]]; then
      log "[${app}] ship state carries no sha; letting ship-testflight.sh decide."
      decision=1
    elif [[ "$last_sha" == "$HEAD_SHA" ]]; then
      log "[${app}] HEAD ${HEAD_SHA} already shipped; skip."
    elif ! git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
      git -C "$REPO_ROOT" fetch --deepen=200 --quiet 2>/dev/null || true
      if git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
        log "[${app}] deepened the clone to reach ${last_sha}."
        decision=-1
      else
        # Real and observed, not hypothetical: on 2026-08-13 Usage-Monitor's
        # recorded ship sha was 27b89434, the tip of a grok/* ship worktree --
        # not an ancestor of main at all. Skipping forever on that would be a
        # backstop that never backstops; shipping blind would be TestFlight
        # spam. So fall back to the TIMESTAMP the same state file records and
        # ask a question that needs no sha: has any commit touching this app
        # landed since the last successful ship?
        log "[${app}] last shipped sha ${last_sha} is unreachable from HEAD (shipped from another worktree/branch, or history was rewritten)."
        last_ts="$(awk 'NR==1{print $1}' "$state" 2>/dev/null || true)"
        if [[ "${last_ts:-}" =~ ^[0-9]+$ ]]; then
          since_changed="$(git -C "$REPO_ROOT" log --since="@${last_ts}" --format= --name-only -- "${SPEC_ARGS[@]}" 2>/dev/null | sed '/^$/d' | sort -u | head -20)"
          if [[ -n "$since_changed" ]]; then
            log "[${app}] falling back to time: ship paths changed after the last ship:"
            # Line-by-line, NOT `printf ... $var`: Socratic.Trade's iOS path is
            # "ios/Socratic Trade.xcodeproj/...", and unquoted word-splitting
            # printed that one file as two bogus lines. Decision logic is
            # unaffected; the log was just lying about what changed.
            printf '%s\n' "$since_changed" | while IFS= read -r f; do echo "  $f"; done
            decision=1
          else
            log "[${app}] falling back to time: no ship-path commits since the last ship; skip."
          fi
        else
          log "[${app}] state has no usable timestamp either; letting ship-testflight.sh decide."
          decision=1
        fi
      fi
    else
      decision=-1
    fi

    if [[ "$decision" -eq -1 ]]; then
      # Reachable range: the only case where a real diff is meaningful.
      # Captured into a variable, not piped into `grep -q`: under pipefail an
      # early-exiting grep SIGPIPEs git and the pipeline reports failure even
      # though it matched.
      changed="$(git -C "$REPO_ROOT" diff --name-only "$last_sha" HEAD -- "${SPEC_ARGS[@]}" 2>/dev/null | head -20)"
      if [[ -n "$changed" ]]; then
        log "[${app}] ship paths changed since ${last_sha}:"
        printf '%s\n' "$changed" | while IFS= read -r f; do echo "  $f"; done
        decision=1
      else
        log "[${app}] no ship-path changes since ${last_sha}; skip (TestFlight is not a commit log)."
        decision=0
      fi
    fi
  fi

  emit "$(out_key "$app")" "$decision"
  if [[ "$decision" -eq 1 ]]; then SHOULD_ANY=1; fi
done

emit should_ship "$SHOULD_ANY"
if [[ "$SHOULD_ANY" -eq 0 ]]; then
  log "scheduled tick: nothing to ship."
fi
exit 0
