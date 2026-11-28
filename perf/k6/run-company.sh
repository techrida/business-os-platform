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
run_k6() {
  docker compose run --rm -T --user "$(id -u):$(id -g)" -e K6_PERF_DURATION -e K6_PERF_RATE \
    -e K6_APPROVE_P95_MS -e K6_PREVIEW_P95_MS -e K6_WRITE_P95_MS \
    -e K6_PROCUREMENT_SEED="${2:-0}" \
    -v "${BOS_PERF_MANIFEST:-$BOS_PERF_STORAGE_ROOT/perf-manifest.json}:/perf-manifest.json:ro" \
    k6 run "/perf/$1.js"
}
result=0
for script in "$@"; do
  if [[ "$script" == procurement && "${BOS_PERF_SCALE:-}" == procurement ]]; then
    run_k6 procurement 1
    pnpm --filter @bos/api exec tsx test/perf-data/cli.ts procurement-ready
  fi
  started=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
  run_k6 "$script" || result=1
  if [[ "$script" == procurement ]]; then
    docker compose cp perf/k6/percentile.cjs worker:/tmp/percentile.cjs
    docker compose cp perf/k6/procurement-jobs.cjs worker:/tmp/procurement-jobs.cjs
    docker compose exec -T worker node /tmp/procurement-jobs.cjs "$started" || result=1
  fi
  case "$script" in
    sales|approvals|money|platform|procurement)
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
  if [[ "$script" == platform ]]; then
    manifest=${BOS_PERF_MANIFEST:-$BOS_PERF_STORAGE_ROOT/perf-manifest.json}
    # The job event stream retains both endpoints even after BullMQ evicts a completed job.
    for file in platform-scan-report.mjs scan-times.mjs percentile.cjs; do
      docker compose cp "perf/k6/$file" "api:/tmp/$file"
    done
    docker compose exec -T api node /tmp/platform-scan-report.mjs "$started" \
      "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).tenantId' "$manifest")" \
      "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).organizationId' "$manifest")" || result=1
  fi
  if [[ "$script" == sales ]]; then
    pnpm --filter @bos/api exec tsx test/perf-data/cli.ts pdf-times "$started" || result=1
  fi
done
exit "$result"
