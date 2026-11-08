#!/usr/bin/env bash
# One-time dev machine setup for Business OS on Ubuntu (WSL2 or a real Linux box).
# Installs: native Docker engine + compose v2 + buildx (needs sudo), Node 24 via fnm, pnpm 11.
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
  for i in 1 2 3; do curl -fsSL --retry 3 https://fnm.vercel.app/install | bash -s -- --skip-shell && break; sleep 5; done || true
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

npm install -g pnpm@11
echo "node $(node -v), pnpm $(pnpm -v), docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'needs new shell')"
