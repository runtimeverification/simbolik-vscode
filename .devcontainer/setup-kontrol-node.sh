#!/usr/bin/env bash
#
# Provision the kontrol-node execution engine used by the Simbolik debug server.
#
# It lives in a side folder (/home/node/kontrol-node) backed by a persistent
# named volume declared in devcontainer.json, so both the clone and its compiled
# KEVM semantics survive dev container rebuilds. This script is idempotent: it
# clones only when the folder is empty (e.g. a freshly created volume) and builds
# the kdist semantics only when they are missing.
#
# Invoked from postCreateCommand; also runnable by hand:
#   .devcontainer/setup-kontrol-node.sh
set -euo pipefail

REPO="${KONTROL_NODE_DIR:-/home/node/kontrol-node}"
REPO_URL="https://github.com/runtimeverification/kontrol-node.git"
export KDIST_DIR="$REPO/.kdist"
export NIX_CONFIG="experimental-features = nix-command flakes"
MARKER="$REPO/.simbolik-build-complete"

echo "[kontrol-node] target: $REPO (KDIST_DIR=$KDIST_DIR)"

# 1. Clone if absent (a fresh named volume after a rebuild is empty).
if [ ! -e "$REPO/.git" ]; then
  echo "[kontrol-node] cloning $REPO_URL ..."
  git clone "$REPO_URL" "$REPO"
else
  echo "[kontrol-node] clone present; skipping clone."
fi

# 2. Build the KEVM semantics once. Slow the first time (compiles KEVM); the
#    output lands in KDIST_DIR inside the persistent volume, so later rebuilds
#    find the marker and skip.
if [ ! -f "$MARKER" ]; then
  echo "[kontrol-node] building kdist semantics (slow on first provision) ..."
  cd "$REPO"
  mkdir -p "$KDIST_DIR"
  nix develop --command bash -c 'uv sync --frozen && make kdist-build'
  touch "$MARKER"
  echo "[kontrol-node] build complete."
else
  echo "[kontrol-node] kdist already built ($MARKER present); skipping build."
fi

echo "[kontrol-node] ready."
