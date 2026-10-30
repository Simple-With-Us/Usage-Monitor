#!/bin/bash
# Install vps-storage-watch on the fleet server from this checkout (run as root, or through sudo).
# Copies the three scripts to /root and the schedule to /etc/cron.d, keeping a dated backup of any file it replaces.
# It never writes /etc/vps-storage-watch.env:  create that from vps-storage-watch.env.example first.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
env_file=/etc/vps-storage-watch.env
stamp=$(date -u +%Y%m%dT%H%MZ)

if [ ! -s "$env_file" ]; then
  echo "install: $env_file is missing;  copy vps-storage-watch.env.example there (mode 0600) and fill it in" >&2
  exit 2
fi
for name in ST_APP_DB CT_DB UM_DB; do
  if ! grep -q "^$name=." "$env_file"; then
    echo "install: $env_file has no $name;  every database path must be set" >&2
    exit 2
  fi
done

place() { # source target mode
  if [ -e "$2" ] && ! cmp -s "$1" "$2"; then
    cp -p "$2" "$2.bak-$stamp"
  fi
  install -m "$3" -o root -g root "$1" "$2"
  echo "installed $2"
}

place "$here/vps-storage-watch.sh" /root/vps-storage-watch.sh 0755
place "$here/vps-storage-watch-with-metrics.sh" /root/vps-storage-watch-with-metrics.sh 0755
place "$here/vps-status-supplement.py" /root/vps-status-supplement.py 0750
place "$here/vps-storage-watch.cron" /etc/cron.d/vps-storage-watch 0644
