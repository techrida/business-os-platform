#!/usr/bin/env bash
# Restore drill: proves that a backup can really be restored, and times it (the RTO evidence).
#
#   bash infra/backup/restore-drill.sh          (or: pnpm drill)
#
# Output: progress goes to stderr; stdout carries exactly one JSON line, the last line:
#   {"result":"pass","rto_seconds":N}     exit code 0
#   {"result":"fail","step":"<where>"}    exit code non-zero
#
# Needs the `core` stack running, seeded (`pnpm seed`, so app.organizations has rows), and a .env file.
#
# What the `restore-drill` service in infra/compose/compose.yaml must provide (it does today):
#   - image bos/postgres:16 (has pgbackrest and postgres), entrypoint /bin/bash, user postgres
#   - volume pgbackrest-repo at /var/lib/pgbackrest (read-only is enough: a restore only reads it)
#   - a volume pgdata-drill at /var/lib/postgresql/data (the restore target; never the live pgdata).
#     The script empties it before and after, so a leftover from an earlier run cannot fake a pass.
#   - pgbackrest.conf mounted at /etc/pgbackrest/pgbackrest.conf
# The live database is only touched to write the canary row and to take the backup (an incr, never a full, so a
# drill does not shorten the history of restore points).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

STEP="preflight"
CLEAN_NEEDED=""

log() { echo "[drill] $*" >&2; }

# Run from the repo root. The compose project directory is infra/compose (the default), so .env is passed explicitly.
compose() {
  docker compose --env-file .env \
    -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
    --profile core --profile tools "$@"
}

# Empties the drill volume. Runs as the postgres user inside the drill image, so ownership is never an issue.
# Only the pgdata-drill volume is touched: no `down -v`, so the live stack's volumes are never at risk.
wipe_drill_volume() {
  compose run --rm -T restore-drill -c 'find /var/lib/postgresql/data -mindepth 1 -delete' >&2
}

on_exit() {
  local code=$?
  trap - EXIT
  if [[ -n "$CLEAN_NEEDED" ]]; then
    log "cleaning up the drill volume"
    wipe_drill_volume || log "WARNING: could not empty the pgdata-drill volume (the next run empties it again)"
  fi
  if [[ $code -ne 0 ]]; then
    log "FAILED at step: $STEP"
    printf '{"result":"fail","step":"%s"}\n' "$STEP"
    exit "$code"
  fi
  exit 0
}
trap on_exit EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null || { log "docker is not installed"; exit 1; }
[[ -f .env ]] || { log ".env not found in $(pwd). Copy .env.example to .env first."; exit 1; }

# ---- 0. the runbook must list what a restore cannot recreate ------------------------------------------------------
# A restore of the database alone cannot log anyone in without ZITADEL_MASTERKEY (it decrypts ZITADEL's data),
# and .env holds the rest of the secrets. If the written procedure forgets them, the drill fails.
# The runbook lives outside the repo (Kuu's KB), so its path comes from RESTORE_RUNBOOK. Unset: the check is skipped.
STEP="runbook-check"
RUNBOOK="${RESTORE_RUNBOOK:-}"
if [[ -z "$RUNBOOK" ]]; then
  log "RESTORE_RUNBOOK not set: skipping the runbook check"
else
  [[ -f "$RUNBOOK" ]] || { log "$RUNBOOK is missing"; exit 1; }
  BACKUP_ITEMS="$(awk '/^## /{inside = ($0 ~ /^## What to back up/)} inside' "$RUNBOOK")"
  for item in ZITADEL_MASTERKEY '.env'; do
    grep -Fq -- "$item" <<<"$BACKUP_ITEMS" || {
      log "$RUNBOOK has no '$item' in its \"What to back up\" section"
      exit 1
    }
  done
fi

STEP="postgres-running"
compose ps --status running --services | grep -qx postgres || {
  log "the postgres service is not running. Start it with: pnpm stack:up"
  exit 1
}

# ---- 1. canary row ---------------------------------------------------------------------------------------------
# A row with a random id, written now, before the backup. After the restore it must be there.
STEP="canary"
CANARY_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
CANARY_ID="${CANARY_ID,,}"
[[ "$CANARY_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { log "could not make a uuid"; exit 1; }
log "writing canary row $CANARY_ID"
compose exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -q -d bos \
  -c "INSERT INTO ops.restore_canary (id, written_at) VALUES ('$CANARY_ID', now())" >&2

# ---- 2. incremental backup (never a full) ----------------------------------------------------------------------
# The restore below stops at the end of the newest backup (--type=immediate), so the canary row only comes back if a
# backup was taken AFTER it was written: an old backup cannot be reused. But it must not be a full: retention keeps
# 2 fulls (pgbackrest.conf), so every drill that took a full pushed a real restore point closer to expiry, and two
# drills in a row deleted the older one (CR-08). An incr never triggers expiry (incrementals expire with their full),
# and the restore then also proves that the full + incr chain restores. If the repository is empty pgBackRest
# promotes the incr to the first full by itself; that expires nothing. backup.sh runs stanza-create first, so this
# also works on a stack that was never backed up.
STEP="backup"
log "taking an incremental backup"
bash infra/backup/backup.sh incr >&2

# ---- 3. make sure the newest WAL is in the repository --------------------------------------------------------------
# `pgbackrest check` switches to a new WAL file and waits until it has been archived.
STEP="wal-archive"
log "switching WAL and waiting for the archive"
compose exec -T -u postgres postgres pgbackrest --stanza=bos check >&2

# ---- 4. restore into an empty volume, start the copy, check it ---------------------------------------------------------
STEP="prepare-drill-volume"
CLEAN_NEEDED=1
log "emptying the drill volume"
wipe_drill_volume

# Everything below runs in ONE throwaway container: restore, start a second Postgres from the restored files,
# ask it questions over a unix socket, stop it. When the container exits, that Postgres is gone with it.
# The restored server is started with archive_mode=off and no network: it must never push WAL into the live
# repository (it would start a new timeline there), and nothing can connect to it from outside.
# max_connections is left alone on purpose: a server recovering from a backup refuses to start with a lower
# value than the one the live server had when the backup was taken.
# The heredoc delimiter is quoted, so nothing in it is expanded here; the inner bash expands it.
INNER="$(cat <<'INNER_EOF'
set -euo pipefail
PGDATA=/var/lib/postgresql/data
LOG=/tmp/drill-postgres.log

# On any failure, show the end of the restored server's log: it is the first thing to read.
on_inner_exit() {
  [ "$1" -eq 0 ] || { echo "--- restored postgres log (tail) ---" >&2; tail -n 40 "$LOG" >&2 || true; }
}
trap 'on_inner_exit $?' EXIT

# Queries come in on stdin, with values passed as psql variables (:'name'), never pasted into the SQL text.
psql_q() { psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

echo "[drill:restore] pgbackrest restore (delta, stop at the end of the backup, then promote)" >&2
pgbackrest --stanza=bos --delta --type=immediate --target-action=promote restore

echo "[drill:restore] starting postgres on the restored files" >&2
pg_ctl -D "$PGDATA" -w -t 300 -l "$LOG" \
  -o "-c listen_addresses= -c unix_socket_directories=/tmp -c archive_mode=off" start

echo "[drill:restore] waiting for recovery to finish" >&2
in_recovery() { psql_q -d postgres <<<"select pg_is_in_recovery()"; }
for _ in $(seq 1 120); do
  [ "$(in_recovery)" = "f" ] && break
  sleep 1
done
[ "$(in_recovery)" = "f" ] || { echo "recovery did not finish" >&2; exit 1; }

canary=$(psql_q -d bos -v id="$CANARY_ID" <<<"select count(*) from ops.restore_canary where id = :'id'")
[ "$canary" = "1" ] || { echo "CHECK FAILED: canary row $CANARY_ID is not in the restored database" >&2; exit 1; }
echo "[drill:check] canary row present" >&2

events=$(psql_q -d zitadel -v s=eventstore <<<"select count(*) from information_schema.tables where table_schema = :'s'")
[ "$events" -gt 0 ] || { echo "CHECK FAILED: the zitadel database has no eventstore tables" >&2; exit 1; }
echo "[drill:check] zitadel eventstore tables: $events" >&2

orgs=$(psql_q -d bos <<<"select count(*) from app.organizations")
[ "$orgs" -gt 0 ] || { echo "CHECK FAILED: app.organizations is empty. Run pnpm seed before the drill." >&2; exit 1; }
echo "[drill:check] app.organizations rows: $orgs" >&2

pg_ctl -D "$PGDATA" -m fast -w stop >&2
INNER_EOF
)"

STEP="restore"
log "restoring and checking in a throwaway container"
START_SECONDS=$SECONDS
compose run --rm -T -e "CANARY_ID=$CANARY_ID" restore-drill -c "$INNER" >&2
# RTO: the time from "start restoring into an empty disk" until the restored database answered correctly.
RTO_SECONDS=$((SECONDS - START_SECONDS))
log "restore verified in ${RTO_SECONDS}s"

# ---- 5. clean up, then report -------------------------------------------------------------------------------------
STEP="cleanup"
if wipe_drill_volume; then
  CLEAN_NEEDED=""
else
  log "WARNING: could not empty the pgdata-drill volume (the next run empties it again)"
  CLEAN_NEEDED=""
fi
STEP="done"
printf '{"result":"pass","rto_seconds":%s}\n' "$RTO_SECONDS"
