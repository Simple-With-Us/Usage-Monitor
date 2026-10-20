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

if grep -q 'run-subscription-quota-collector\.sh' "$PLIST"; then
  echo "already wired"
  exit 0
fi
if ! grep -q 'subscription-quota-collector\.mjs' "$PLIST"; then
  echo "no match"
  exit 0
fi

WRAPPER="$WRAPPER" perl -0pi -e '
  my $w = $ENV{WRAPPER};
  $w =~ s/&/&amp;/g; $w =~ s/</&lt;/g;
  s{<string>[^<]*</string>(\s*)<string>[^<]*subscription-quota-collector\.mjs</string>}{<string>$w</string>}
' "$PLIST"

if grep -q 'run-subscription-quota-collector\.sh' "$PLIST"; then
  command -v plutil >/dev/null 2>&1 && plutil -lint "$PLIST" >/dev/null
  echo "wired"
else
  echo "no match"
fi
