#!/usr/bin/env bash
# Point a subscription-quota LaunchAgent plist at the keychain wrapper (UM-1616).
#
# Usage: wire-quota-wrapper-plist.sh <plist> <wrapper-path>
#
# Rewrites the first two ProgramArguments entries (<node> <...>/subscription-quota-collector.mjs)
# into the single wrapper path, keeping every argument after them (--provider all
# --redacted).  Idempotent: a plist that already runs the wrapper is left alone.
# Prints "wired", "already wired" or "no match" and exits 0 for all three; it
# exits 2 only on bad usage.  Does not load or unload anything: the caller does.
set -euo pipefail

[[ $# -eq 2 && -f "$1" ]] || { echo "usage: $0 <plist> <wrapper-path>" >&2; exit 2; }
PLIST="$1"
WRAPPER="$2"

# Every match below is scoped to the ProgramArguments array.  A whole-file grep
# also hits the template's XML comment header, which names both scripts, so an
# unwired plist copied from that template would report "already wired" and stay
# pointed at the checkout this script exists to move it off.
program_arguments() { sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$1"; }

args="$(program_arguments "$PLIST")"
if grep -q 'run-subscription-quota-collector\.sh' <<<"$args"; then
  echo "already wired"
  exit 0
fi
if ! grep -q 'subscription-quota-collector\.mjs' <<<"$args"; then
  echo "no match"
  exit 0
fi

# Rewrite a copy and only replace the original once it validates: plutil -lint
# exits non-zero on a malformed plist, and under set -e that would otherwise
# abort install-collectors.sh with a half-rewritten plist already on disk.
TMP_PLIST="$(mktemp "${PLIST}.XXXXXX")"
trap 'rm -f "$TMP_PLIST"' EXIT
cp -p "$PLIST" "$TMP_PLIST"

WRAPPER="$WRAPPER" perl -0pi -e '
  my $w = $ENV{WRAPPER};
  $w =~ s/&/&amp;/g; $w =~ s/</&lt;/g;
  s{<string>[^<]*</string>(\s*)<string>[^<]*subscription-quota-collector\.mjs</string>}{<string>$w</string>}
' "$TMP_PLIST"

if ! grep -q 'run-subscription-quota-collector\.sh' <<<"$(program_arguments "$TMP_PLIST")"; then
  echo "no match"
  exit 0
fi
command -v plutil >/dev/null 2>&1 && plutil -lint "$TMP_PLIST" >/dev/null
mv "$TMP_PLIST" "$PLIST"
trap - EXIT
echo "wired"
