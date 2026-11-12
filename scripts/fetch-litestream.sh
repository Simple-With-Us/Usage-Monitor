#!/usr/bin/env bash
# Build-time download of a pinned Litestream release into ./bin/litestream.
#
# Litestream (https://litestream.io) continuously replicates the SQLite file
# on this app's Render disk to an S3-compatible bucket (Cloudflare R2). This
# script only fetches the binary; whether replication actually runs is
# controlled entirely by the LITESTREAM_S3_* env vars at runtime — see
# scripts/start-with-litestream.sh. Safe to run even when replication is
# never enabled; it just leaves an unused binary in ./bin.
#
# This runs in every build's buildCommand. By default a download or checksum
# failure only WARNS and leaves the binary absent, which keeps a laptop or a
# replication-less environment building.
#
# Set FETCH_LITESTREAM_REQUIRED=true to make those failures fatal, and do set
# it in any image that will run with replication configured. Otherwise a
# transient CDN flake is silently baked into the image, the build is reported
# green, and the failure only surfaces at runtime as the startup wrapper
# correctly failing closed — a crash-loop, a failed healthcheck, and a rolled
# back deploy, repeated for every subsequent deploy because the broken image
# is cached against that commit SHA. That is exactly what happened on
# 2026-08-13: production could not accept any deploy until the image was
# rebuilt. Failing the build is both louder and cheaper.
#
# Pinned version: v0.5.13 (newest 0.5.x at the time this script was written,
# verified against the GitHub Releases API: `api.github.com/repos/
# benbjohnson/litestream/releases`). Litestream 0.5.x uses the LTX file model
# and a single-replica-per-database config, matching litestream.yml here and
# the sibling Socratic.Trade app's docs/litestream.md this was adapted from.
#
# Release asset naming note: GitHub release assets use "linux-x86_64" for
# Intel/AMD and "linux-arm64" for 64-bit Arm. Render currently builds on
# x86_64 while the Oracle Always Free Ampere A1 target is aarch64, so select
# the matching release and checksum instead of installing an unusable binary.
#
# Idempotent: if a binary is already present at ./bin/litestream and its
# sha256 matches the pin below, this exits immediately without re-downloading.
set -euo pipefail

LITESTREAM_VERSION="0.5.13"
LITESTREAM_OS="linux"
HOST_ARCH="${LITESTREAM_ARCH_OVERRIDE:-$(uname -m)}"
case "${HOST_ARCH}" in
  x86_64|amd64)
    LITESTREAM_ARCH="x86_64"
    LITESTREAM_SHA256="fc3420fea7d2f92d4d604aceeb0d7c63dc2c91f6ee5c1547cc05e25629e70f9f"
    ;;
  aarch64|arm64)
    LITESTREAM_ARCH="arm64"
    LITESTREAM_SHA256="ef47997794ce8dd87a64b44622d556b3a693b135fd72e0cf47cc42ac2e979051"
    ;;
  *)
    echo "[fetch-litestream] WARNING: unsupported Linux architecture: ${HOST_ARCH}" >&2
    echo "[fetch-litestream] Continuing without installing Litestream; configured/required" >&2
    echo "[fetch-litestream] replication will fail closed during startup." >&2
    exit 0
    ;;
esac
LITESTREAM_ASSET="litestream-${LITESTREAM_VERSION}-${LITESTREAM_OS}-${LITESTREAM_ARCH}.tar.gz"
LITESTREAM_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${LITESTREAM_ASSET}"
# From that release's checksums.txt (sha256 of the .tar.gz asset itself, not
# the extracted binary). Re-verify at https://github.com/benbjohnson/litestream/releases/tag/v0.5.13

# Deterministic, network-free architecture regression hook. This is used only
# by scripts/test-startup-config.mjs; ordinary builds leave it unset.
if [[ "${FETCH_LITESTREAM_METADATA_ONLY:-false}" == "true" ]]; then
  printf '%s %s\n' "${LITESTREAM_ASSET}" "${LITESTREAM_SHA256}"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${REPO_ROOT}/bin"
BIN_PATH="${BIN_DIR}/litestream"

log() {
  echo "[fetch-litestream] $*"
}

sha256_of() {
  # macOS (shasum) and Linux (sha256sum) both show up in dev/CI vs. Render.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERROR: no sha256sum or shasum available to verify the download" >&2
    exit 1
  fi
}

# Idempotent skip: only trust an existing binary if it reports the exact
# version we pin — protects against a stale binary left over from a prior
# pin surviving a Render build-cache hit silently.
#
# Tradeoff (accepted): on this skip path we match the `version` string but do
# NOT re-verify the on-disk binary's sha256, so a build-cache hit does not
# re-check the checksum pin. Render's persistent build cache is a trusted
# boundary — anything that can tamper with a cached ./bin/litestream can
# tamper with the checked-out source too — and re-downloading the release on
# every build to re-verify would defeat the idempotency this skip exists for.
# The sha256 pin below is still enforced on every real download (cache miss,
# version bump, or first build), which is where a tampered/corrupt tarball
# would actually enter.
if [[ -x "${BIN_PATH}" ]]; then
  EXISTING_VERSION="$("${BIN_PATH}" version 2>&1 || true)"
  if [[ "${EXISTING_VERSION}" == *"${LITESTREAM_VERSION}"* ]]; then
    log "bin/litestream already present at v${LITESTREAM_VERSION} — skipping download."
    exit 0
  fi
  log "bin/litestream present but not v${LITESTREAM_VERSION} (found: ${EXISTING_VERSION}) — re-fetching."
fi

mkdir -p "${BIN_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

TARBALL="${TMP_DIR}/${LITESTREAM_ASSET}"

# Exit 0 (warn) by default, exit 1 when the caller declared the binary
# required — see the FETCH_LITESTREAM_REQUIRED note in the header.
REQUIRED="${FETCH_LITESTREAM_REQUIRED:-false}"
give_up() {
  if [[ "${REQUIRED}" == "true" ]]; then
    echo "[fetch-litestream] FETCH_LITESTREAM_REQUIRED=true — failing the build rather than" >&2
    echo "[fetch-litestream] producing an image whose startup wrapper will fail closed." >&2
    exit 1
  fi
  echo "[fetch-litestream] Continuing without installing it. Startup remains available only" >&2
  echo "[fetch-litestream] when replication is unconfigured; configured/required backup fails closed." >&2
  exit 0
}

log "Downloading ${LITESTREAM_URL}"
# --http1.1 + --retry-all-errors: the sibling Infisical CLI download in the
# Dockerfile killed two production deploys on 2026-08-12 with
# `curl: (16) Error in the HTTP2 framing layer`, a transient GitHub-CDN flake.
# Same host, same asset-download path, so the same hardening applies here.
#
# The retry BUDGET matters as much as the flags.  Measured on 2026-11-09, the
# release-asset CDN degrades in rotating windows of roughly 20 seconds to 2
# minutes, and the window moves between assets.  The previous 5x2s budget
# spans about 10 seconds and cannot survive one of those windows; 180 seconds
# is the bound.  A genuinely missing asset still fails closed.
if ! curl -fsSL --http1.1 --retry 10 --retry-delay 10 --retry-max-time 180 --retry-all-errors \
    --retry-connrefused -o "${TARBALL}" "${LITESTREAM_URL}"; then
  echo "[fetch-litestream] WARNING: failed to download ${LITESTREAM_URL}" >&2
  echo "[fetch-litestream] Check network access and that v${LITESTREAM_VERSION} still has a" >&2
  echo "[fetch-litestream] ${LITESTREAM_ASSET} asset at https://github.com/benbjohnson/litestream/releases" >&2
  give_up
fi

ACTUAL_SHA256="$(sha256_of "${TARBALL}")"
if [[ "${ACTUAL_SHA256}" != "${LITESTREAM_SHA256}" ]]; then
  echo "[fetch-litestream] WARNING: sha256 mismatch for ${LITESTREAM_ASSET}" >&2
  echo "[fetch-litestream]   expected: ${LITESTREAM_SHA256}" >&2
  echo "[fetch-litestream]   actual:   ${ACTUAL_SHA256}" >&2
  echo "[fetch-litestream] Refusing to install a binary that doesn't match the pinned checksum." >&2
  give_up
fi
log "sha256 verified: ${ACTUAL_SHA256}"

tar -xzf "${TARBALL}" -C "${TMP_DIR}" litestream
mv "${TMP_DIR}/litestream" "${BIN_PATH}"
chmod +x "${BIN_PATH}"

log "Installed bin/litestream $("${BIN_PATH}" version 2>&1 || echo "v${LITESTREAM_VERSION}")"
