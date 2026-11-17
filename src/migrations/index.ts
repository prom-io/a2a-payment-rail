import { MigrationInterface } from 'typeorm';
import { Baseline1794931500000 } from './1794931500000-Baseline';

/**
 * Schema migrations, oldest first.
 *
 * Generate a new one from the entity changes with
 *   npm run migration:generate -- src/migrations/<Name>
 * and add the class to this list. The list is explicit rather than a glob over
 * the directory so the compiled build cannot pick up stray files (declaration
 * files, a migration deleted from git but left in dist/). `registry.spec.ts`
 * fails when a file in this directory is not listed, or listed out of order.
 */
export const MIGRATIONS: Array<new () => MigrationInterface> = [Baseline1794931500000];
