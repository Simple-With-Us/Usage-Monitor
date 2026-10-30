#!/bin/sh
# One writer covers the existing watch, its histories, and the supplemental metrics.
set -eu
state=/root/.vps-storage-watch
mkdir -p "$state"
exec 9>"$state/collector.lock"
flock -n 9 || exit 0
/root/vps-storage-watch.sh
exec /usr/bin/python3 -S /root/vps-status-supplement.py \
  --snapshot /root/vps-storage-status.json --home /root --history "$state"
