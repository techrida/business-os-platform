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
for script in "$@"; do
  docker compose run --rm -T -e K6_PERF_DURATION -e K6_PERF_RATE \
    -v "${BOS_PERF_MANIFEST:-$BOS_PERF_STORAGE_ROOT/perf-manifest.json}:/perf-manifest.json:ro" \
    k6 run "/perf/$script.js"
done
