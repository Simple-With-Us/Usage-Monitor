#!/usr/bin/env bash
# Mac Server Watchdog & Telemetry Ingest Script
# Sends Mac host health metrics to POST /api/ingest/mac-heartbeat on Usage-Monitor
# and performs self-healing checks on critical local processes.

set -euo pipefail

INGEST_URL="${INGEST_URL:-https://usage.jays.services/api/ingest/mac-heartbeat}"
SECRETS_FILE="/Users/jay/.secrets/global-api-keys"

# Prefer the scoped heartbeat token (a `mac-host:<token>` entry in the
# monitor's USAGE_INGEST_PRODUCER_TOKENS); the unscoped USAGE_INGEST_TOKEN is
# refused once USAGE_INGEST_REQUIRE_SCOPED_TOKENS=true.
read_secret() {
  [[ -f "$SECRETS_FILE" ]] || return 0
  grep -m1 "^$1=" "$SECRETS_FILE" | cut -d'=' -f2- | tr -d '"' || true
}

TOKEN="${MAC_HEARTBEAT_INGEST_TOKEN:-}"
[[ -n "$TOKEN" ]] || TOKEN="$(read_secret MAC_HEARTBEAT_INGEST_TOKEN)"
[[ -n "$TOKEN" ]] || TOKEN="${USAGE_INGEST_TOKEN:-}"
[[ -n "$TOKEN" ]] || TOKEN="$(read_secret USAGE_INGEST_TOKEN)"

if [[ -z "$TOKEN" ]]; then
  echo "Error: MAC_HEARTBEAT_INGEST_TOKEN / USAGE_INGEST_TOKEN not found in environment or $SECRETS_FILE" >&2
  exit 1
fi

HOSTNAME="jays.services"
USERNAME="$(id -un 2>/dev/null || echo "jay")"

# Tailscale FQDN
TS_NAME="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' 2>/dev/null | sed 's/\.$//' || true)"
if [[ -z "$TS_NAME" || "$TS_NAME" == "null" ]]; then
  TS_NAME="$(tailscale status 2>/dev/null | head -n 1 | awk '{print $2}' || echo "macbook.boa-roygbiv.ts.net")"
  if [[ "$TS_NAME" == "macbook" ]]; then
    TS_NAME="macbook.boa-roygbiv.ts.net"
  fi
fi
TAILSCALE_NAME="${TS_NAME:-macbook.boa-roygbiv.ts.net}"

OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo "macOS")"
CHIP_NAME="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model 2>/dev/null || uname -m)"
ARCH="$(uname -m 2>/dev/null || echo "arm64")"

# Calculate CPU Usage % (normalized across cores)
CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 8)"
CPU_USAGE="$(ps -A -o %cpu | awk -v cores="$CORES" '{s+=$1} END {printf "%.1f", s / (cores > 0 ? cores : 8)}')"

# Calculate Memory Usage % (via vm_stat)
PAGE_SIZE="$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)"
FREE_PAGES="$(vm_stat | awk '/Pages free/ {print $3}' | tr -d '.')"
ACTIVE_PAGES="$(vm_stat | awk '/Pages active/ {print $3}' | tr -d '.')"
INACTIVE_PAGES="$(vm_stat | awk '/Pages inactive/ {print $3}' | tr -d '.')"
WIRED_PAGES="$(vm_stat | awk '/Pages wired/ {print $4}' | tr -d '.' || echo 0)"
TOTAL_MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 17179869184)"

USED_MEM_BYTES=$(( (ACTIVE_PAGES + INACTIVE_PAGES + WIRED_PAGES) * PAGE_SIZE ))
MEM_USAGE="$(awk -v used="$USED_MEM_BYTES" -v total="$TOTAL_MEM_BYTES" 'BEGIN {printf "%.1f", (used/total)*100}')"

# Calculate Disk Usage % from APFS user/data volume (/System/Volumes/Data)
if df -k /System/Volumes/Data >/dev/null 2>&1; then
  DISK_USAGE="$(df -k /System/Volumes/Data | awk 'NR==2 {print $5}' | tr -d '%')"
else
  DISK_USAGE="$(df -k / | awk 'NR==2 {print $5}' | tr -d '%')"
fi

# Calculate Uptime Seconds
UPTIME_SEC="$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{print $2}' | awk -v now="$(date +%s)" '{printf "%d", now - $1}')"

# Process status checks
check_process() {
  local name="$1"
  local is_optional="${2:-false}"
  if pgrep -x "$name" >/dev/null 2>&1 || pgrep -f "$name" >/dev/null 2>&1; then
    echo "running"
  elif [[ "$is_optional" == "true" ]]; then
    echo "not_enabled"
  else
    echo "stopped"
  fi
}

OLLAMA_STATUS="$(check_process "ollama" "true")"
LITESTREAM_STATUS="$(check_process "litestream" "true")"
# OrbStack and Docker Desktop are distinct runtimes — report them separately so
# the app can label the one actually in use (owner 2026-08-31: "docker" read
# wrong when the runtime is OrbStack).
ORBSTACK_STATUS="$(check_process "(OrbStack|orbstack)" "true")"
DOCKER_STATUS="$(check_process "Docker" "true")"
AG***_S**C_STATUS="$(check_process "ag***-s**c" "false")"

# Coding agent live execution checks
check_agent() {
  local pattern="$1"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "running"
  else
    echo "idle"
  fi
}

CLAUDE_STATUS="$(check_agent "(claude|Claude)")"
CURSOR_STATUS="$(check_agent "(Cursor|cursor-agent)")"
GROK_STATUS="$(check_agent "(grok|grok-leader|grok-acp)")"
CODEX_STATUS="$(check_agent "(codex|openai-codex)")"
AGY_STATUS="$(check_agent "(antigravity|agy-acp)")"
COPILOT_STATUS="$(check_agent "(copilot|github-copilot)")"

# PM2 fleet jobs JSON
if command -v pm2 >/dev/null 2>&1; then
  PM2_JSON="$(pm2 jlist 2>/dev/null | jq '[.[] | {name: .name, status: .pm2_env.status, pid: .pid, cpu: .monit.cpu, memory: .monit.memory}]' 2>/dev/null || echo "[]")"
else
  PM2_JSON="[]"
fi

# Launchd fleet jobs JSON
LAUNCHD_JSON="$(launchctl list | awk '
  NR == 1 { next }
  $3 ~ /^(com\.jay\.|com\.jays\.|com\.congress\.|actions\.runner\.|homebrew\.|com\.cursor\.|com\.omnara\.|com\.ccpocket\.|pm2\.|com\.cloudflare\.|com\.PM2$)/ {
    pid = ($1 == "-" ? "null" : $1)
    status = ($2 == "0" || $2 == "-" ? "ok" : "exit-" $2)
    printf "{\"name\":\"%s\",\"status\":\"%s\",\"pid\":%s},\n", $3, status, pid
  }
' | sed '$ s/,$//' | awk 'BEGIN {printf "["} {print} END {printf "]"}' 2>/dev/null || echo "[]")"

# Build JSON Payload
PAYLOAD="$(jq -n \
  --arg hostname "$HOSTNAME" \
  --arg username "$USERNAME" \
  --arg tailscaleHostname "$TAILSCALE_NAME" \
  --arg osVersion "$OS_VERSION" \
  --arg chipName "$CHIP_NAME" \
  --arg arch "$ARCH" \
  --argjson cpuUsagePct "${CPU_USAGE:-0}" \
  --argjson memoryUsagePct "${MEM_USAGE:-0}" \
  --argjson diskUsagePct "${DISK_USAGE:-0}" \
  --argjson uptimeSeconds "${UPTIME_SEC:-0}" \
  --arg ollama "$OLLAMA_STATUS" \
  --arg litestream "$LITESTREAM_STATUS" \
  --arg orbstack "$ORBSTACK_STATUS" \
  --arg docker "$DOCKER_STATUS" \
  --arg ag***s**c "$AG***_S**C_STATUS" \
  --arg claudeAgent "$CLAUDE_STATUS" \
  --arg cursorAgent "$CURSOR_STATUS" \
  --arg grokAgent "$GROK_STATUS" \
  --arg codexAgent "$CODEX_STATUS" \
  --arg agyAgent "$AGY_STATUS" \
  --arg copilotAgent "$COPILOT_STATUS" \
  --argjson pm2 "$PM2_JSON" \
  --argjson launchd "$LAUNCHD_JSON" \
  '{
    hostname: $hostname,
    username: $username,
    tailscaleHostname: $tailscaleHostname,
    osVersion: $osVersion,
    chipName: $chipName,
    arch: $arch,
    cpuUsagePct: $cpuUsagePct,
    memoryUsagePct: $memoryUsagePct,
    diskUsagePct: $diskUsagePct,
    uptimeSeconds: $uptimeSeconds,
    processes: {
      ollama: $ollama,
      litestream: $litestream,
      orbstack: $orbstack,
      docker: $docker,
      "ag***-s**c": $ag***s**c
    },
    agentProcesses: {
      "claude-code": $claudeAgent,
      "cursor-agent": $cursorAgent,
      "grok-build": $grokAgent,
      "openai-codex": $codexAgent,
      "antigravity-cli": $agyAgent,
      "github-copilot": $copilotAgent
    },
    pm2Processes: $pm2,
    launchdProcesses: $launchd
  }'
)"

# Post Heartbeat
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$INGEST_URL" || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Mac heartbeat posted successfully (${CHIP_NAME}, CPU: ${CPU_USAGE}%, RAM: ${MEM_USAGE}%, Disk: ${DISK_USAGE}%)."
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: Mac heartbeat failed with HTTP status $HTTP_CODE" >&2
fi

