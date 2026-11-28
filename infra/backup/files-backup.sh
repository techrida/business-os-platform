#!/usr/bin/env bash
# Backs up the uploaded-files volume with restic, and proves the backup can be restored.
#
#   bash infra/backup/files-backup.sh [backup|check|restore-check]      (default: backup)
#
#   backup         take a snapshot of the clean/ folder, then run the restore check below
#   check          verify the repository's structure (restic check); fast
#   restore-check  restore the newest snapshot into a scratch folder and compare every file's SHA-256 with
#                  the live volume. This is the files part of the restore drill (the restore-drill runbook).
#
# Why restic and not pgBackRest: the files are plain files on a Docker volume (`files`), not database pages.
# restic (BSD-2) deduplicates, encrypts and can later push the same repository to S3-compatible storage.
#
# What is backed up: `clean/` only. `quarantine/` holds files that are unscanned or being scanned; backing them
# up would copy possibly infected bytes, and after a restore their rows are retried or marked scan_failed anyway.
#
# Where it lives: a second Docker volume `bos_files-restic-repo` on the SAME machine, the same pattern as the
# pgBackRest repository (see "What this does not cover yet" in the runbook: same disk is not offsite).
# To use another repository (for example S3), set RESTIC_REPOSITORY (and its credentials) in .env.
#
# Needs: docker, and RESTIC_PASSWORD in .env (or in the environment). Losing that password makes the repository
# unreadable, so keep it with ZITADEL_MASTERKEY. Nothing here prints the password.
#
# restic runs from the image restic/restic:0.18.1, pinned by digest (the multi-arch index digest; infra/scripts/
# check-image-pins.mjs scans this folder), with the files volume mounted READ-ONLY: a backup tool bug can never
# change an uploaded file. The image reference is written out on each `docker run` line below, because the checker
# cannot see through a variable. To bump it: change the tag and digest in BOTH places.
# (`docker buildx imagetools inspect restic/restic:<tag>`, use the top-level "Digest:".)
set -euo pipefail

MODE="${1:-backup}"
case "$MODE" in
  backup | check | restore-check) ;;
  *) echo "usage: files-backup.sh [backup|check|restore-check]" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Compose project name is `bos` (infra/compose/compose.yaml), so the volume `files` is `bos_files`.
FILES_VOLUME="${FILES_VOLUME:-bos_files}"
REPO_VOLUME="${RESTIC_REPO_VOLUME:-bos_files-restic-repo}"

log() { echo "[files-backup] $*" >&2; }

command -v docker >/dev/null || { log "docker is not installed"; exit 1; }

# Read RESTIC_PASSWORD (and an optional RESTIC_REPOSITORY) from .env without sourcing the whole file:
# .env is not shell syntax guaranteed, and sourcing it would also export every other secret.
env_value() {
  local name="$1" line
  line="$(grep -E "^${name}=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}
RESTIC_PASSWORD="${RESTIC_PASSWORD:-$(env_value RESTIC_PASSWORD)}"
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-$(env_value RESTIC_REPOSITORY)}"
[[ -n "$RESTIC_PASSWORD" ]] || { log "RESTIC_PASSWORD is not set. Add it to .env (a long random string) and keep a copy next to ZITADEL_MASTERKEY."; exit 1; }
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"

docker volume inspect "$FILES_VOLUME" >/dev/null 2>&1 || {
  log "the volume $FILES_VOLUME does not exist. Start the app profile once (pnpm stack:up:files plus the api), or set FILES_VOLUME."
  exit 1
}

# The password goes in through the environment of the `docker run` process only (-e NAME without a value copies it),
# never on a command line where `ps` could show it.
# restic_run: the image's own entry point is restic, so the arguments are a restic command.
restic_run() {
  RESTIC_PASSWORD="$RESTIC_PASSWORD" RESTIC_REPOSITORY="$RESTIC_REPOSITORY" \
    docker run --rm -e RESTIC_PASSWORD -e RESTIC_REPOSITORY \
      -v "$REPO_VOLUME:/repo" \
      -v "$FILES_VOLUME:/data:ro" \
      restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76 \
      "$@"
}
# restic_sh: the same container with /bin/sh as the entry point; the one argument is the shell script to run.
restic_sh() {
  RESTIC_PASSWORD="$RESTIC_PASSWORD" RESTIC_REPOSITORY="$RESTIC_REPOSITORY" \
    docker run --rm -e RESTIC_PASSWORD -e RESTIC_REPOSITORY \
      -v "$REPO_VOLUME:/repo" \
      -v "$FILES_VOLUME:/data:ro" \
      --entrypoint /bin/sh \
      restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76 \
      -c "$1"
}

init_repo_if_needed() {
  if restic_run cat config >/dev/null 2>&1; then return 0; fi
  log "creating the restic repository ($RESTIC_REPOSITORY)"
  restic_run init >&2
}

do_backup() {
  # Before the first upload, clean/ does not exist and restic would fail on the missing path.
  if ! restic_sh 'test -d /data/clean'; then
    log "clean/ does not exist yet (nothing was ever uploaded): nothing to back up"
    return 0
  fi
  init_repo_if_needed
  log "taking a snapshot of clean/ (quarantine/ is skipped on purpose)"
  # --host fixes the snapshot's host name: the container's own name changes on every run, which would make
  # restic treat each run as a different machine and break "newest snapshot of this host".
  restic_run backup /data/clean --host bos-files --tag bos-files >&2
  log "applying retention (7 daily, 4 weekly, 6 monthly) and pruning"
  restic_run forget --host bos-files --tag bos-files --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >&2
}

do_check() {
  init_repo_if_needed
  log "checking the repository structure"
  restic_run check >&2
}

# Restore the newest snapshot into a throwaway folder inside the container and compare checksums with the live
# files. The comparison runs INSIDE the container so file names never pass through the host shell.
do_restore_check() {
  init_repo_if_needed
  log "restoring the newest snapshot into a scratch folder and comparing every file's SHA-256"
  local started=$SECONDS
  # The restic image is Alpine (busybox sh, sha256sum available). Entry point is restic, so override it.
  restic_sh '
    set -eu
    if [ ! -d /data/clean ]; then
      # Nothing was ever uploaded: no snapshot of an absent folder exists, so there is nothing to compare.
      echo "[restore-check] /data/clean does not exist yet: nothing to compare" >&2
      exit 0
    fi
    SCRATCH=$(mktemp -d)
    trap "rm -rf \"$SCRATCH\"" EXIT
    restic restore latest --host bos-files --tag bos-files --target "$SCRATCH" >&2
    # The snapshot stores paths as /data/clean/..., so the restored tree is $SCRATCH/data/clean.
    LIVE=$(cd /data/clean && find . -type f -exec sha256sum {} + | sort -k2)
    BACK=$(cd "$SCRATCH/data/clean" && find . -type f -exec sha256sum {} + | sort -k2)
    if [ "$LIVE" != "$BACK" ]; then
      echo "[restore-check] FAILED: the restored files differ from the live volume" >&2
      echo "$LIVE" > /tmp/live.txt; echo "$BACK" > /tmp/back.txt
      diff /tmp/live.txt /tmp/back.txt >&2 || true
      exit 1
    fi
    COUNT=$(printf "%s\n" "$LIVE" | grep -c . || true)
    echo "[restore-check] OK: $COUNT file(s) restored and identical" >&2
  '
  log "restore check passed in $((SECONDS - started))s"
}

case "$MODE" in
  backup)
    do_backup
    # do_backup returns early when there was nothing to back up; the restore check handles that case too.
    do_restore_check
    ;;
  check) do_check ;;
  restore-check) do_restore_check ;;
esac
log "done ($MODE)"
