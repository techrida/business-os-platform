#!/usr/bin/env bash
# Verify the running core stack: dev CA exported, OIDC issuer identical from the host and from inside
# the edge network, Postgres/Valkey/Mailpit reachable, and real memory use per container.
# Usage (repo root, stack up): bash infra/scripts/check-core.sh
set -euo pipefail
bash infra/scripts/export-dev-ca.sh >/dev/null
want=https://auth.localhost
host_iss=$(curl -s --cacert .dev/caddy-root.crt --resolve auth.localhost:443:127.0.0.1 "$want/.well-known/openid-configuration" | jq -r .issuer)
echo "issuer (host):      $host_iss"
in_iss=$(docker run --rm --network bos_edge -v "$PWD/.dev:/c:ro" -e NODE_EXTRA_CA_CERTS=/c/caddy-root.crt node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 \
  node -e "fetch('$want/.well-known/openid-configuration').then(r=>r.json()).then(j=>console.log(j.issuer)).catch(e=>{console.log('ERR '+e.cause?.code);})")
echo "issuer (container): $in_iss"
[ "$host_iss" = "$want" ] && [ "$in_iss" = "$want" ] || { echo "FAIL: issuer mismatch"; exit 1; }
timeout 2 bash -c '</dev/tcp/127.0.0.1/5432' && echo "postgres: reachable on 127.0.0.1:5432"
timeout 2 bash -c '</dev/tcp/127.0.0.1/6379' && echo "valkey:   reachable on 127.0.0.1:6379"
curl -sf --cacert .dev/caddy-root.crt --resolve mail.localhost:443:127.0.0.1 https://mail.localhost/readyz >/dev/null && echo "mailpit:  ready at https://mail.localhost"
echo; docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
echo "PASS: core stack"
