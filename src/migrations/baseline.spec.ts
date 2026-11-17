import { getMetadataArgsStorage, QueryRunner } from 'typeorm';
import { ENTITIES } from '../common/database/entities';
import { Baseline1794931500000 } from './1794931500000-Baseline';

/**
 * Without a database: records the SQL the baseline would send and checks it
 * against the entity metadata. The e2e suite runs it for real; this one points
 * at the table or index that is missing when it fails.
 */
function recorder() {
  const queries: string[] = [];
  const runner = { query: jest.fn(async (sql: string) => queries.push(sql.replace(/\s+/g, ' ').trim())) };
  return { queries, runner: runner as unknown as QueryRunner };
}

const tableNames = () =>
  getMetadataArgsStorage()
    .tables.filter((table) => ENTITIES.includes(table.target as (typeof ENTITIES)[number]))
    .map((table) => table.name!);

const indexNames = () =>
  getMetadataArgsStorage()
    .indices.filter((index) => ENTITIES.includes(index.target as (typeof ENTITIES)[number]))
    .map((index) => index.name!);

describe('Baseline1794931500000', () => {
  it('creates the uuid extension before any table that defaults to it', async () => {
    const { queries, runner } = recorder();
    await new Baseline1794931500000().up(runner);

    const extension = queries.findIndex((sql) => sql.includes('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'));
    const firstUuid = queries.findIndex((sql) => sql.includes('uuid_generate_v4()'));
    expect(extension).toBe(0);
    expect(firstUuid).toBeGreaterThan(extension);
  });

  it('creates a table for every entity', async () => {
    const { queries, runner } = recorder();
    await new Baseline1794931500000().up(runner);

    for (const table of tableNames()) {
      expect(queries.some((sql) => sql.startsWith(`CREATE TABLE "${table}"`))).toBe(true);
    }
  });

  it('creates every named index, the partial ones with their condition', async () => {
    const { queries, runner } = recorder();
    await new Baseline1794931500000().up(runner);

    for (const name of indexNames()) {
      expect(queries.some((sql) => sql.includes(`INDEX "${name}"`))).toBe(true);
    }
    expect(queries.find((sql) => sql.includes('"IDX_receipt_unsettled"'))).toContain('WHERE "settlementId" IS NULL');
    expect(queries.find((sql) => sql.includes('"IDX_escrow_awaiting_refund"'))).toContain('WHERE "refundedAt" IS NULL');
  });

  it('drops in down() everything it created in up(), and not the extension', async () => {
    const up = recorder();
    const down = recorder();
    await new Baseline1794931500000().up(up.runner);
    await new Baseline1794931500000().down(down.runner);

    const created = up.queries.flatMap((sql) => /^CREATE (?:TABLE|TYPE) ("[^"]+"(?:\."[^"]+")?)/.exec(sql)?.[1] ?? []);
    for (const name of created) {
      expect(down.queries.some((sql) => sql.startsWith('DROP') && sql.includes(name))).toBe(true);
    }
    expect(down.queries.some((sql) => sql.includes('EXTENSION'))).toBe(false);
  });

  it('drops tables in the reverse order of creation, so foreign keys never block it', async () => {
    const up = recorder();
    const down = recorder();
    await new Baseline1794931500000().up(up.runner);
    await new Baseline1794931500000().down(down.runner);

    const createdTables = up.queries.flatMap((sql) => /^CREATE TABLE "([^"]+)"/.exec(sql)?.[1] ?? []);
    const droppedTables = down.queries.flatMap((sql) => /^DROP TABLE "([^"]+)"/.exec(sql)?.[1] ?? []);
    expect(droppedTables).toEqual([...createdTables].reverse());
  });
});
