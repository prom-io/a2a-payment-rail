import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDatabaseOptions, envReader, MIGRATIONS_TABLE } from '../src/common/database/database-options';
import { MIGRATIONS } from '../src/migrations';

/**
 * Runs the committed migrations against a database of their own and checks
 * that the result is exactly the schema the entities describe: nothing for
 * schema sync left to do. Then reverts them all and checks nothing is left.
 */
describe('Schema migrations (e2e)', () => {
  const options = buildDatabaseOptions(envReader(process.env));
  const scratch = `migrations_${randomBytes(4).toString('hex')}`;
  let admin: DataSource;
  let db: DataSource;

  const tables = async () =>
    (
      await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      )
    ).map((row: { table_name: string }) => row.table_name);

  beforeAll(async () => {
    admin = await new DataSource({ ...options, entities: [], migrations: [] }).initialize();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    db = await new DataSource({ ...options, database: scratch, synchronize: false }).initialize();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
      await admin.destroy();
    }
  });

  it('starts from an empty database with every migration pending', async () => {
    expect(await tables()).toEqual([]);
    expect(await db.showMigrations()).toBe(true);
  });

  it('applies every migration in order and records them', async () => {
    const applied = await db.runMigrations({ transaction: 'each' });

    expect(applied.map((migration) => migration.name)).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(await db.showMigrations()).toBe(false);
    const recorded = await db.query(`SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`);
    expect(recorded.map((row: { name: string }) => row.name)).toEqual(applied.map((migration) => migration.name));
  });

  it('creates every entity table', async () => {
    const created = await tables();
    for (const entity of db.entityMetadatas) expect(created).toContain(entity.tableName);
  });

  it('leaves nothing for schema sync to change', async () => {
    // The same diff `migration:generate` computes: empty means no drift.
    const pending = await db.driver.createSchemaBuilder().log();

    expect(pending.upQueries.map((query) => query.query)).toEqual([]);
  });

  it('is usable by the service right away', async () => {
    await db.query(
      `INSERT INTO escrow_sessions ("agentA", "agentB", "depositAmount", "budgetLimit", ttl)
       VALUES ('0xa', '0xb', '1.5', '1.5', 3600)`,
    );
    const [row] = await db.query(`SELECT status, "releasedAmount", "policyFlags" FROM escrow_sessions`);

    expect(row).toEqual({ status: 'open', releasedAmount: '0.000000000000000000', policyFlags: {} });
  });

  it('reverts back to an empty schema', async () => {
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      await db.undoLastMigration({ transaction: 'each' });
    }

    expect(await tables()).toEqual([MIGRATIONS_TABLE]);
    const types = await db.query(`SELECT typname FROM pg_type WHERE typtype = 'e'`);
    expect(types).toEqual([]);
  });
});
