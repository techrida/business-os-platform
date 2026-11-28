#!/usr/bin/env bash
# Transfer only disposable runner state. The uploaded file is GPG-encrypted.
set -euo pipefail
umask 077
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f .github/qa/compose.qa.yaml "$@"; }
case "$1" in
  save)
    source .env
    dc exec -T -e VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey valkey-cli --raw EVAL \
      "local r={} for _,k in ipairs(redis.call('keys','pt:sess:*')) do table.insert(r,{k,redis.call('get',k),redis.call('pexpiretime',k)}) end return cjson.encode(r)" 0 > .dev/portal-sessions.json
    for db in bos zitadel; do
      dc exec -T postgres pg_dump -Fc -U postgres "$db" > ".dev/$db.dump"
    done
    docker cp "$(dc ps -q zitadel-api)":/zitadel/bootstrap/login-client.pat .dev/bootstrap.pat
    sudo chown "$(id -u):$(id -g)" .dev/bootstrap.pat
    tar --exclude='*/standalone' --exclude='*/cache' -czf - \
      apps/workspace/.next-devtools apps/portal/.next apps/api/dist packages/*/dist .env .dev/{bos,zitadel}.dump .dev/{bootstrap,login-client}.pat \
      .dev/{zitadel,zitadel-api,zitadel-portal}.env .dev/personas.json .dev/files \
      .dev/portal-{customer,vendor,vendor-b,pending}.json .dev/portal-sessions.json .dev/portal-proof.pdf .dev/qa-fixture-ids.json |
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
    dc up -d --wait postgres valkey
    source .env
    dc exec -T -e VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey valkey-cli -x EVAL \
      "for _,r in ipairs(cjson.decode(ARGV[1])) do redis.call('set',r[1],r[2],'PXAT',r[3]) end return 'OK'" 0 < .dev/portal-sessions.json | grep -qx OK
    for db in bos zitadel; do
      dc exec -T postgres pg_restore -U postgres --clean --if-exists --exit-on-error -d "$db" < ".dev/$db.dump"
    done
    dc create --no-deps zitadel-api
    docker run --rm -i --volumes-from "$(dc ps --all -q zitadel-api)" --entrypoint sh bos/postgres:16 \
      -c 'umask 022; cat > /zitadel/bootstrap/login-client.pat' < .dev/bootstrap.pat
    ;;
  *) exit 2 ;;
esac
