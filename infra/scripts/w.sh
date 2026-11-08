#!/usr/bin/env bash
# Run a Business OS command inside the WSL dev clone with the project's Node 24 + pnpm.
# From Windows:  wsl -d Ubuntu -e bash /mnt/f/Projects/Techrida/Business-OS/business-os-platform/infra/scripts/w.sh [--branch B] "<cmd>"
# Clones the repo on first use, fast-forwards the given branch, then runs <cmd> at the repo root.
set -euo pipefail
REPO="$HOME/src/business-os-platform"
BRANCH=""
if [[ "${1:-}" == "--branch" ]]; then BRANCH="$2"; shift 2; fi
if [[ ! -d "$REPO/.git" ]]; then
  mkdir -p "$(dirname "$REPO")"
  # Local source of truth on the Windows dev machine (no credentials needed); GitHub is pushed from Windows.
  git clone -q /mnt/f/Projects/Techrida/Business-OS/business-os-platform "$REPO"
fi
cd "$REPO"
if [[ -n "$BRANCH" ]]; then
  # The WSL clone is a mirror: commits are made on Windows. Reset tracked files to the branch
  # (untracked .env and .dev/ are kept). A changed lockfile is copied back by hand when needed.
  git fetch -q origin "$BRANCH"
  git checkout -q -f -B "$BRANCH" "origin/$BRANCH"
  git reset -q --hard "origin/$BRANCH"
fi
# shellcheck disable=SC1091
source infra/scripts/env.sh
echo "[w] $(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD) node $(node -v) pnpm $(pnpm -v)"
bash -c "$*"
