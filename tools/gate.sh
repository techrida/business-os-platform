#!/usr/bin/env bash
# The Business OS gate, one command: install, build, typecheck, lint, format check, tests.
#
#   tools/gate.sh            from anywhere inside the repo
#
# It runs exactly:
#   pnpm install --frozen-lockfile && pnpm -r --if-present build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
# plus two dev-tools exclusion checks (see below), but one step at a time, with a summary line per step, and it stops at the first failing step. A machine-wide
# lock (default /tmp/bos-gate.lock, override with BOS_GATE_LOCK) lets only one gate run on the machine: a second
# gate waits for the first, so units that share the machine stop producing timeouts for each other. The
# full output of every step goes to $BOS_GATE_LOG_DIR (default: a new directory under /tmp/bos-gate-logs).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${BOS_GATE_LOCK:-/tmp/bos-gate.lock}"

if [[ "${BOS_GATE_LOCKED:-}" != "1" ]]; then
  # Hold the lock on file descriptor 9 for the whole run; the kernel releases it when this process ends.
  command -v flock >/dev/null || { echo "gate: flock is not installed; cannot take the gate lock" >&2; exit 2; }
  exec 9>"$LOCK_FILE" || { echo "gate: cannot open $LOCK_FILE" >&2; exit 2; }
  if ! flock --nonblock 9; then
    echo "gate: another gate holds $LOCK_FILE; waiting for it" >&2
    flock 9 || { echo "gate: could not take the lock on $LOCK_FILE" >&2; exit 2; }
  fi
  export BOS_GATE_LOCKED=1
fi

LOG_DIR="$(realpath -m "${BOS_GATE_LOG_DIR:-/tmp/bos-gate-logs/$(date +%Y%m%d-%H%M%S)}")"
mkdir -p "$LOG_DIR"
cd "$REPO_ROOT"

echo "gate: $(git rev-parse --short HEAD 2>/dev/null || echo 'no git') in $REPO_ROOT; logs in $LOG_DIR"

total_start=$SECONDS

# One line per package from vitest's "Tests" summary, so the API suite (apps/api) is reported on its own.
test_summary() {
  grep -E '^[^ ]+ test: +Tests +' "$LOG_DIR/test.log" | sed -E 's/^([^ ]+) test: +Tests +/gate:   \1: /' || true
}

step() {
  local name="$1"
  shift
  local started=$SECONDS
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then
    printf 'gate: %-12s ok     %4ds\n' "$name" "$((SECONDS - started))"
    if [[ "$name" == "test" ]]; then test_summary; fi
  else
    local code=$?
    printf 'gate: %-12s FAILED %4ds (exit %d), see %s\n' "$name" "$((SECONDS - started))" "$code" "$LOG_DIR/$name.log"
    if [[ "$name" == "test" ]]; then test_summary; fi
    tail -n 25 "$LOG_DIR/$name.log" | sed 's/^/gate:   | /'
    printf 'gate: FAILED at %s after %ds\n' "$name" "$((SECONDS - total_start))"
    exit "$code"
  fi
}

# The workspace builds go to scratch folders (BOS_NEXT_DIST_DIR), never to the `.next` or `.next-devtools` that a
# dev server or a compiled devtools server may be using. The command is still `pnpm -r --if-present build`.
WORKSPACE_DIR="$REPO_ROOT/apps/workspace"
CHECKER="$WORKSPACE_DIR/scripts/check-no-dev-routes.mjs"

# Both directions of the dev-tools boundary: the production-profile build must hold no dev route, marker or run-time
# switch; a dev-profile build (compiled, BOS_BUILD_PROFILE=dev) must still carry the dev layer. The portal ships
# without dev tooling too. The dev build reuses the installed and built packages; only `next build` runs again.
dev_tools_boundary() {
  node "$CHECKER" "$WORKSPACE_DIR/.next-gate" || return $?
  BOS_BUILD_PROFILE=dev BOS_NEXT_DIST_DIR=.next-gate-devtools pnpm --filter @bos/workspace build || return $?
  node "$CHECKER" --profile dev "$WORKSPACE_DIR/.next-gate-devtools" || return $?
  node "$CHECKER" "$REPO_ROOT/apps/portal/.next"
}

# Tracked files must be fit for a public repository (no internal files or private paths; AGPL license fields).
public_repo_check() {
  node --test tools/check-public-repo.test.mjs infra/pnpm-bootstrap.test.mjs tools/qa-workflow.test.mjs && node tools/check-public-repo.mjs
}

step install pnpm install --frozen-lockfile
step build env BOS_BUILD_PROFILE=production BOS_NEXT_DIST_DIR=.next-gate pnpm -r --if-present build
step dev-tools dev_tools_boundary
step public-repo public_repo_check
step typecheck pnpm typecheck
step lint pnpm lint
step format:check pnpm format:check
step test pnpm test

printf 'gate: all steps passed in %ds\n' "$((SECONDS - total_start))"
