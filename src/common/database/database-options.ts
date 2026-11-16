import { TlsOptions } from 'tls';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { MIGRATIONS } from '../../migrations';
import { ENTITIES } from './entities';

/**
 * Connection settings shared by the application (TypeOrmModule) and the
 * migration CLI (`src/common/database/data-source.ts`). Both must agree on the
 * server, the schema history table and the migration list, or `migration:run`
 * would write to a different place than the one the service reads.
 */

/** Reads one variable; the app passes ConfigService, the CLI passes process.env. */
export type EnvReader = (name: string) => string | undefined;

export const MIGRATIONS_TABLE = 'schema_migrations';

export const envReader =
  (env: Record<string, string | undefined>): EnvReader =>
  (name) =>
    env[name];

function text(read: EnvReader, name: string, fallback: string): string {
  const value = read(name);
  return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
}

function port(read: EnvReader): number {
  const raw = text(read, 'DATABASE_PORT', '5432');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`DATABASE_PORT "${raw}" is not a valid port`);
  }
  return parsed;
}

/**
 * TLS towards Postgres. Managed databases require it; a laptop does not have
 * it. `DATABASE_SSL=true` turns it on with certificate checks; the CA can be
 * given inline (`DATABASE_SSL_CA`, PEM). Turning the check off
 * (`DATABASE_SSL_REJECT_UNAUTHORIZED=false`) is possible for a self-signed
 * staging server and refused on mainnet by startup validation.
 */
export function sslOptions(read: EnvReader): TlsOptions | false {
  if (text(read, 'DATABASE_SSL', 'false').toLowerCase() !== 'true') return false;
  const tls: TlsOptions = {
    rejectUnauthorized: text(read, 'DATABASE_SSL_REJECT_UNAUTHORIZED', 'true').toLowerCase() !== 'false',
  };
  const ca = text(read, 'DATABASE_SSL_CA', '');
  // Kubernetes secrets and .env files often carry the PEM with literal "\n".
  if (ca !== '') tls.ca = ca.replace(/\\n/g, '\n');
  return tls;
}

/** Everything about the connection except how the schema gets created. */
export function buildDatabaseOptions(read: EnvReader): PostgresConnectionOptions {
  return {
    type: 'postgres',
    host: text(read, 'DATABASE_HOST', 'localhost'),
    port: port(read),
    username: text(read, 'DATABASE_USER', 'postgres'),
    password: text(read, 'DATABASE_PASSWORD', 'postgres'),
    database: text(read, 'DATABASE_NAME', 'payment_db'),
    ssl: sslOptions(read),
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: MIGRATIONS_TABLE,
    // One transaction per migration: a failure leaves the schema at the last
    // migration that went through, and `migration:run` can simply be repeated.
    migrationsTransactionMode: 'each',
  };
}

/**
 * Whether the service applies pending migrations itself on boot. Off by
 * default: with several replicas the migrations run once, from a deploy step
 * (`npm run migration:run`, or the release job in Kubernetes), before the new
 * version starts. A single-instance setup can let the service do it.
 */
export function shouldRunMigrationsOnBoot(read: EnvReader): boolean {
  return text(read, 'DATABASE_RUN_MIGRATIONS', 'false').toLowerCase() === 'true';
}
