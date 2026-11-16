import { configStub } from '../../testing/stubs';
import { databaseConfigFactory } from '../../config/database.config';
import { MIGRATIONS } from '../../migrations';
import {
  MIGRATIONS_TABLE,
  buildDatabaseOptions,
  envReader,
  shouldRunMigrationsOnBoot,
  sslOptions,
} from './database-options';
import { ENTITIES } from './entities';

const read = (env: Record<string, string | undefined>) => envReader(env);

describe('database options', () => {
  it('falls back to the local development database', () => {
    const options = buildDatabaseOptions(read({}));

    expect(options).toMatchObject({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'payment_db',
      ssl: false,
      migrationsTableName: MIGRATIONS_TABLE,
      migrationsTransactionMode: 'each',
    });
    expect(options.entities).toBe(ENTITIES);
    expect(options.migrations).toBe(MIGRATIONS);
  });

  it('reads every connection variable and trims it', () => {
    const options = buildDatabaseOptions(
      read({
        DATABASE_HOST: ' db.internal ',
        DATABASE_PORT: '6432',
        DATABASE_USER: 'rail',
        DATABASE_PASSWORD: 'secret',
        DATABASE_NAME: 'payments',
      }),
    );

    expect(options).toMatchObject({
      host: 'db.internal',
      port: 6432,
      username: 'rail',
      password: 'secret',
      database: 'payments',
    });
  });

  it('treats an empty variable as unset', () => {
    expect(buildDatabaseOptions(read({ DATABASE_HOST: '', DATABASE_PORT: '  ' }))).toMatchObject({
      host: 'localhost',
      port: 5432,
    });
  });

  it.each(['abc', '0', '70000', '54.3'])('refuses DATABASE_PORT=%p instead of connecting somewhere else', (value) => {
    expect(() => buildDatabaseOptions(read({ DATABASE_PORT: value }))).toThrow(/DATABASE_PORT/);
  });

  describe('ssl', () => {
    it('is off unless DATABASE_SSL=true', () => {
      expect(sslOptions(read({}))).toBe(false);
      expect(sslOptions(read({ DATABASE_SSL: 'yes' }))).toBe(false);
    });

    it('checks the server certificate by default', () => {
      expect(sslOptions(read({ DATABASE_SSL: 'TRUE' }))).toEqual({ rejectUnauthorized: true });
    });

    it('can skip the check for a self-signed staging server', () => {
      expect(
        sslOptions(read({ DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' })),
      ).toEqual({ rejectUnauthorized: false });
    });

    it('takes the CA inline and restores escaped newlines', () => {
      const tls = sslOptions(
        read({ DATABASE_SSL: 'true', DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----' }),
      );

      expect(tls).toEqual({
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      });
    });
  });

  it('runs migrations on boot only when asked to', () => {
    expect(shouldRunMigrationsOnBoot(read({}))).toBe(false);
    expect(shouldRunMigrationsOnBoot(read({ DATABASE_RUN_MIGRATIONS: 'true' }))).toBe(true);
    expect(shouldRunMigrationsOnBoot(read({ DATABASE_RUN_MIGRATIONS: '1' }))).toBe(false);
  });
});

describe('databaseConfigFactory', () => {
  it('keeps schema sync on locally and never runs migrations on top of it', () => {
    const options = databaseConfigFactory(configStub({ DATABASE_RUN_MIGRATIONS: 'true' }));

    expect(options).toMatchObject({ synchronize: true, migrationsRun: false, autoLoadEntities: true });
  });

  it('turns sync off on mainnet and leaves the migrations to the deploy step', () => {
    const options = databaseConfigFactory(configStub({ NETWORK_PROFILE: 'mainnet' }));

    expect(options).toMatchObject({ synchronize: false, migrationsRun: false });
  });

  it('applies pending migrations on boot when sync is off and DATABASE_RUN_MIGRATIONS=true', () => {
    const options = databaseConfigFactory(
      configStub({ DATABASE_SYNCHRONIZE: 'false', DATABASE_RUN_MIGRATIONS: 'true' }),
    );

    expect(options).toMatchObject({ synchronize: false, migrationsRun: true });
  });

  it('accepts numbers from ConfigService as well as strings', () => {
    const options = databaseConfigFactory(configStub({ DATABASE_PORT: 55433 }));

    expect(options).toMatchObject({ port: 55433, migrationsTableName: MIGRATIONS_TABLE });
  });
});
