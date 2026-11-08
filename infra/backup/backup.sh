#!/usr/bin/env bash
# Takes a pgBackRest backup of the running `postgres` service.
#
#   bash infra/backup/backup.sh [full|diff|incr]      (default: full)
#
#   full  a complete copy of the cluster (every database, including ZITADEL's)
#   diff  only what changed since the last full backup
#   incr  only what changed since the last backup of any kind
#
# Run it from anywhere; it moves to the repo root first. Needs the stack up (`pnpm stack:up`) and a .env file.
# Between backups, Postgres keeps shipping its write-ahead log (WAL) to the same repository by itself
# (archive_command in infra/postgres/postgresql.conf), which is what allows restoring to a point in time.
set -euo pipefail

TYPE="${1:-full}"
case "$TYPE" in
  full | diff | incr) ;;
  *) echo "usage: backup.sh [full|diff|incr]" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

[[ -f .env ]] || { echo "backup: .env not found in $(pwd). Copy .env.example to .env first." >&2; exit 1; }

# Run from the repo root. The compose project directory is infra/compose (the default), so .env is passed explicitly.
compose() {
  docker compose --env-file .env \
    -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
    --profile core "$@"
}

if ! compose ps --status running --services | grep -qx postgres; then
  echo "backup: the postgres service is not running. Start it with: pnpm stack:up" >&2
  exit 1
fi

# pgBackRest must run as the postgres OS user inside the container: it reads the data directory directly.
pgbr() { compose exec -T -u postgres postgres pgbackrest --stanza=bos "$@"; }

echo "[backup] creating the stanza (does nothing if it already exists)" >&2
# Until this has run once, Postgres cannot archive WAL (archive_command fails and WAL piles up in pg_wal);
# afterwards the queued WAL is archived on its own. stanza-create is safe to repeat.
pgbr stanza-create

echo "[backup] checking that WAL archiving works" >&2
# `check` forces a WAL switch and waits until the file shows up in the repository.
pgbr check

echo "[backup] taking a $TYPE backup" >&2
pgbr --type="$TYPE" backup

echo "[backup] repository now holds:" >&2
pgbr info
