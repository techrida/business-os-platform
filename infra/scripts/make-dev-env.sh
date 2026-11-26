#!/usr/bin/env bash
# Create .env from .env.example with fresh random dev secrets.
#   - No .env yet: copy .env.example and fill every placeholder with a random value.
#   - .env exists: never overwrite a value. Only ADD keys that are missing or empty (keys introduced after the
#     .env was made), so re-running is safe and an existing stack keeps its secrets.
# Usage (repo root): bash infra/scripts/make-dev-env.sh
set -euo pipefail
r() { openssl rand -hex "$1"; }

# ensure KEY VALUE: set KEY=VALUE only if .env has no non-empty KEY. An empty `KEY=` line is filled in place,
# a missing key is appended. Never touches a key that already has a value. Prints a line when it adds one.
ensure() {
  local key=$1 value=$2
  grep -q "^${key}=." .env && return 0
  if grep -q "^${key}=\$" .env; then
    sed -i "s|^${key}=\$|${key}=${value}|" .env
  else
    [ -z "$(tail -c1 .env)" ] || echo >> .env
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
  echo "make-dev-env: added ${key}"
}

if [ -f .env ]; then
  echo "make-dev-env: .env exists, keeping every existing value and adding only missing keys" >&2
else
  cp .env.example .env
  chmod 600 .env
  sed -i \
    -e "s/dev-postgres-pw/$(r 16)/g" \
    -e "s/dev-owner-pw/$(r 16)/g" \
    -e "s/dev-app-pw/$(r 16)/g" \
    -e "s/dev-zitadel-db-pw/$(r 16)/g" \
    -e "s/bos-dev-masterkey-0123456789abcd/$(r 16)/g" \
    -e "s/bos-dev-login-cookie-secret-0123456789abcdef/$(r 32)/g" \
    -e "s/dev-docs-link-secret-0123456789abcdef0123/$(r 32)/g" \
    -e "s/Dev-Admin-Passw0rd-1#/Bos-$(r 8)-Aa1#/g" \
    -e "s/^PGBACKREST_REPO1_CIPHER_PASS=\$/PGBACKREST_REPO1_CIPHER_PASS=$(r 32)/" .env
  echo "make-dev-env: .env written with random secrets (mode 600). Back up ZITADEL_MASTERKEY and PGBACKREST_REPO1_CIPHER_PASS with it (no backup can be restored without the second)."
fi

# Session encryption key (32 random bytes, base64) and its id. Not read by the apps yet.
ensure SESSION_ENC_KEY "$(openssl rand -base64 32)"
ensure SESSION_ENC_KEY_ID k1

# Backup encryption passphrase. An .env written before the repo was encrypted has no such line at all, so the
# first-run substitution above never fills it and compose refuses to start. Back it up with the .env.
ensure PGBACKREST_REPO1_CIPHER_PASS "$(r 32)"

# Valkey password (CR-13). Hex only: it sits inside redis:// URLs.
ensure VALKEY_PASSWORD "$(r 32)"
# Host-side Valkey URL: add the password to the old passwordless default or to the .env.example placeholder.
# Any other VALKEY_URL value is the operator's and stays as it is.
valkey_pw=$(grep '^VALKEY_PASSWORD=' .env | head -n1 | cut -d= -f2-)
if grep -q '^VALKEY_URL=redis://\(:dev-valkey-pw@\)\?127\.0\.0\.1:6379$' .env; then
  sed -i "s|^VALKEY_URL=redis://\(:dev-valkey-pw@\)\?127\.0\.0\.1:6379\$|VALKEY_URL=redis://:${valkey_pw}@127.0.0.1:6379|" .env
  echo "make-dev-env: VALKEY_URL now carries VALKEY_PASSWORD"
fi

# P1 keys (P1 plan §6.3). Added only when missing or empty (ensure above), so a P0 .env upgrades in place
# and a fresh .env made from an older .env.example still gets them. Host-run values: the compose
# api and worker set their own container-side values. Values are never printed.
ensure FILES_ROOT ./.dev/files
ensure CLAMD_HOST 127.0.0.1
ensure CLAMD_PORT 3310
ensure SMTP_URL smtp://127.0.0.1:1025
ensure MAIL_FROM '"Business OS <no-reply@bos.localhost>"'
ensure DOCS_LINK_SECRET "$(r 32)"
ensure ZITADEL_API_URL https://auth.localhost
# Encrypts the restic repository of the files volume (infra/backup/files-backup.sh). Back it up with .env.
ensure RESTIC_PASSWORD "$(r 32)"
# ZITADEL_PROVISIONER_TOKEN and ZITADEL_ACTIONS_SIGNING_KEY are written by the seed into .dev/zitadel-api.env (api and worker only).

# P2 customer portal. Its own session key and key id (the portal and the workspace never share one), generated like
# SESSION_ENC_KEY above: 32 random bytes, base64. Added only when missing or empty. Values are never printed.
ensure PORTAL_SESSION_ENC_KEY "$(openssl rand -base64 32)"
ensure PORTAL_SESSION_ENC_KEY_ID p1

# P4 field-encryption keyring (vendor bank details): `<kid>:<base64 of 32 random bytes>`. Added only when missing or
# empty; a single key needs no FIELD_ENC_ACTIVE_KID or FIELD_ENC_FP_KID. Value is never printed.
ensure FIELD_ENC_KEYS "k1:$(openssl rand -base64 32)"
