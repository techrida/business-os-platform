#!/usr/bin/env bash
# `pnpm stack:nuke`: stop the stack and delete ALL its Docker volumes. Refuses unless BOS_CONFIRM_NUKE=yes.
#
#   BOS_CONFIRM_NUKE=yes pnpm stack:nuke
#
# Why the guard: the database (volume pgdata) and its backups (volume pgbackrest-repo) live on the same host and are
# both removed here, so there is nothing left to restore from afterwards. `pnpm stack:down` stops the stack and keeps
# every volume; use that first. To drop only the database but keep the backups, remove the one volume by hand.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [[ "${BOS_CONFIRM_NUKE:-}" != "yes" ]]; then
  cat >&2 <<'MSG'
stack:nuke refused. It would DELETE, with no way back:
  - the database (volume bos_pgdata): Business OS data and ZITADEL's users, sessions and keys
  - the backups (volume bos_pgbackrest-repo): every pgBackRest backup and archived WAL file
  - the other stack volumes (valkey data, ZITADEL bootstrap tokens, Caddy's local CA)
Try `pnpm stack:down` (keeps all volumes) first. If you really mean it:
  BOS_CONFIRM_NUKE=yes pnpm stack:nuke
MSG
  exit 1
fi

echo "stack:nuke: BOS_CONFIRM_NUKE=yes, deleting the stack and all its volumes (database AND backups)" >&2
exec docker compose --env-file .env \
  -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  --profile core --profile app --profile tools down --volumes --remove-orphans
