#!/usr/bin/env bash
# Run as a host command with the disposable compose project selected.
set -euo pipefail
: "${BOS_PERF_STORAGE_ROOT:?Set the fixture storage root}"
: "${BOS_PERF_DB_URL:?Set the fixture database URL}"
: "${COMPOSE_PROJECT_NAME:?Select your throwaway compose project}"
case "$COMPOSE_PROJECT_NAME" in bos-testrun|bos) exit 2;; esac
for script in "$@"; do
  [[ "$script" =~ ^[a-z0-9-]+$ && -f "perf/k6/$script.js" ]] || exit 2
done
(( $# > 0 )) || exit 2
cleanup() {
  docker compose stop api worker &&
    pnpm --filter @bos/api exec tsx test/perf-data/cli.ts cleanup
}
trap 'rc=$?; cleanup || exit 1; exit "$rc"' EXIT
result=0
for script in "$@"; do
  started=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
  docker compose run --rm -T --user "$(id -u):$(id -g)" -e K6_PERF_DURATION -e K6_PERF_RATE \
    -e K6_APPROVE_P95_MS -e K6_PREVIEW_P95_MS -e K6_WRITE_P95_MS \
    -v "${BOS_PERF_MANIFEST:-$BOS_PERF_STORAGE_ROOT/perf-manifest.json}:/perf-manifest.json:ro" \
    k6 run "/perf/$script.js" || result=1
  case "$script" in
    sales|approvals|money)
      docker compose logs --no-log-prefix --since "$started" api | node perf/k6/backend-summary.mjs "$script" || result=1 ;;
  esac
  if [[ "$script" == money ]]; then
    # Read only this run's docs.scan events from the disposable worker's queue.
    docker compose exec -T worker node -e '
      const Redis = require("ioredis");
      const db = new Redis(process.env.VALKEY_URL);
      db.xrange("bull:docs.scan:events", Date.parse(process.argv[1]) + "-0", "+")
        .then(events => console.log(JSON.stringify(events)))
        .finally(() => db.disconnect());
    ' "$started" | node perf/k6/scan-times.mjs || result=1
  fi
  if [[ "$script" == sales ]]; then
    pnpm --filter @bos/api exec tsx test/perf-data/cli.ts pdf-times "$started" || result=1
  fi
done
exit "$result"
