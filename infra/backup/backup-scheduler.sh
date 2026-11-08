#!/usr/bin/env bash
# Scheduled backups. Runs as the main process of the `backup-scheduler` compose service (profile `core`); it is
# not meant to be started by hand.
#
#   one backup at startup  an `incr`: pgBackRest turns it into a full when the repository is empty. This also
#                          creates the stanza at once, so WAL archiving starts working and a broken setup
#                          (e.g. an unencrypted old repository) shows up in the container log right away.
#   every day  02:00 UTC   `incr` (changes since the last backup of any kind)
#   every Sunday 02:00 UTC `full` (Sunday starts a new restore chain; retention counts fulls, see pgbackrest.conf)
#
# The work itself is infra/backup/backup.sh, the same script a person runs, in its in-container mode.
# A failed backup is logged loudly ("FAILED") and the loop carries on: the next slot retries. Watch the logs with
#   docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml logs backup-scheduler
# BACKUP_HOUR_UTC (00-23, default 02) moves the slot.
set -uo pipefail

export BOS_BACKUP_IN_CONTAINER=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOUR="${BACKUP_HOUR_UTC:-02}"
[[ "$HOUR" =~ ^([01][0-9]|2[0-3])$ ]] || { echo "backup-scheduler: BACKUP_HOUR_UTC must be 00-23, got '$HOUR'" >&2; exit 2; }

log() { echo "[backup-scheduler] $(date -u +%FT%TZ) $*" >&2; }

run_backup() {
  local type="$1"
  log "starting a $type backup"
  if bash "$HERE/backup.sh" "$type"; then
    log "$type backup OK"
  else
    log "FAILED: the $type backup did not finish (exit $?). Next attempt at the next slot."
  fi
}

# The socket exists as soon as Postgres is up (compose also waits for the postgres healthcheck).
until pg_isready -q -h /var/run/postgresql; do
  log "waiting for postgres"
  sleep 5
done

run_backup incr

while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "today ${HOUR}:00:00" +%s)"
  (( next > now )) || next=$(( next + 86400 ))
  log "next backup at $(date -u -d "@$next" +%FT%TZ)"
  sleep $(( next - now ))
  if [[ "$(date -u +%u)" == "7" ]]; then run_backup full; else run_backup incr; fi
done
