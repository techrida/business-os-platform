#!/usr/bin/env bash
# Copies Caddy's local root certificate out of the running caddy container to .dev/caddy-root.crt.
# Node processes use it through NODE_EXTRA_CA_CERTS; trust-dev-ca.ps1 imports it into Windows.
# Needs the core stack to be up (`pnpm stack:up`). Safe to re-run.
# Note: if the caddy-data volume is wiped, Caddy creates a NEW root CA: run this again and trust it again.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
out=".dev/caddy-root.crt"
src="/data/caddy/pki/authorities/local/root.crt"

cid="$(docker ps -q \
  --filter "label=com.docker.compose.project=bos" \
  --filter "label=com.docker.compose.service=caddy" | head -n 1)"
if [[ -z "$cid" ]]; then
  echo "export-dev-ca: the caddy container of project 'bos' is not running. Run: pnpm stack:up" >&2
  exit 1
fi

mkdir -p .dev
rm -f "$out" # never leave an old certificate behind if the copy fails
# Caddy writes the root CA when it loads its first "tls internal" site, so allow a short wait.
for _ in $(seq 1 30); do
  if docker cp "$cid:$src" "$out" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ ! -s "$out" ]]; then
  echo "export-dev-ca: no root certificate at $src after 30 s. Check: docker logs $cid" >&2
  exit 1
fi

# A CA certificate is public. It must be world-readable: containers that run as non-root users
# (k6, node) mount it read-only and fail TLS with "permission denied" otherwise.
chmod 644 "$out"

if command -v openssl >/dev/null; then
  openssl x509 -in "$out" -noout -subject -enddate -fingerprint -sha256
fi
echo "export-dev-ca: wrote $out"
