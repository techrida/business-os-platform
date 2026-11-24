# Source this before running Business OS commands in WSL:  source infra/scripts/env.sh
# It puts the project's Node 24 + pnpm 11 first on PATH for this shell only, so other
# projects on the same machine (for example a different Node version in ~/.local/bin) are untouched.
if [ -x "$HOME/.local/share/fnm/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env --shell bash)" && fnm use --silent-if-unchanged 24 >/dev/null 2>&1
elif [ -x "$HOME/.local/node/bin/node" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi
# pnpm comes from infra/pnpm-bootstrap (lockfile install by dev-machine-setup.sh).
[ -d "$PWD/infra/pnpm-bootstrap/node_modules/.bin" ] && export PATH="$PWD/infra/pnpm-bootstrap/node_modules/.bin:$PATH"
[ -f "$PWD/.dev/caddy-root.crt" ] && export NODE_EXTRA_CA_CERTS="$PWD/.dev/caddy-root.crt"
true
