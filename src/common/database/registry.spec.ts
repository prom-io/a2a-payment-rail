import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { MIGRATIONS } from '../../migrations';
import { ENTITIES } from './entities';

/**
 * The migration CLI only knows what is listed in `entities.ts` and
 * `migrations/index.ts`. Forgetting either list does not break a single
 * functional test (the app loads its entities on its own), it breaks the first
 * deploy with schema sync off. This spec breaks first.
 */

const SRC = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(SRC, 'migrations');

function filesUnder(dir: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, suffix));
    else if (entry.name.endsWith(suffix)) found.push(path);
  }
  return found;
}

/** `export class Foo` declarations of a source file. */
function exportedClasses(path: string): string[] {
  return [...readFileSync(path, 'utf8').matchAll(/export class (\w+)/g)].map((match) => match[1]);
}

describe('entity registry', () => {
  const entityFiles = filesUnder(SRC, '.entity.ts');

  it('finds the entity files at all', () => {
    expect(entityFiles.length).toBeGreaterThanOrEqual(ENTITIES.length);
  });

  it.each(entityFiles.map((path) => [relative(SRC, path), path]))('%s is registered', (_name, path) => {
    const registered = ENTITIES.map((entity) => entity.name);
    for (const className of exportedClasses(path)) expect(registered).toContain(className);
  });

  it('lists only classes that are entities, each once', () => {
    const tables = getMetadataArgsStorage().tables;
    for (const entity of ENTITIES) {
      expect(tables.some((table) => table.target === entity)).toBe(true);
    }
    expect(new Set(ENTITIES).size).toBe(ENTITIES.length);
  });
});

describe('migration registry', () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && !name.endsWith('.spec.ts'))
    .sort();

  it('registers every migration file', () => {
    const registered = MIGRATIONS.map((migration) => migration.name);
    const declared = migrationFiles.flatMap((name) => exportedClasses(join(MIGRATIONS_DIR, name)));

    expect(registered.sort()).toEqual(declared.sort());
  });

  it('names files <timestamp>-<Name>.ts, as migration:generate does', () => {
    for (const name of migrationFiles) expect(name).toMatch(/^\d{13}-[A-Za-z0-9]+\.ts$/);
  });

  it('keeps the list in timestamp order, which is the order they run in', () => {
    const timestamps = MIGRATIONS.map((migration) => {
      const match = /(\d{13})$/.exec(migration.name);
      expect(match).not.toBeNull();
      return Number(match![1]);
    });

    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it('gives every migration a way back', () => {
    for (const Migration of MIGRATIONS) {
      const migration = new Migration();
      expect(typeof migration.up).toBe('function');
      expect(typeof migration.down).toBe('function');
    }
  });
});
