import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { configStub } from '../testing/stubs';
import { SAFE_MAINNET_ENV } from '../testing/mainnet-env';
import {
  findUnsafeMainnetSettings,
  MIN_MAINNET_CONFIRMATIONS,
  validateConfig,
} from './config-validation';
import { databaseConfigFactory, shouldSynchronize } from './database.config';

const REPO_ROOT = join(__dirname, '..', '..');
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];

const refusalsFor = (overrides: Record<string, string | undefined>) => {
  const env: Record<string, string | undefined> = { ...SAFE_MAINNET_ENV, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return findUnsafeMainnetSettings(env);
};

describe('mainnet config validation: every refusal', () => {
  // [variable, value (undefined = unset), expected fragment of the message]
  const REFUSED: Array<[string, string | undefined, RegExp]> = [
    ['NODE_ENV', 'development', /must be "production"/],
    ['NODE_ENV', undefined, /must be "production"/],
    ['NODE_ENV', 'test', /must be "production"/],

    ['CHAIN_ID', undefined, /must be set/],
    ['CHAIN_ID', 'mainnet', /must be set/],
    ['CHAIN_ID', '0', /must be set/],
    ['CHAIN_ID', '-5', /must be set/],
    ['CHAIN_ID', '1.5', /must be set/],
    ['CHAIN_ID', '31337', /development or testnet/],
    ['CHAIN_ID', '1337', /development or testnet/],
    ['CHAIN_ID', '71234', /development or testnet/],

    ['BLOCKCHAIN_RPC_URL', undefined, /must be set/],
    ['BLOCKCHAIN_RPC_URL', 'not a url', /must be set/],
    ['BLOCKCHAIN_RPC_URL', 'http://rpc.mainnet.example', /https or wss/],
    ['BLOCKCHAIN_RPC_URL', 'ws://rpc.mainnet.example', /https or wss/],
    ['BLOCKCHAIN_RPC_URL', 'https://localhost:8545', /local node/],
    ['BLOCKCHAIN_RPC_URL', 'https://127.0.0.1:8545', /local node/],
    ['BLOCKCHAIN_RPC_URL', 'https://anvil:8545', /local node/],
    ['BLOCKCHAIN_RPC_URL', 'https://host.docker.internal:8545', /local node/],

    ['BLOCKCHAIN_PRIVATE_KEY', undefined, /32-byte hex key/],
    ['BLOCKCHAIN_PRIVATE_KEY', '0x1234', /32-byte hex key/],
    ['BLOCKCHAIN_PRIVATE_KEY', '4f'.repeat(32), /32-byte hex key/],
    ...ANVIL_KEYS.map((key): [string, string, RegExp] => ['BLOCKCHAIN_PRIVATE_KEY', key, /development key/]),
    ['BLOCKCHAIN_PRIVATE_KEY', ANVIL_KEYS[0].toUpperCase().replace('0X', '0x'), /development key/],
    ['BLOCKCHAIN_PREVIOUS_PRIVATE_KEY', ANVIL_KEYS[1], /development key/],

    ['ESCROW_HUB_ADDRESS', undefined, /must be set/],
    ['ESCROW_HUB_ADDRESS', '', /must be set/],
    ['ESCROW_HUB_ADDRESS', '0xabc', /must be set/],
    ['ESCROW_HUB_ADDRESS', '0x' + '0'.repeat(40), /zero address/],

    ['TX_CONFIRMATIONS', '1', /at least 6/],
    ['TX_CONFIRMATIONS', '5', /at least 6/],
    ['TX_CONFIRMATIONS', 'many', /at least 6/],
    ['MAX_FEE_PER_GAS_GWEI', '0', /cannot be switched off/],
    ['MAX_FEE_PER_GAS_GWEI', '-1', /cannot be switched off/],

    ['JWT_SECRET', undefined, /must be set/],
    ['JWT_SECRET', 'dev-secret-change-me', /default value/],
    ['JWT_SECRET', 'change-me-in-production', /default value/],
    ['JWT_SECRET', 'ci-secret-not-used-outside-ci', /default value/],
    ['JWT_SECRET', 'x'.repeat(31), /at least 32 characters/],
    ['CSRF_SECRET', undefined, /must be set/],
    ['CSRF_SECRET', 'dev-csrf-secret-change-me', /default value/],
    ['CSRF_SECRET', 'short', /at least 32 characters/],
    ['CSRF_SECRET', SAFE_MAINNET_ENV.JWT_SECRET, /must differ from JWT_SECRET/],

    ['DATABASE_PASSWORD', undefined, /non-default password/],
    ['DATABASE_PASSWORD', 'postgres', /non-default password/],
    ['DATABASE_PASSWORD', 'Postgres', /non-default password/],
    ['DATABASE_PASSWORD', 'password', /non-default password/],
    ['DATABASE_SYNCHRONIZE', 'true', /MAINNET_ALLOW_SCHEMA_SYNC=true/],

    ['CORS_ORIGINS', undefined, /must list the allowed origins/],
    ['CORS_ORIGINS', '', /must list the allowed origins/],
    ['CORS_ORIGINS', '*', /not an explicit origin/],
    ['CORS_ORIGINS', 'console.example', /not an explicit origin/],
    ['CORS_ORIGINS', 'http://console.example', /must use https/],
    ['CORS_ORIGINS', 'https://localhost:3000', /local origin/],
    ['CORS_ORIGINS', 'https://console.example,http://localhost:3000', /must use https/],

    ['HSTS_ENABLED', 'false', /must not be disabled/],
    ['WEBHOOK_ALLOW_HTTP', 'true', /plain http/],
  ];

  it.each(REFUSED)('%s=%p is refused', (variable, value, message) => {
    const violations = refusalsFor({ [variable]: value });

    expect(violations.map((violation) => violation.variable)).toEqual([variable]);
    expect(violations[0].message).toMatch(message);
    // and the same environment cannot boot
    expect(() => validateConfig({ ...SAFE_MAINNET_ENV, [variable]: value })).toThrow(
      /Refusing to start with NETWORK_PROFILE=mainnet/,
    );
  });

  it('covers every variable the validator knows about', () => {
    const everything = findUnsafeMainnetSettings({
      BLOCKCHAIN_PREVIOUS_PRIVATE_KEY: ANVIL_KEYS[2],
      TX_CONFIRMATIONS: '1',
      MAX_FEE_PER_GAS_GWEI: '0',
      DATABASE_SYNCHRONIZE: 'true',
      HSTS_ENABLED: 'false',
      WEBHOOK_ALLOW_HTTP: 'true',
    }).map((violation) => violation.variable);

    expect([...new Set(everything)].sort()).toEqual([...new Set(REFUSED.map(([variable]) => variable))].sort());
  });
});

describe('mainnet config validation: what stays allowed', () => {
  const ACCEPTED: Array<[string, Record<string, string>]> = [
    ['a websocket RPC over TLS', { BLOCKCHAIN_RPC_URL: 'wss://rpc.mainnet.example/ws' }],
    ['the minimum confirmation override', { TX_CONFIRMATIONS: String(MIN_MAINNET_CONFIRMATIONS) }],
    ['more confirmations than the profile', { TX_CONFIRMATIONS: '64' }],
    ['a tighter fee cap', { MAX_FEE_PER_GAS_GWEI: '10' }],
    ['a single origin', { CORS_ORIGINS: 'https://console.example' }],
    ['origins with spaces after the comma', { CORS_ORIGINS: 'https://a.example, https://b.example' }],
    ['schema sync explicitly off', { DATABASE_SYNCHRONIZE: 'false' }],
    ['schema sync with the mainnet acknowledgement', { DATABASE_SYNCHRONIZE: 'true', MAINNET_ALLOW_SCHEMA_SYNC: 'true' }],
    ['HSTS explicitly on', { HSTS_ENABLED: 'true' }],
    ['webhooks explicitly https-only', { WEBHOOK_ALLOW_HTTP: 'false' }],
    ['a real previous signer key during a rotation', { BLOCKCHAIN_PREVIOUS_PRIVATE_KEY: '0x' + '7c'.repeat(32) }],
    ['a 32 character secret', { JWT_SECRET: 'k'.repeat(32) }],
    ['the emergency pause set from the environment', { EMERGENCY_PAUSE: 'all' }],
  ];

  it.each(ACCEPTED)('%s', (_label, overrides) => {
    expect(refusalsFor(overrides)).toEqual([]);
  });

  it('the acknowledgement alone does not switch schema sync on', () => {
    const config = configStub({ NETWORK_PROFILE: 'mainnet', MAINNET_ALLOW_SCHEMA_SYNC: 'true' });
    expect(shouldSynchronize(config)).toBe(false);
  });
});

describe('ConfigModule wiring', () => {
  const saved = { ...process.env };
  // forRoot is synchronous in some @nestjs/config releases and returns a
  // promise in others; the async wrapper makes the test indifferent to that.
  const boot = async () => ConfigModule.forRoot({ ignoreEnvFile: true, validate: validateConfig });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('boots with a safe mainnet environment', async () => {
    Object.assign(process.env, SAFE_MAINNET_ENV);
    await expect(boot()).resolves.toBeDefined();
  });

  it('boots with no profile at all, as CI and local development do', async () => {
    delete process.env.NETWORK_PROFILE;
    await expect(boot()).resolves.toBeDefined();
  });

  it('refuses to build the module with the development key on mainnet', async () => {
    Object.assign(process.env, SAFE_MAINNET_ENV, { BLOCKCHAIN_PRIVATE_KEY: ANVIL_KEYS[0] });
    await expect(boot()).rejects.toThrow(
      /BLOCKCHAIN_PRIVATE_KEY: is a published anvil\/hardhat development key/,
    );
  });

  it('refuses a mainnet profile on top of an otherwise local environment', async () => {
    for (const key of Object.keys(SAFE_MAINNET_ENV)) delete process.env[key];
    process.env.NETWORK_PROFILE = 'mainnet';
    await expect(boot()).rejects.toThrow(
      /Refusing to start with NETWORK_PROFILE=mainnet: 9 unsafe setting\(s\)/,
    );
  });

  it('refuses a misspelled profile instead of running it as local', async () => {
    process.env.NETWORK_PROFILE = 'mainnnet';
    await expect(boot()).rejects.toThrow(/NETWORK_PROFILE "mainnnet" is not one of/);
  });
});

describe('schema sync by profile', () => {
  it.each([
    [{}, true],
    [{ NETWORK_PROFILE: 'local' }, true],
    [{ NETWORK_PROFILE: 'testnet' }, true],
    [{ NETWORK_PROFILE: 'mainnet' }, false],
    [{ NETWORK_PROFILE: 'MAINNET' }, false],
    [{ NETWORK_PROFILE: 'mainnet', DATABASE_SYNCHRONIZE: 'true' }, true],
    [{ NETWORK_PROFILE: 'mainnet', DATABASE_SYNCHRONIZE: 'false' }, false],
    [{ NETWORK_PROFILE: 'mainnet', DATABASE_SYNCHRONIZE: '' }, false],
    [{ NETWORK_PROFILE: 'local', DATABASE_SYNCHRONIZE: 'false' }, false],
    [{ NETWORK_PROFILE: 'local', DATABASE_SYNCHRONIZE: 'yes' }, false],
  ])('%p -> synchronize %p', (env, expected) => {
    expect(shouldSynchronize(configStub(env))).toBe(expected);
  });

  it('feeds the decision into the TypeORM options', () => {
    const options = (env: Record<string, string>) =>
      databaseConfigFactory(configStub(env) as ConfigService) as { synchronize?: boolean; database?: string };

    expect(options({ NETWORK_PROFILE: 'mainnet', DATABASE_NAME: 'rail' })).toMatchObject({
      synchronize: false,
      database: 'rail',
    });
    expect(options({}).synchronize).toBe(true);
  });
});

describe('.env.mainnet.example', () => {
  const template = readFileSync(join(REPO_ROOT, '.env.mainnet.example'), 'utf8');
  const lines = template.split(/\r?\n/);
  const active = Object.fromEntries(
    lines.filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const commented = lines
    .map((line) => /^# ([A-Z_]+)=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'testing' ? [] : sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('selects the mainnet profile in production mode', () => {
    expect(active).toMatchObject({ NETWORK_PROFILE: 'mainnet', NODE_ENV: 'production' });
  });

  it('cannot be used without filling it in', () => {
    const refused = findUnsafeMainnetSettings(active).map((violation) => violation.variable);

    expect([...new Set(refused)].sort()).toEqual([
      'BLOCKCHAIN_PRIVATE_KEY',
      'BLOCKCHAIN_RPC_URL',
      'CHAIN_ID',
      'CORS_ORIGINS',
      'CSRF_SECRET',
      'ESCROW_HUB_ADDRESS',
      'JWT_SECRET',
    ]);
  });

  it('passes validation once the placeholders are replaced, with nothing else to change', () => {
    const placeholders = Object.keys(active).filter((name) => /<.*>/.test(active[name]));
    const filled = { ...active };
    for (const name of placeholders) filled[name] = SAFE_MAINNET_ENV[name] ?? 'filled-in';

    expect(findUnsafeMainnetSettings(filled)).toEqual([]);
    expect(() => validateConfig(filled)).not.toThrow();
  });

  it('contains no real-looking secret', () => {
    for (const name of ['BLOCKCHAIN_PRIVATE_KEY', 'JWT_SECRET', 'CSRF_SECRET', 'DATABASE_PASSWORD']) {
      expect(active[name]).toMatch(/^<.*>$/);
    }
    expect(template).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('starts with the jobs that send transactions on their own switched off', () => {
    expect(active.SETTLEMENT_BATCH_ENABLED).toBe('false');
    expect(active.ESCROW_EXPIRY_SWEEP_ENABLED).toBe('false');
    expect(Number(active.RECONCILIATION_INTERVAL_MS)).toBeGreaterThan(0);
  });

  it('keeps the schema sync override and the http webhook switch out of the active lines', () => {
    expect(active.DATABASE_SYNCHRONIZE).toBeUndefined();
    expect(active.MAINNET_ALLOW_SCHEMA_SYNC).toBeUndefined();
    expect(active.WEBHOOK_ALLOW_HTTP).toBeUndefined();
    expect(commented).toEqual(expect.arrayContaining(['DATABASE_SYNCHRONIZE', 'MAINNET_ALLOW_SCHEMA_SYNC']));
  });

  it('only mentions variables the service actually reads', () => {
    const source = sourceFiles(join(REPO_ROOT, 'src')).map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const name of [...Object.keys(active), ...commented]) {
      expect({ name, read: source.includes(name) }).toEqual({ name, read: true });
    }
  });

  it('documents the profile values it leaves to the default', () => {
    expect(template).toContain('# TX_CONFIRMATIONS=12');
    expect(template).toContain('# MAX_FEE_PER_GAS_GWEI=50');
  });
});
