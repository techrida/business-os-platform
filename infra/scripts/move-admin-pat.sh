#!/usr/bin/env bash
# One-off, for a stack that already exists (U1-01). Run it once per stack, before the next `up`:
#
#   bash infra/scripts/move-admin-pat.sh [compose-project]        (default: $COMPOSE_PROJECT_NAME, else "bos")
#
# New stacks need nothing: compose.yaml already writes admin.pat to the `zitadel-admin` volume. An old stack has
# admin.pat in the `zitadel-bootstrap` volume, which zitadel-login can read. This script:
#   1. moves admin.pat from <project>_zitadel-bootstrap to <project>_zitadel-admin (created if missing), mode 0600;
#   2. gives login-client.pat to the login image's uid (1001), mode 0600, so zitadel-login no longer needs uid 0;
#   3. moves ZITADEL_PROVISIONER_TOKEN and ZITADEL_ACTIONS_SIGNING_KEY out of .dev/zitadel.env into
#      .dev/zitadel-api.env (mode 0600), so the web apps stop reading them. (`pnpm seed` does the same on its next
#      run; doing it here means api and worker are never without the token in between.)
# It is safe to run twice. It never prints a token or a key. It does not start, stop or recreate containers:
# afterwards run the normal `up`, which recreates zitadel-api, zitadel-login, api, worker and the web apps.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PROJECT="${1:-${COMPOSE_PROJECT_NAME:-bos}}"
OLD_VOLUME="${PROJECT}_zitadel-bootstrap"
NEW_VOLUME="${PROJECT}_zitadel-admin"
DEV_DIR="${BOS_DEV_DIR:-.dev}"
LOGIN_UID=1001 # infra/login/Dockerfile: adduser --system --uid 1001 nextjs

log() { echo "[move-admin-pat] $*" >&2; }

command -v docker >/dev/null || { log "docker is not installed"; exit 1; }
docker volume inspect "$OLD_VOLUME" >/dev/null 2>&1 || {
  log "the volume $OLD_VOLUME does not exist. Pass the compose project name as the first argument."
  exit 1
}
if ! docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then
  # The labels make compose treat the volume as its own, so the next `up` does not warn about a foreign volume.
  docker volume create \
    --label "com.docker.compose.project=$PROJECT" \
    --label "com.docker.compose.volume=zitadel-admin" \
    "$NEW_VOLUME" >/dev/null
  log "created the volume $NEW_VOLUME"
fi

# Runs as root inside a throwaway container from the same pinned image the seed uses. The token files are only
# copied and chmod-ed here, never read into a variable or printed.
docker run --rm --pull=never --user 0 --entrypoint sh \
  -v "$OLD_VOLUME:/old" -v "$NEW_VOLUME:/new" \
  -e "LOGIN_UID=$LOGIN_UID" \
  node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 -c '
    set -eu
    if [ -f /old/admin.pat ]; then
      cp /old/admin.pat /new/admin.pat.tmp
      chmod 0600 /new/admin.pat.tmp
      cmp -s /old/admin.pat /new/admin.pat.tmp
      mv -f /new/admin.pat.tmp /new/admin.pat
      rm -f /old/admin.pat
      echo "[move-admin-pat] moved admin.pat to the admin volume" >&2
    elif [ -f /new/admin.pat ]; then
      chmod 0600 /new/admin.pat
      echo "[move-admin-pat] admin.pat is already in the admin volume" >&2
    else
      echo "[move-admin-pat] no admin.pat in either volume" >&2
      exit 1
    fi
    if [ -f /old/login-client.pat ]; then
      chown "$LOGIN_UID:$LOGIN_UID" /old/login-client.pat
      chmod 0600 /old/login-client.pat
      echo "[move-admin-pat] login-client.pat now belongs to uid $LOGIN_UID" >&2
    else
      echo "[move-admin-pat] no login-client.pat in the bootstrap volume (nothing to re-own)" >&2
    fi
  '

# Host side: split the two secrets out of zitadel.env. Same pattern as the seed's own write: 0600, one file each.
SECRET_KEYS='^(ZITADEL_PROVISIONER_TOKEN|ZITADEL_ACTIONS_SIGNING_KEY)='
if [[ -f "$DEV_DIR/zitadel.env" ]] && grep -qE "$SECRET_KEYS" "$DEV_DIR/zitadel.env"; then
  umask 077
  if [[ ! -f "$DEV_DIR/zitadel-api.env" ]]; then
    grep -E "$SECRET_KEYS" "$DEV_DIR/zitadel.env" >"$DEV_DIR/zitadel-api.env"
    log "wrote $DEV_DIR/zitadel-api.env"
  else
    # An existing file wins, but only when it holds every secret zitadel.env is about to lose.
    for key in $(grep -oE "$SECRET_KEYS" "$DEV_DIR/zitadel.env" | tr -d '='); do
      grep -q "^$key=" "$DEV_DIR/zitadel-api.env" || {
        log "$DEV_DIR/zitadel-api.env exists but has no $key; leaving both files alone. Merge by hand, then run again."
        exit 1
      }
    done
    log "$DEV_DIR/zitadel-api.env already exists and holds the same keys; kept as is"
  fi
  grep -vE "$SECRET_KEYS" "$DEV_DIR/zitadel.env" >"$DEV_DIR/zitadel.env.tmp" || true
  mv -f "$DEV_DIR/zitadel.env.tmp" "$DEV_DIR/zitadel.env"
  chmod 0600 "$DEV_DIR/zitadel.env" "$DEV_DIR/zitadel-api.env"
  log "removed the token and the key from $DEV_DIR/zitadel.env"
else
  log "$DEV_DIR/zitadel.env has no token or key (already split, or not seeded yet)"
fi
log "done. Now run the normal stack up so the changed services are recreated."
