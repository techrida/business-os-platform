#!/usr/bin/env bash
# One-time dev machine setup for Business OS on Ubuntu (WSL2 or a real Linux box).
# Installs: native Docker engine + compose v2 + buildx (needs sudo), Node 24 via fnm, pnpm 11 (from infra/pnpm-bootstrap).
# Safe to re-run. Usage: bash infra/scripts/dev-machine-setup.sh [--no-docker]
set -euo pipefail

if [[ "${1:-}" != "--no-docker" ]] && ! command -v /usr/bin/docker >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 docker-buildx
  sudo usermod -aG docker "$USER"
  sudo systemctl enable --now docker
  echo "docker installed; open a new shell for the docker group to apply"
fi

command -v unzip >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip; }

if ! command -v fnm >/dev/null && [[ ! -x "$HOME/.local/share/fnm/fnm" ]]; then
  # Pinned release, checked against a recorded SHA-256 (the installer is not piped into a shell). Bump both together; Dependabot cannot.
  FNM_VERSION=v1.39.0
  FNM_SHA256=7807664f39d39fc518da1c35ba0181e4b3267603c4b1dedeb4b5fc6ae440a224
  fnm_tmp=$(mktemp -d)
  for i in 1 2 3; do
    if curl -fsSL --retry 3 -o "$fnm_tmp/fnm-linux.zip" "https://github.com/Schniz/fnm/releases/download/$FNM_VERSION/fnm-linux.zip" \
      && echo "$FNM_SHA256  $fnm_tmp/fnm-linux.zip" | sha256sum --check --status; then
      mkdir -p "$HOME/.local/share/fnm"
      unzip -oq "$fnm_tmp/fnm-linux.zip" -d "$HOME/.local/share/fnm"
      chmod +x "$HOME/.local/share/fnm/fnm"
      break
    fi
    sleep 5
  done || true
  rm -rf "$fnm_tmp"
fi
if [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env --shell bash)"
  fnm install 24
  fnm default 24
else
  # Fallback: official Node 24 tarball from nodejs.org into ~/.local/node
  ver=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v24\.[0-9.]*"' | head -1 | cut -d'"' -f4)
  mkdir -p "$HOME/.local/node"
  curl -fsSL --retry 3 "https://nodejs.org/dist/$ver/node-$ver-linux-x64.tar.xz" | tar -xJ -C "$HOME/.local/node" --strip-components=1
  export PATH="$HOME/.local/node/bin:$PATH"
fi
# Node 24 is NOT put on the global PATH (other projects may pin other Node versions).
# Run `source infra/scripts/env.sh` in each shell before working on Business OS.

# pnpm from the lockfile in infra/pnpm-bootstrap (integrity hashes), not an unpinned global install.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
npm ci --prefix "$repo_root/infra/pnpm-bootstrap" --ignore-scripts
# env.sh puts that folder on PATH (run it from the repo root); no symlink into ~/.local/bin.
export PATH="$repo_root/infra/pnpm-bootstrap/node_modules/.bin:$PATH"
echo "node $(node -v), pnpm $(pnpm -v), docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'needs new shell')"
