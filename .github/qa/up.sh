#!/usr/bin/env bash
# Brings up the whole Business OS stack on a GitHub-hosted runner, the way local dev does (README, infra/compose):
# containers (postgres, valkey, ZITADEL + login image, Caddy, mailpit, gotenberg, clamav), compiled api, worker,
# workspace (devtools profile) and portal on the host behind Caddy, seeded dev personas.
# Needs: repo root as cwd, Node 24, pnpm, docker. Secrets are generated here and live only on this runner.
set -euo pipefail
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f .github/qa/compose.qa.yaml "$@"; }
step() { echo "::group::$*"; }
end() { echo "::endgroup::"; }
t0=$(date +%s)
lap() { echo "qa-up: $1 at +$(( $(date +%s) - t0 )) s"; }

step "env, hosts"
bash infra/scripts/make-dev-env.sh
# The example line for the Postal webhook secret is empty and config validation refuses an empty value.
sed -i "s/^POSTAL_WEBHOOK_SECRET=\$/POSTAL_WEBHOOK_SECRET=$(openssl rand -hex 16)/" .env
# Node and curl resolve *.localhost through /etc/hosts here; Chromium does it by itself.
echo "127.0.0.1 app.localhost auth.localhost api.localhost mail.localhost portal.localhost" | sudo tee -a /etc/hosts >/dev/null
mkdir -p .dev
end

step "containers (core + files), images build in the background"
if [[ ${1:-} == restore ]]; then bash .github/qa/snapshot.sh restore; fi
dc --profile core --profile files up -d --no-deps postgres valkey valkey-oidc mailpit zitadel-api clamav > .dev/compose-up.log 2>&1 &
echo $! > .dev/compose-up.pid
end

step "build workspace packages"
if [[ ${1:-} != restore || $(cat .dev/qa-build-revision) != "$GITHUB_SHA" ]]; then
  pnpm -r --filter '@bos/api...' --filter '@bos/workspace^...' --filter '@bos/portal^...' --filter '@bos/seed-zitadel...' --if-present build
fi
lap "packages built"
end

step "wait for containers"
wait "$(cat .dev/compose-up.pid)" || { cat .dev/compose-up.log; exit 1; }
# Login image and Caddy start once zitadel-api is healthy (depends_on); gotenberg is in the app profile.
dc --profile core --profile files --profile app up -d --wait --wait-timeout 600 --no-recreate postgres valkey valkey-oidc mailpit zitadel-api zitadel-login caddy clamav gotenberg
dc ps
lap "containers healthy"
end

step "CA, migrate, seed"
bash infra/scripts/export-dev-ca.sh
if [[ ${1:-} != restore ]]; then
  bash infra/scripts/migrate-dev.sh
  dc --profile tools run --rm seed-zitadel
  docker cp "$(dc ps -q zitadel-api)":/zitadel/admin/admin.pat .dev/admin.pat
  set -a; source .dev/zitadel.env; set +a
  NODE_ENV=development NODE_EXTRA_CA_CERTS="$PWD/.dev/caddy-root.crt" \
    BOS_DEV_BOOTSTRAP_TOKEN_FILE=.dev/admin.pat BOS_DEV_LOGIN_CLIENT_TOKEN_FILE=.dev/login-client.pat \
    OIDC_ISSUER=https://auth.localhost node infra/scripts/dev-login-client.mjs >/dev/null
  chmod 600 .dev/*.pat .dev/personas.json 2>/dev/null || true
fi
lap "database ready"
end

step "demo fixtures"
if [[ ${1:-} != restore ]]; then
  dc exec -T postgres psql -U postgres -d bos -v ON_ERROR_STOP=1 -P pager=off < .github/qa/demo-data.sql
fi
end

step "register secrets as masked"
# Every persona password and TOTP secret is masked in this job's log, whatever prints it.
node -e "
const fs=require('fs');
const list=JSON.parse(fs.readFileSync('.dev/personas.json','utf8'));
for (const entry of list) for (const k of ['password','totpSecret']) if (typeof entry[k]==='string' && entry[k].length>=8) console.log('::add-mask::'+entry[k]);
"
end

step "start api, worker, workspace (devtools build), portal"
set -a; source .env; source .dev/zitadel.env; set +a
export NEXT_TELEMETRY_DISABLED=1 NODE_EXTRA_CA_CERTS="$PWD/.dev/caddy-root.crt"
export BOS_DEV_PERSONAS_FILE="$PWD/.dev/personas.json" BOS_DEV_LOGIN_CLIENT_TOKEN_FILE="$PWD/.dev/login-client.pat"
export SMTP_URL=smtp://127.0.0.1:1025 FILES_ROOT="$PWD/.dev/files" CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310
export GOTENBERG_URL=http://127.0.0.1:3300 API_INTERNAL_URL=http://127.0.0.1:3001
# compose.dev.yaml sets this on the containerised workspace: 20 logins per minute per IP is too few for a parallel sign-in run.
export BOS_DEV_LOGIN_RATE_LIMIT=200
export ZITADEL_API_URL=https://auth.localhost BOS_DEV_IDENTITY_API_URL=https://auth.localhost
export DATABASE_URL="${DATABASE_URL/@postgres:/@127.0.0.1:}" VALKEY_URL="${VALKEY_URL/@valkey:/@127.0.0.1:}"
mkdir -p .dev/files .dev/logs

# Both Next apps are built after the API is up: ZITADEL's webhook target is the API on :3001.
# zitadel-api.env (provisioner token, signing key) is loaded inside these two subshells only: the web apps below never see it.
(set -a; source .dev/zitadel-api.env; set +a; NODE_ENV=development node apps/api/dist/main.js > .dev/logs/api.log 2>&1 &)
(set -a; source .dev/zitadel-api.env; set +a; NODE_ENV=development METRICS_PORT=3339 node apps/api/dist/worker.js > .dev/logs/worker.log 2>&1 &)
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --cacert .dev/caddy-root.crt https://api.localhost/health/ready || true)" = 200 ] && break
  sleep 3
done
curl -sf --cacert .dev/caddy-root.crt https://api.localhost/health/ready >/dev/null || { tail -50 .dev/logs/api.log; exit 1; }
lap "api ready"

if [[ ${1:-} != restore || $(cat .dev/qa-build-revision) != "$GITHUB_SHA" ]]; then
  (cd apps/workspace && BOS_BUILD_PROFILE=dev NODE_ENV=production node node_modules/next/dist/bin/next build > ../../.dev/logs/workspace-build.log 2>&1) &
  wbuild=$!
  (cd apps/portal && NODE_ENV=production node node_modules/next/dist/bin/next build > ../../.dev/logs/portal-build.log 2>&1) &
  pbuild=$!
  wait $wbuild || { tail -60 .dev/logs/workspace-build.log; exit 1; }
  wait $pbuild || { tail -60 .dev/logs/portal-build.log; exit 1; }
  lap "next builds done"
fi
(cd apps/workspace && NODE_ENV=production BOS_BUILD_PROFILE=dev node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000 > ../../.dev/logs/workspace.log 2>&1 &)
(cd apps/portal && set -a && { [ ! -f ../../.dev/zitadel-portal.env ] || source ../../.dev/zitadel-portal.env; } && set +a && NODE_ENV=production SESSION_ENC_KEY="$PORTAL_SESSION_ENC_KEY" SESSION_ENC_KEY_ID="$PORTAL_SESSION_ENC_KEY_ID" \
  OIDC_REDIRECT_URI="$PORTAL_PUBLIC_URL/auth/callback" node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3002 > ../../.dev/logs/portal.log 2>&1 &)
for host in app portal; do
  path=/healthz; [ "$host" = portal ] && path=/healthz
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --cacert .dev/caddy-root.crt "https://$host.localhost$path" || true)
    [ "$code" = 200 ] && break
    sleep 3
  done
  echo "$host.localhost$path -> $code"
done
lap "stack up"
end
