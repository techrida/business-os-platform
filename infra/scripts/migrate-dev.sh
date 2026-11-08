#!/usr/bin/env bash
# Apply database migrations from the host against the dev stack (Postgres published on 127.0.0.1:5432).
# Uses DATABASE_MIGRATE_URL from .env and points its host at 127.0.0.1 when it names the compose service.
# Usage (repo root, stack up): bash infra/scripts/migrate-dev.sh
set -euo pipefail
set -a; # shellcheck disable=SC1091
source .env; set +a
export DATABASE_MIGRATE_URL="${DATABASE_MIGRATE_URL/@postgres:/@127.0.0.1:}"
pnpm --filter @bos/contracts --filter @bos/db build >/dev/null
node packages/db/dist/migrate.js
DATABASE_MIGRATE_URL="$DATABASE_MIGRATE_URL" node packages/db/dist/check-tenancy.js
