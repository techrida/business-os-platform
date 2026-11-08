#!/usr/bin/env bash
# Create .env from .env.example with fresh random dev secrets. Refuses to overwrite an existing .env.
# Usage (repo root): bash infra/scripts/make-dev-env.sh
set -euo pipefail
[ -f .env ] && { echo "make-dev-env: .env already exists, leaving it alone" >&2; exit 0; }
cp .env.example .env
chmod 600 .env
r() { openssl rand -hex "$1"; }
sed -i \
  -e "s/dev-postgres-pw/$(r 16)/g" \
  -e "s/dev-owner-pw/$(r 16)/g" \
  -e "s/dev-app-pw/$(r 16)/g" \
  -e "s/dev-zitadel-db-pw/$(r 16)/g" \
  -e "s/bos-dev-masterkey-0123456789abcd/$(r 16)/g" \
  -e "s/bos-dev-login-cookie-secret-0123456789abcdef/$(r 32)/g" \
  -e "s/Dev-Admin-Passw0rd-1#/Bos-$(r 8)-Aa1#/g" .env
echo "make-dev-env: .env written with random secrets (mode 600). Back up ZITADEL_MASTERKEY with it."
