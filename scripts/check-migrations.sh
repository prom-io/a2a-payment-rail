#!/usr/bin/env bash
# Checks the committed migrations against the entities, on an empty database.
#
#   1. every migration applies on an empty database;
#   2. nothing is left pending afterwards;
#   3. the entities do not differ from the migrated schema (no drift): an
#      entity change without its migration fails here, with the missing SQL
#      printed;
#   4. every migration reverts, down to an empty schema, and applies again.
#
# Needs the compiled output (npm run build) and the DATABASE_* variables of a
# database it may wipe. Used by the `migrations` job in .github/workflows/ci.yml;
# locally: npm run build && npm run migration:verify
set -euo pipefail

DATA_SOURCE=dist/common/database/data-source.js
TYPEORM="npx --no-install typeorm -d ${DATA_SOURCE}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ ! -f "${DATA_SOURCE}" ]; then
  echo "::error::${DATA_SOURCE} not found, run npm run build first"
  exit 1
fi

registered=$(node -e "console.log(require('./dist/migrations').MIGRATIONS.length)")
echo "registered migrations: ${registered}"

# Tables in the public schema other than the migration history.
user_tables() {
  node -e "
    const { Client } = require('pg');
    const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;
    const client = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'payment_db',
      ssl,
    });
    client.connect()
      .then(() => client.query(\"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY 1\"))
      .then((res) => { console.log(res.rows.map((row) => row.table_name).join(' ')); return client.end(); })
      .catch((error) => { console.error(error.message); process.exit(1); });
  "
}

check_drift() {
  local stage="$1"
  if ${TYPEORM} migration:generate src/migrations/Drift --check > /tmp/migration-drift.log 2>&1; then
    echo "no drift ${stage}"
    return 0
  fi
  echo "::error::Entities differ from the committed migrations (${stage}). Generate a migration: npm run migration:generate -- src/migrations/<Name>"
  ${TYPEORM} migration:generate src/migrations/Drift --dryrun --pretty 2>&1 | tee /tmp/migration-drift.sql || true
  {
    echo "### Schema drift (${stage})"
    echo ""
    echo "The entities need SQL that no committed migration contains:"
    echo ""
    echo '```ts'
    cat /tmp/migration-drift.sql
    echo '```'
  } >> "${SUMMARY}"
  return 1
}

existing=$(user_tables)
if [ -n "${existing}" ]; then
  echo "::error::the database is not empty (${existing}); this check needs a fresh one"
  exit 1
fi

echo "--- apply all"
${TYPEORM} migration:run --transaction each > /tmp/migration-run.log 2>&1 || { cat /tmp/migration-run.log; exit 1; }
grep -E "has been executed successfully|No migrations are pending" /tmp/migration-run.log || true

echo "--- nothing pending"
${TYPEORM} migration:show | tee /tmp/migration-show.log
if grep -q '\[ \]' /tmp/migration-show.log; then
  echo "::error::migrations still pending after migration:run"
  exit 1
fi

echo "--- drift"
check_drift "after migration:run"

echo "--- revert all ${registered}"
for _ in $(seq 1 "${registered}"); do
  ${TYPEORM} migration:revert --transaction each > /tmp/migration-revert.log 2>&1 || { cat /tmp/migration-revert.log; exit 1; }
done
left=$(user_tables)
if [ -n "${left}" ]; then
  echo "::error::tables left after reverting every migration: ${left}"
  exit 1
fi
echo "schema empty after revert"

echo "--- apply again"
${TYPEORM} migration:run --transaction each > /tmp/migration-run.log 2>&1 || { cat /tmp/migration-run.log; exit 1; }
check_drift "after revert and re-apply"

echo "migrations OK"
