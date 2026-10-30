#!/bin/bash
# [INSTINCT] vps-storage-watch - prod app DB growth + device free watcher for the fleet server.
# Every 15 min via /etc/cron.d/vps-storage-watch. Alert-only; posts to Zulip #alerts as the Operator and tags both
# Housekeepers and Jay (owner, Oct 29 2026:  every resource alert tags the Housekeepers and Jay).
# Also writes /root/vps-storage-status.json for HogHunter / Usage Monitor to read over SSH.
#
# The app database paths are host inventory, so they live in /etc/vps-storage-watch.env (ST_APP_DB, CT_DB, UM_DB),
# never in this public repo:  see vps-storage-watch.env.example.  The paths below can be overridden for tests.
set -u
ENV_FILE=${VPS_STORAGE_ENV:-/etc/vps-storage-watch.env}
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
STATE=${VPS_STORAGE_STATE:-/root/.vps-storage-watch}
mkdir -p "$STATE"
NOW=$(date +%s)
ZRC=${VPS_STORAGE_ZULIPRC:-/root/.zuliprc-operator}
SNAP=${VPS_STORAGE_SNAPSHOT:-/root/vps-storage-status.json}
HOST=$(hostname)
MENTIONS='@**BF-Housekeeper|1216054** @**GB-Housekeeper|1215533** @**Jay Wedgeworth|1211974**'

record() { # metric value
  echo "$NOW $2" >> "$STATE/$1.samples"
  awk -v cut=$((NOW-691200)) '$1>=cut' "$STATE/$1.samples" > "$STATE/$1.samples.tmp" && mv "$STATE/$1.samples.tmp" "$STATE/$1.samples"
}
sample_at() { # metric seconds_ago -> value of newest sample at or before NOW-ago
  awk -v t=$((NOW-$2)) '$1<=t{v=$2} END{if(v!="")print v}' "$STATE/$1.samples" 2>/dev/null
}
cooldown_ok() { # key -> 0 if no alert in last 6h
  local f="$STATE/alerted.$1"
  [ ! -f "$f" ] && return 0
  local last; last=$(cat "$f")
  [ $((NOW-last)) -gt 21600 ]
}
mark_alerted() { date +%s > "$STATE/alerted.$1"; }
alert() { # title body
  curl -sS -m 15 -u "$(grep '^email=' "$ZRC" | cut -d= -f2-):$(grep '^key=' "$ZRC" | cut -d= -f2-)" \
    "$(grep '^site=' "$ZRC" | cut -d= -f2-)/api/v1/messages" \
    --data-urlencode "type=stream" --data-urlencode "to=alerts" \
    --data-urlencode "topic=vps-storage" \
    --data-urlencode "content=[INSTINCT] VPS storage - $1
$2
$MENTIONS" >/dev/null 2>&1
}
check_db() { # name dbfile t24h t1h
  local size wal
  size=$(stat -c%s "$2" 2>/dev/null || echo 0)
  wal=$(stat -c%s "$2-wal" 2>/dev/null || echo 0)
  size=$((size+wal))
  record "$1" "$size"
  local d24 d1
  d24=$(sample_at "$1" 86400); d1=$(sample_at "$1" 3600)
  if [ -n "$d24" ] && [ $((size-d24)) -gt "$3" ] && cooldown_ok "$1.24h"; then
    alert "$1 growth (24h)" "$1 is $(numfmt --to=iec $size) (+$(numfmt --to=iec $((size-d24))) in 24h; threshold $(numfmt --to=iec $3))."
    mark_alerted "$1.24h"
  fi
  if [ -n "$d1" ] && [ $((size-d1)) -gt "$4" ] && cooldown_ok "$1.1h"; then
    alert "$1 growth SPIKE (1h)" "$1 is $(numfmt --to=iec $size) (+$(numfmt --to=iec $((size-d1))) in 1h; threshold $(numfmt --to=iec $4))."
    mark_alerted "$1.1h"
  fi
  echo "$size"
}

for name in ST_APP_DB CT_DB UM_DB; do
  if [ -z "${!name:-}" ]; then
    echo "vps-storage-watch: $name is not set in $ENV_FILE" >&2
    exit 2
  fi
done
ST_SIZE=$(check_db st_app_db "$ST_APP_DB" 1073741824 209715200)
CT_SIZE=$(check_db ct_db "$CT_DB" 536870912 104857600)
UM_SIZE=$(check_db um_db "$UM_DB" 536870912 104857600)

# device free bytes
ROOT_FREE=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
TMP_FREE=$(df -B1 --output=avail /tmp | tail -1 | tr -d ' ')
SHM_FREE=$(df -B1 --output=avail /dev/shm | tail -1 | tr -d ' ')
record dev_root_free "$ROOT_FREE"; record dev_tmp_free "$TMP_FREE"; record dev_shm_free "$SHM_FREE"

# largest dirs (guarded du; may be unavailable on a slow pass)

# snapshot json for HogHunter / Usage Monitor
{
  # CPU tick-delta from /proc/stat (two reads, 1s apart) - same counters top uses.
  read -r _ U1 N1 S1 I1 IO1 IRQ1 SIRQ1 ST1 _ < /proc/stat
  sleep 1
  read -r _ U2 N2 S2 I2 IO2 IRQ2 SIRQ2 ST2 _ < /proc/stat
  TT1=$((U1+N1+S1+I1+IO1+IRQ1+SIRQ1+ST1)); TT2=$((U2+N2+S2+I2+IO2+IRQ2+SIRQ2+ST2))
  D_T=$((TT2-TT1)); D_I=$((I2-I1))
  if [ "$D_T" -gt 0 ]; then CPU_PCT=$(awk -v t="$D_T" -v i="$D_I" 'BEGIN{printf "%.1f",(1-i/t)*100}'); else CPU_PCT=0; fi
  LOAD1=$(awk '{print $1}' /proc/loadavg)
  CORES=$(nproc)
  MEM_TOTAL=$(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo)
  MEM_AVAIL=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
  MEM_USED=$((MEM_TOTAL-MEM_AVAIL))
  SWAP_TOTAL=$(awk '/^SwapTotal:/{print $2*1024}' /proc/meminfo)
  SWAP_FREE=$(awk '/^SwapFree:/{print $2*1024}' /proc/meminfo)
  SWAP_USED=$((SWAP_TOTAL-SWAP_FREE))
  printf '{\n  "generated_at": "%s",\n  "host": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOST"
  printf '  "devices": {"root": {"mount": "/", "free_bytes": %s, "note": "301GB disk: OS, Docker images, all container volumes incl ST DB, dev/agent dirs"}, "tmp": {"mount": "/tmp", "free_bytes": %s, "note": "16GB RAM tmpfs shared by host, builds, docker exec"}, "shm": {"mount": "/dev/shm", "free_bytes": %s, "note": "16GB RAM tmpfs, container shm"}},\n' "$ROOT_FREE" "$TMP_FREE" "$SHM_FREE"
  printf '  "app_dbs": {"st_app_db": %s, "ct_db": %s, "um_db": %s},\n' "$ST_SIZE" "$CT_SIZE" "$UM_SIZE"
  printf '  "cpu": {"pct": %s, "load1": %s, "cores": %s, "source": "proc-stat tick delta 1s"},\n' "$CPU_PCT" "$LOAD1" "$CORES"
  printf '  "memory": {"total_bytes": %s, "used_bytes": %s, "available_bytes": %s},\n' "$MEM_TOTAL" "$MEM_USED" "$MEM_AVAIL"
  printf '  "swap": {"total_bytes": %s, "used_bytes": %s, "free_bytes": %s},\n' "$SWAP_TOTAL" "$SWAP_USED" "$SWAP_FREE"
  printf '  "largest_dirs": [\n'
  timeout 60 du -x -d1 -B1 ${VPS_STORAGE_DU_DIRS:-/var/lib/docker /data /root} 2>/dev/null | sort -rn | head -4 | awk '{printf "    {\"path\": \"%s\", \"bytes\": %s},\n", $2, $1}' | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$SNAP.tmp" && mv "$SNAP.tmp" "$SNAP"
