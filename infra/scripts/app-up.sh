#!/usr/bin/env bash
# Run the whole P0 app in containers (prod-like): migrate (one-shot), api, worker, workspace behind Caddy.
# Needs: core stack up, `pnpm seed` done (.dev/zitadel.env and .dev/zitadel-api.env), images bos/api:dev and bos/workspace:dev built.
# Usage (repo root): bash infra/scripts/app-up.sh
set -euo pipefail
export WORKSPACE_UPSTREAM=workspace:3000 API_UPSTREAM=api:3001
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml "$@"; }
dc --profile core --profile app up -d --wait --wait-timeout 300
# pg_stat_statements: init-dbs.sh only runs on an empty volume, so a redeploy that keeps its database creates it here.
# As the superuser (the migrate role may not create extensions). A no-op when it exists.
dc exec -T postgres psql -U postgres -d bos -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null
# Caddy must pick up the in-compose upstreams.
dc --profile core up -d --force-recreate --no-deps caddy >/dev/null
ca=.dev/caddy-root.crt
r() { curl -s -o /dev/null -w '%{http_code}' --cacert "$ca" --resolve "$1:443:127.0.0.1" "https://$1$2"; }
for i in $(seq 1 30); do [ "$(r api.localhost /health/ready)" = 200 ] && break; sleep 2; done
echo "api  /health/live   $(r api.localhost /health/live)"
echo "api  /health/ready  $(r api.localhost /health/ready)"
echo "api  /v1/me (no token, expect 401)  $(r api.localhost /v1/me)"
echo "api  /metrics via Caddy (expect 404/403, blocked)  $(r api.localhost /metrics)"
echo "app  /healthz       $(r app.localhost /healthz)"
echo "app  / (expect 303/307 to login)  $(r app.localhost /)"
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
