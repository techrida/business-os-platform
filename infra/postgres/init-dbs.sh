#!/usr/bin/env bash
# Creates the roles and databases for Business OS. Runs once, on the first start of an empty data volume
# (the postgres image runs everything in /docker-entrypoint-initdb.d as the superuser).
#
#   roles      zitadel    owns the "zitadel" database (ZITADEL connects to it in DSN mode)
#              bos_owner  owns the "bos" database; migrations run as this role
#              bos_app    runtime role: only DML on what bos_owner creates (via default privileges)
#   databases  zitadel, bos
#
# Passwords come from the container environment. Written to be re-runnable: existing roles keep their name
# and just get the password re-applied.
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${BOS_DB_OWNER_PASSWORD:?BOS_DB_OWNER_PASSWORD is not set}"
: "${BOS_DB_APP_PASSWORD:?BOS_DB_APP_PASSWORD is not set}"
: "${ZITADEL_DB_PASSWORD:?ZITADEL_DB_PASSWORD is not set}"

# Passwords go in as psql variables (:'name' is quoted as a SQL literal), never pasted into the SQL text.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v zitadel_pw="$ZITADEL_DB_PASSWORD" \
  -v owner_pw="$BOS_DB_OWNER_PASSWORD" \
  -v app_pw="$BOS_DB_APP_PASSWORD" <<'SQL'

-- roles (plain login roles: no superuser, no createdb, no createrole)
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'zitadel', :'zitadel_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zitadel') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'bos_owner', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bos_owner') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'bos_app', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bos_app') \gexec

ALTER ROLE zitadel   PASSWORD :'zitadel_pw';
ALTER ROLE bos_owner PASSWORD :'owner_pw';
ALTER ROLE bos_app   PASSWORD :'app_pw';

-- databases. The owner can create objects in "public" (PG15+ only lets the database owner do that).
SELECT 'CREATE DATABASE zitadel OWNER zitadel'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zitadel') \gexec
SELECT 'CREATE DATABASE bos OWNER bos_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'bos') \gexec

-- nobody else may even connect
REVOKE ALL ON DATABASE zitadel FROM PUBLIC;
REVOKE ALL ON DATABASE bos FROM PUBLIC;
GRANT CONNECT ON DATABASE bos TO bos_app;

-- Runtime role: DML only, granted automatically on everything bos_owner creates from now on, in any schema
-- (no IN SCHEMA, because the "app" and "ops" schemas do not exist until migration 0000 creates them).
-- The migration (packages/db) should narrow this where needed, e.g. REVOKE UPDATE, DELETE on ops tables.
\connect bos
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- pg_trgm (migration 0041) lives in public; the app role calls its functions and operators for list search.
GRANT USAGE ON SCHEMA public TO bos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE, SELECT ON SEQUENCES TO bos_app;

-- Statement statistics (shared_preload_libraries in postgresql.conf). Creating an extension needs the superuser,
-- which is who runs this file; the migrate role is not allowed to. app-up.sh repeats this on every deploy because
-- this file only runs on an empty volume.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL

echo "init-dbs: roles zitadel, bos_owner, bos_app and databases zitadel, bos are ready"
