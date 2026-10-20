#!/usr/bin/env bash
# Install the Mac collector scripts into a stable copy outside ~/Code.
#
# ~/Code/Usage-Monitor is the human integration tree: a daemon resets it, so a
# LaunchAgent that executes scripts from there breaks (or silently runs stale
# code) whenever the tree moves.  The collectors only need scripts/ plus the
# `zod` package, so this copies exactly that to
#
#   ${UM_COLLECTORS_HOME:-$HOME/apps/usage-monitor-collectors}
#     scripts/             collector entry points + scripts/lib, plus
#                          run-subscription-quota-collector.sh (UM-1616)
#     node_modules/zod     the only third-party import the collectors have
#     VERSION              git sha and install time
#
# Usage (from any Usage-Monitor checkout or lane that has the code to install):
#   scripts/install-collectors.sh            copy the files, print the plist diff
#   scripts/install-collectors.sh --plists   also point the installed LaunchAgents
#                                            at the copy and reload them
#
# --plists rewrites only the com.jays.*collector LaunchAgents that already exist
# in ~/Library/LaunchAgents and that still reference a Usage-Monitor checkout;
# it also repoints the Antigravity CLI statusLine hook.  Re-run this script
# after merging collector changes to refresh the copy.
#
# --plists also runs the subscription-quota LaunchAgent through
# run-subscription-quota-collector.sh, which reads the Claude Code OAuth
# credential from the login Keychain and passes it to the collector (UM-1616).
# The first pass after that shows one macOS prompt: click Always Allow.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${UM_COLLECTORS_HOME:-$HOME/apps/usage-monitor-collectors}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
APPLY_PLISTS=0
[[ "${1:-}" == "--plists" ]] && APPLY_PLISTS=1

case "$DEST" in
  "$HOME"/Code/*) echo "refusing to install into the ~/Code integration tree: $DEST" >&2; exit 2 ;;
esac

mkdir -p "$DEST/scripts"
# Entry points and shared libs only; no tests, iOS tooling, or deploy scripts.
rsync -a --delete --delete-excluded \
  --include='/lib/' --include='/lib/*.mjs' \
  --include='/*-collector.mjs' \
  --include='/run-subscription-quota-collector.sh' \
  --include='/antigravity-statusline-telemetry.mjs' \
  --exclude='*' \
  "$SRC/scripts/" "$DEST/scripts/"

ZOD_VERSION="$(node -p "require('$SRC/package.json').dependencies.zod" 2>/dev/null || true)"
ZOD_VERSION="${ZOD_VERSION:-^4.6.5}"
if [[ ! -f "$DEST/node_modules/zod/package.json" ]]; then
  printf '{"name":"usage-monitor-collectors","private":true,"type":"module"}\n' > "$DEST/package.json"
  (cd "$DEST" && npm install --omit=dev --no-audit --no-fund --silent "zod@${ZOD_VERSION}")
fi

SHA="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'sha=%s\ninstalled=%s\nsource=%s\n' "$SHA" "$(date -u +%FT%TZ)" "$SRC" > "$DEST/VERSION"

# Smoke test: every entry point must at least parse and resolve its imports.
for f in "$DEST"/scripts/*-collector.mjs; do
  node --check "$f"
done
bash -n "$DEST/scripts/run-subscription-quota-collector.sh"
echo "installed $SHA -> $DEST"

[[ "$APPLY_PLISTS" == 1 ]] || { echo "LaunchAgents untouched (pass --plists to repoint them)."; exit 0; }

UID_N="$(id -u)"
for plist in "$AGENTS_DIR"/com.jays.*collector.plist; do
  [[ -f "$plist" ]] || continue
  label="$(basename "$plist" .plist)"
  if ! grep -q 'Usage-Monitor/scripts/' "$plist"; then
    echo "skip $label (not running from a Usage-Monitor checkout)"
    continue
  fi
  # Match any checkout path (…/Code/Usage-Monitor, a lane, …) before /scripts/.
  sed -i '' -E "s#/[^<]*/Usage-Monitor/scripts/#${DEST}/scripts/#g" "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$plist"
  echo "repointed + reloaded $label"
done

# subscription-quota LaunchAgent: run it through the Keychain wrapper.  The
# installed plist points at $DEST already, so the loop above skips it.
QUOTA_LABEL="com.jays.subscription-quota-collector"
QUOTA_PLIST="$AGENTS_DIR/$QUOTA_LABEL.plist"
if [[ -f "$QUOTA_PLIST" ]]; then
  wired="$("$SRC/scripts/wire-quota-wrapper-plist.sh" "$QUOTA_PLIST" "$DEST/scripts/run-subscription-quota-collector.sh")"
  if [[ "$wired" == "wired" ]]; then
    launchctl bootout "gui/$UID_N/$QUOTA_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_N" "$QUOTA_PLIST"
    echo "wired + reloaded $QUOTA_LABEL (click Always Allow on the Keychain prompt)"
  else
    echo "$QUOTA_LABEL: $wired"
  fi
fi

# agy statusLine hook (Antigravity CLI settings).
AGY_SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"
if [[ -f "$AGY_SETTINGS" ]] && grep -q 'Usage-Monitor/scripts/antigravity-statusline-telemetry.mjs' "$AGY_SETTINGS"; then
  sed -i '' -E "s#/[^\" ]*/Usage-Monitor/scripts/antigravity-statusline-telemetry.mjs#${DEST}/scripts/antigravity-statusline-telemetry.mjs#g" "$AGY_SETTINGS"
  echo "repointed agy statusLine hook"
fi
