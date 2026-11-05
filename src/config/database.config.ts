import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

/**
 * Schema sync derives the tables from the entities on every boot. That is how
 * this service gets its schema, and it is also able to drop a column when an
 * entity changes. On the mainnet profile it is therefore off unless asked for:
 * DATABASE_SYNCHRONIZE=true, which startup validation only accepts together
 * with MAINNET_ALLOW_SCHEMA_SYNC=true. Everywhere else it stays on.
 */
export function shouldSynchronize(configService: ConfigService): boolean {
  const explicit = configService.get<string>('DATABASE_SYNCHRONIZE');
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return String(explicit).trim() === 'true';
  }
  return String(configService.get<string>('NETWORK_PROFILE', 'local')).toLowerCase() !== 'mainnet';
}

export const databaseConfigFactory = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DATABASE_HOST', 'localhost'),
  port: configService.get<number>('DATABASE_PORT', 5432),
  username: configService.get<string>('DATABASE_USER', 'postgres'),
  password: configService.get<string>('DATABASE_PASSWORD', 'postgres'),
  database: configService.get<string>('DATABASE_NAME', 'payment_db'),
  autoLoadEntities: true,
  synchronize: shouldSynchronize(configService),
});
