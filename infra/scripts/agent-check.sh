#!/usr/bin/env bash
# Focused check for a subagent: copy the Windows worktree (minus node_modules) into a scratch dir in WSL,
# give it its own node_modules from the pnpm store, run ONE light command, then delete the scratch dir.
# Usage (from Windows):
#   wsl -d Ubuntu -e bash /mnt/f/Projects/Techrida/Business-OS/bos-p0/infra/scripts/agent-check.sh <unit> "<cmd>"
# Example: ... agent-check.sh u4a "pnpm --filter @bos/api exec vitest run src/platform/auth"
# Only for light checks (one test file / a folder of unit tests / eslint of named files). Builds, full suites,
# docker and e2e are the lead's job.
set -euo pipefail
UNIT="${1:?unit name}"; CMD="${2:?command}"
SRC=/mnt/f/Projects/Techrida/Business-OS/bos-p0
CLONE="$HOME/src/business-os-platform"
DIR="/var/tmp/agents-$UNIT"
trap 'rm -rf "$DIR"' EXIT
rm -rf "$DIR"; mkdir -p "$DIR"
( cd "$SRC" && tar --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git -cf - . ) | tar -xf - -C "$DIR"
# Own node_modules for the scratch copy: an offline install hard-links from the shared pnpm store
# (seconds, no network). Never symlink the dev clone's node_modules: pnpm commands run here would
# rewrite the clone's workspace links to point at this scratch dir (seen 2026-11-08).
( cd "$DIR" && source infra/scripts/env.sh && pnpm install --frozen-lockfile --offline --reporter=silent )   || ( cd "$DIR" && source infra/scripts/env.sh && pnpm install --frozen-lockfile --prefer-offline --reporter=silent )
cd "$DIR"
# shellcheck disable=SC1091
source infra/scripts/env.sh
bash -c "$CMD"
