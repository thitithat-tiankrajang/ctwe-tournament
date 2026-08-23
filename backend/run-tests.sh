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

# The scratch database is seeded from the dev one, whose applied history can be AHEAD of this branch
# — a migration living on a different feature branch is applied there but does not exist here, and
# Flyway refuses to start on "applied migration not resolved locally". That is branch topology, not a
# schema problem, and it resolves itself once the branches converge on main.
#
# Scoped to this harness only. Never set it for a real deployment: outside this script the check is
# exactly what catches a migration that was deleted or renamed after being applied.
export SPRING_FLYWAY_IGNORE_MIGRATION_PATTERNS='*:missing'

[ "$1" = "--reset" ] && shift
cd "$(dirname "$0")"
mvn -o "$@" test
