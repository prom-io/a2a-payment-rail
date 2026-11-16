import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  EnvReader,
  buildDatabaseOptions,
  shouldRunMigrationsOnBoot,
} from '../common/database/database-options';

/**
 * Schema sync derives the tables from the entities on every boot. That is how
 * a laptop or a test database gets its schema, and it is also able to drop a
 * column when an entity changes. On the mainnet profile it is therefore off
 * unless asked for: DATABASE_SYNCHRONIZE=true, which startup validation only
 * accepts together with MAINNET_ALLOW_SCHEMA_SYNC=true. Everywhere else it
 * stays on unless DATABASE_SYNCHRONIZE=false; with it off the schema comes
 * from the migrations in src/migrations (see docs/DATABASE.md).
 */
export function shouldSynchronize(configService: ConfigService): boolean {
  const explicit = configService.get<string>('DATABASE_SYNCHRONIZE');
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return String(explicit).trim() === 'true';
  }
  return String(configService.get<string>('NETWORK_PROFILE', 'local')).toLowerCase() !== 'mainnet';
}

const readerOf =
  (configService: ConfigService): EnvReader =>
  (name) => {
    const value = configService.get<unknown>(name);
    return value === undefined || value === null ? undefined : String(value);
  };

export const databaseConfigFactory = (
  configService: ConfigService,
): TypeOrmModuleOptions => {
  const read = readerOf(configService);
  const synchronize = shouldSynchronize(configService);
  return {
    ...buildDatabaseOptions(read),
    // Modules still register their own entities; the explicit list in the
    // shared options is what the migration CLI uses.
    autoLoadEntities: true,
    synchronize,
    // Never both: sync would already have shaped the tables the migrations expect to create.
    migrationsRun: !synchronize && shouldRunMigrationsOnBoot(read),
  };
};
