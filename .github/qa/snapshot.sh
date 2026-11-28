#!/usr/bin/env bash
# Transfer only disposable runner state. The uploaded file is GPG-encrypted.
set -euo pipefail
umask 077
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f .github/qa/compose.qa.yaml "$@"; }
case "$1" in
  save)
    for db in bos zitadel; do
      dc exec -T postgres pg_dump -Fc -U postgres "$db" > ".dev/$db.dump"
    done
    docker cp "$(dc ps -q zitadel-api)":/zitadel/bootstrap/login-client.pat .dev/bootstrap.pat
    sudo chown "$(id -u):$(id -g)" .dev/bootstrap.pat
    tar -czf - .env .dev/{bos,zitadel}.dump .dev/{bootstrap,login-client}.pat \
      .dev/{zitadel,zitadel-api,zitadel-portal}.env .dev/personas.json .dev/files \
      .dev/portal-{customer,vendor,vendor-b,pending}.json .dev/portal-proof.pdf .dev/qa-fixture-ids.json |
      gpg --batch --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
        -o "$RUNNER_TEMP/fixtures.gpg" 3<<<"$QA_FIXTURE_KEY"
    ;;
  unpack)
    # Authenticate the entire encrypted archive before extracting anything.
    gpg --batch --pinentry-mode loopback --passphrase-fd 3 --decrypt \
      -o "$RUNNER_TEMP/fixtures.tgz" "$RUNNER_TEMP/fixtures.gpg" 3<<<"$QA_FIXTURE_KEY"
    tar -xzf "$RUNNER_TEMP/fixtures.tgz"
    ;;
  restore)
    dc up -d --wait postgres
    for db in bos zitadel; do
      dc exec -T postgres pg_restore -U postgres --clean --if-exists --exit-on-error -d "$db" < ".dev/$db.dump"
    done
    dc create --no-deps zitadel-api
    chmod 644 .dev/bootstrap.pat
    docker cp .dev/bootstrap.pat "$(dc ps --all -q zitadel-api)":/zitadel/bootstrap/login-client.pat
    ;;
  *) exit 2 ;;
esac
