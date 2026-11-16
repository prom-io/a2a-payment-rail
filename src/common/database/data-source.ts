import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDatabaseOptions, envReader } from './database-options';

/**
 * Data source for the TypeORM CLI (`npm run migration:*`). It reads the same
 * DATABASE_* variables as the service and is built from the compiled output,
 * so run `npm run build` first; `migration:generate` does that by itself.
 *
 * Schema sync is always off here: the CLI is how the schema changes, never
 * as a side effect of connecting.
 *
 * In the production image (no npm) the same commands are
 *   node node_modules/typeorm/cli.js -d dist/common/database/data-source.js migration:run
 */
export default new DataSource({
  ...buildDatabaseOptions(envReader(process.env)),
  synchronize: false,
  migrationsRun: false,
});
