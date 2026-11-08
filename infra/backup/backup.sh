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
# The backup-scheduler service (infra/backup/backup-scheduler.sh) runs it on a timer: incr daily, full weekly.
# Between backups, Postgres keeps shipping its write-ahead log (WAL) to the same repository by itself
# (archive_command in infra/postgres/postgresql.conf), which is what allows restoring to a point in time.
set -euo pipefail

TYPE="${1:-full}"
case "$TYPE" in
  full | diff | incr) ;;
  *) echo "usage: backup.sh [full|diff|incr]" >&2; exit 2 ;;
esac

# Two ways to run this script:
#   - from the host (default): it reaches the postgres container through `docker compose exec`.
#   - inside the backup-scheduler container (BOS_BACKUP_IN_CONTAINER=1, set by compose.yaml): there is no docker
#     there, and the container already is the postgres OS user with the data directory and repository mounted, so
#     pgBackRest is called directly.
IN_CONTAINER="${BOS_BACKUP_IN_CONTAINER:-}"

if [[ -z "$IN_CONTAINER" ]]; then
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
  in_pg() { compose exec -T -u postgres postgres "$@"; }
else
  in_pg() { "$@"; }
fi

pgbr() { in_pg pgbackrest --stanza=bos "$@"; }

# The repository is encrypted (repo1-cipher-type in infra/postgres/pgbackrest.conf). pgBackRest cannot switch an
# existing stanza from plain to encrypted, and its own error for that is cryptic. An encrypted pgBackRest file starts
# with the 8 bytes "Salted__"; a plain backup.info is text. Exit code 3 from the check below means "plain repository".
# (Skipped when the repository has no backup.info yet, i.e. a fresh repository: stanza-create makes it encrypted.)
check_rc=0
in_pg sh -c '
  f=/var/lib/pgbackrest/backup/bos/backup.info
  [ -n "${PGBACKREST_REPO1_CIPHER_PASS:-}" ] && [ -f "$f" ] && [ "$(head -c 8 "$f")" != "Salted__" ] && exit 3
  exit 0' || check_rc=$?
if [[ $check_rc -eq 3 ]]; then
  cat >&2 <<'MSG'
backup: the pgBackRest repository was created WITHOUT encryption, but PGBACKREST_REPO1_CIPHER_PASS is set, so it
backup: cannot be used any more (and WAL archiving is failing). pgBackRest cannot encrypt an existing stanza.
backup: Start a fresh repository (the old, unencrypted backups are discarded):
backup:   1. pnpm stack:down
backup:   2. docker volume rm bos_pgbackrest-repo
backup:   3. pnpm stack:up, then run this script again
backup: The database itself (volume pgdata) is not touched by these steps.
MSG
  exit 1
elif [[ $check_rc -ne 0 ]]; then
  echo "backup: could not inspect the repository (exit $check_rc)" >&2
  exit 1
fi

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
