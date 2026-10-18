#!/usr/bin/env bash
# Install the Mac collector scripts into a stable copy outside ~/Code.
#
# ~/Code/Usage-Monitor is the human integration tree: a daemon resets it, so a
# LaunchAgent that executes scripts from there breaks (or silently runs stale
# code) whenever the tree moves.  The collectors only need scripts/ plus the
# `zod` package, so this copies exactly that to
#
#   ${UM_COLLECTORS_HOME:-$HOME/apps/usage-monitor-collectors}
#     scripts/             collector entry points + scripts/lib
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

# agy statusLine hook (Antigravity CLI settings).
AGY_SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"
if [[ -f "$AGY_SETTINGS" ]] && grep -q 'Usage-Monitor/scripts/antigravity-statusline-telemetry.mjs' "$AGY_SETTINGS"; then
  sed -i '' -E "s#/[^\" ]*/Usage-Monitor/scripts/antigravity-statusline-telemetry.mjs#${DEST}/scripts/antigravity-statusline-telemetry.mjs#g" "$AGY_SETTINGS"
  echo "repointed agy statusLine hook"
fi
