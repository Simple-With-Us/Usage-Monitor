#!/usr/bin/env bash
# Attach one processed build to the app's existing external TestFlight groups
# and, when Apple is waiting, submit that build for Beta App Review.
#
# Does not create a group and does not invite a tester.  The normal ship job
# is the only caller that sets IOS_ASSIGN_EXTERNAL_BETA=1.  Any other
# invocation exits without calling App Store Connect.
set -euo pipefail

if [[ "${IOS_ASSIGN_EXTERNAL_BETA:-}" != "1" ]]; then
  echo "external-beta: skipped (IOS_ASSIGN_EXTERNAL_BETA is unset; only the normal ship job sets it)" >&2
  exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ASC_NODE="${ASC_NODE:-${IOS_FLEET_NODE:-node}}"
exec "$ASC_NODE" "${HERE}/asc-api.mjs" assign-external-beta "$@"
