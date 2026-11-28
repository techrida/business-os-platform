#!/usr/bin/env bash
# Seeds the perf rows of db-reads.sql into a dev stack's Postgres (see that file for what it adds).
# Usage (repo root, stack up with the `core` profile):  bash perf/seed/seed-db-reads.sh
# Override how psql is reached with PERF_SEED_PSQL, for example
#   PERF_SEED_PSQL='psql postgresql://bos_owner:...@localhost:5432/bos' bash perf/seed/seed-db-reads.sh
# Extra psql arguments (-v tenant_id=<uuid> -v org_id=<uuid>) follow the script name.
set -euo pipefail
cd "$(dirname "$0")/../.."
psql_cmd=${PERF_SEED_PSQL:-"docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml exec -T postgres psql -U postgres -d bos"}
# shellcheck disable=SC2086
$psql_cmd -v tenant_id= -v org_id= "$@" < perf/seed/db-reads.sql
