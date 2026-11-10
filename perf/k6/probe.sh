#!/usr/bin/env bash
# Diagnose k6 -> Caddy connectivity: one request to the OIDC discovery doc from inside the k6 image
# on the edge network, printing status and the network/TLS error if any. Usage (repo root, stack up):
#   bash perf/k6/probe.sh
set -euo pipefail
tmp=$(mktemp -d /var/tmp/agents-k6probe.XXXX); trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"   # the k6 image runs as a non-root user
cat > "$tmp/t.js" <<'JS'
import http from 'k6/http';
export default function () {
  for (const u of ['https://auth.localhost/.well-known/openid-configuration', 'https://api.localhost/health/live']) {
    const r = http.get(u);
    console.log(`${u} status=${r.status} error=${r.error} code=${r.error_code}`);
  }
}
JS
chmod 644 "$tmp/t.js"
docker run --rm --network bos_edge -v "$tmp:/t:ro" -v "$PWD/.dev:/certs:ro" \
  -e SSL_CERT_FILE=/certs/caddy-root.crt grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8 run --quiet --iterations 1 /t/t.js 2>&1 \
  | grep -E 'status=|level=error' | sed 's/^.*msg="//; s/" source=console$//'
