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

if ! command -v fnm >/dev/null && [[ ! -x "$HOME/.local/share/fnm/fnm" ]]; then
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
fi
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --shell bash)"
fnm install 24
fnm default 24
grep -q 'fnm env' "$HOME/.bashrc" || {
  echo 'export PATH="$HOME/.local/share/fnm:$PATH"'
  echo 'eval "$(fnm env --use-on-cd --shell bash)"'
} >> "$HOME/.bashrc"

npm install -g pnpm@11
echo "node $(node -v), pnpm $(pnpm -v), docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'needs new shell')"
