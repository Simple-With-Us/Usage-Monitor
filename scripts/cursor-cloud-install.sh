#!/usr/bin/env bash
#
# cursor-cloud-install.sh — idempotent Ubuntu setup for Cursor cloud agents on
# Usage-Monitor.  Runs during Build (state persists across agent boots).  Does
# NOT export secrets — that belongs in cursor-cloud-start.sh because shell
# exports do not persist across restarts.
#
# Skip macOS / iOS / Xcode steps; those are owner-only Mac workflows.
# Never print secret values; names only.
#
# Toolchain: Node 24.14.1 (.node-version), npm, package-lock.json, Next.js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

log() { printf '[cursor-install] %s\n' "$*"; }

# ---- macOS / iOS skip note --------------------------------------------------
case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin)
    log "macOS host detected — Usage-Monitor is a Next.js + SQLite app; macOS / iOS / Xcode workflows are skipped on purpose."
    log "On macOS, also check scripts/cloud-setup.sh for the local dev path."
    ;;
esac

# ---- Node 24.x ------------------------------------------------------------
desired_node="$(tr -d '[:space:]' < .node-version 2>/dev/null || echo 24.14.1)"
log "Desired Node version: ${desired_node}"

node_bin="$(command -v node || true)"
node_major=""
if [[ -n "${node_bin}" ]]; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")"
fi

if [[ -z "${node_major}" || "${node_major}" -lt 24 ]]; then
  if command -v fnm >/dev/null 2>&1; then
    log "Installing Node ${desired_node} via fnm"
    fnm install "${desired_node}" >/dev/null 2>&1 || fnm install --lts >/dev/null 2>&1 || true
    fnm use "${desired_node}" >/dev/null 2>&1 || fnm use --lts >/dev/null 2>&1 || true
    eval "$(fnm env --shell=bash 2>/dev/null || true)"
  elif command -v nvm >/dev/null 2>&1; then
    log "Installing Node ${desired_node} via nvm"
    # shellcheck disable=SC1091
    \. "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
    nvm install "${desired_node}" >/dev/null 2>&1 || nvm install --lts >/dev/null 2>&1 || true
    nvm use "${desired_node}" >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
  elif command -v n >/dev/null 2>&1; then
    log "Installing Node ${desired_node} via n"
    n install "${desired_node}" >/dev/null 2>&1 || n install --lts >/dev/null 2>&1 || true
  else
    log "No Node version manager (fnm/nvm/n) found and current Node is ${node_major:-missing}."
    log "Falling back to whatever apt provides."
  fi
else
  log "Node ${node_major}.x already present; skipping version-manager install"
fi

if command -v node >/dev/null 2>&1; then
  log "Node: $(node --version)  npm: $(npm --version)"
else
  log "WARNING: node not on PATH after install attempt; continuing (typecheck may fail later)"
fi

# ---- Infisical CLI (prefer repo helper, fall back to official installer) ---
if command -v infisical >/dev/null 2>&1; then
  log "Infisical CLI already present: $(infisical --version 2>/dev/null || echo unknown)"
else
  if [[ -x "${REPO_ROOT}/scripts/infisical-run.mjs" ]]; then
    log "Repo Infisical helper exists at scripts/infisical-run.mjs; will use it from start"
  fi
  log "Installing Infisical CLI (Linux) via official installer"
  curl -fsSL https://infisical.com/install.sh 2>/dev/null | sh -s -- --use-shell bash >/dev/null 2>&1 || {
    log "Infisical CLI installer failed; start script will fall back to a curl+python3 fetch if needed"
  }
  if command -v infisical >/dev/null 2>&1; then
    log "Infisical CLI installed: $(infisical --version 2>/dev/null || echo unknown)"
  else
    log "Infisical CLI still not present; start script will use the curl+python3 fallback"
  fi
fi

# ---- npm ci --------------------------------------------------------------
log "Running: npm ci (Next.js / TypeScript deps)"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund --include=dev >/dev/null 2>&1 || npm ci --no-audit --no-fund --include=dev
else
  log "package-lock.json not found; running npm install --include=dev"
  npm install --no-audit --no-fund --include=dev >/dev/null 2>&1 || npm install --no-audit --no-fund --include=dev
fi

# ---- Prisma client (postinstall already runs prisma generate) ------------
if [[ -d node_modules/.prisma ]] || [[ -d node_modules/@prisma/client ]]; then
  log "Prisma client present"
else
  log "Prisma client missing after install; running prisma generate"
  npx --yes prisma generate >/dev/null 2>&1 || log "prisma generate failed; typecheck may be incomplete"
fi

log "Install complete."
log "Next: start exports Infisical secrets to \$HOME/.cursor-cloud-env/Usage-Monitor.env (mode 0600)."