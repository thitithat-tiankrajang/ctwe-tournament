#!/bin/sh
#
# Run the backend suite against a SCRATCH database seeded from the dev one.
#
# WHY THIS EXISTS
#
#   1. Spring Boot runs Flyway on context startup. Running the suite directly against the dev
#      `tournament` database applies this branch's migrations to it — and any checkout that does not
#      have those migration files then fails Flyway validation on its next startup ("detected applied
#      migration not resolved locally"). Working on a feature branch with new migrations therefore
#      breaks every other checkout unless the tests are pointed somewhere else.
#
#   2. Every database-backed test here is annotated
#      @EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+").
#      Without that variable JUnit SKIPS them and the build still reports SUCCESS. A green `mvn test`
#      with no password set proves nothing. This script fails loudly instead, and prints the executed
#      test count so a human (or CI) can check it moved.
#
# USAGE
#   DATABASE_PASSWORD=... sh backend/run-tests.sh            # reuse the scratch db
#   DATABASE_PASSWORD=... sh backend/run-tests.sh --reset    # rebuild it from the dev db first
#
# Override DB_HOST / DB_PORT / DB_USER / DB_SOURCE / DB_SCRATCH if your setup differs.
set -e

: "${DATABASE_PASSWORD:?set DATABASE_PASSWORD, or the database tests will silently skip}"
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}
DB_USER=${DB_USER:-tournament_app}
DB_SOURCE=${DB_SOURCE:-tournament}
DB_SCRATCH=${DB_SCRATCH:-tournament_scratch}

export PGPASSWORD="$DATABASE_PASSWORD"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -v ON_ERROR_STOP=1"

if [ "$1" = "--reset" ] || ! $PSQL -d "$DB_SCRATCH" -c 'SELECT 1' >/dev/null 2>&1; then
  echo "== rebuilding scratch database $DB_SCRATCH from $DB_SOURCE =="
  $PSQL -d postgres -q -c "DROP DATABASE IF EXISTS $DB_SCRATCH;"
  $PSQL -d postgres -q -c "CREATE DATABASE $DB_SCRATCH;"
  # A dump/restore rather than CREATE DATABASE ... TEMPLATE, because templating is refused while any
  # session (a running dev backend, an open psql) holds a connection to the source database.
  pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_SOURCE" --no-owner --no-privileges \
    | $PSQL -d "$DB_SCRATCH" -q >/dev/null
  echo "== seeded; Flyway will apply any new migrations on first boot =="
fi

export DATABASE_URL="jdbc:postgresql://$DB_HOST:$DB_PORT/$DB_SCRATCH"
export DATABASE_USER="$DB_USER"

[ "$1" = "--reset" ] && shift
cd "$(dirname "$0")"
mvn -o "$@" test
