import { ethers } from 'ethers';
import { resolveNetworkProfile } from './network.config';

/**
 * Startup validation of the environment.
 *
 * Wired into ConfigModule (`validate`), so it runs before any module is
 * built: with an unsafe mainnet configuration the process exits with a list of
 * everything that is wrong, instead of starting and moving real funds with a
 * development key or a default secret.
 *
 * Only the mainnet profile is held to these rules. `local` and `testnet` keep
 * working with the defaults that make a laptop setup painless, which are
 * exactly the values refused here.
 */

export interface ConfigViolation {
  variable: string;
  message: string;
}

type Env = Record<string, unknown>;

export const MIN_MAINNET_CONFIRMATIONS = 6;
const MIN_SECRET_LENGTH = 32;

// Published everywhere; funds sent to these addresses are swept within seconds.
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const DEV_KEY_COUNT = 10;
const DEFAULT_SECRETS = new Set([
  'dev-secret-change-me',
  'change-me-in-production',
  'dev-csrf-secret-change-me',
  'ci-secret-not-used-outside-ci',
  'ci-csrf-not-used-outside-ci',
]);
const DEFAULT_DATABASE_PASSWORDS = new Set(['postgres', 'password', 'admin', 'root']);
// anvil/hardhat, ganache, prom-testnet
const NON_MAINNET_CHAIN_IDS = new Set([31337, 1337, 71234]);
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|anvil|host\.docker\.internal)$/i;

let devKeys: Set<string> | undefined;

/** Private keys of the well-known anvil/hardhat accounts, derived once. */
function knownDevKeys(): Set<string> {
  if (!devKeys) {
    devKeys = new Set();
    for (let index = 0; index < DEV_KEY_COUNT; index += 1) {
      const path = `m/44'/60'/0'/0/${index}`;
      devKeys.add(ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, path).privateKey.toLowerCase());
    }
  }
  return devKeys;
}

function text(env: Env, name: string): string {
  const value = env[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Everything that makes this environment unsafe for mainnet; empty when it is fine. */
export function findUnsafeMainnetSettings(env: Env): ConfigViolation[] {
  const violations: ConfigViolation[] = [];
  const refuse = (variable: string, message: string) => violations.push({ variable, message });

  if (text(env, 'NODE_ENV') !== 'production') {
    refuse('NODE_ENV', 'must be "production" on mainnet');
  }

  // --- chain ---------------------------------------------------------------
  const chainId = Number(text(env, 'CHAIN_ID'));
  if (text(env, 'CHAIN_ID') === '' || !Number.isInteger(chainId) || chainId <= 0) {
    refuse('CHAIN_ID', 'must be set to the mainnet chain id');
  } else if (NON_MAINNET_CHAIN_IDS.has(chainId)) {
    refuse('CHAIN_ID', `${chainId} is a development or testnet chain id`);
  }

  const rpcUrl = text(env, 'BLOCKCHAIN_RPC_URL');
  const rpcHost = hostOf(rpcUrl);
  if (rpcUrl === '' || rpcHost === null) {
    refuse('BLOCKCHAIN_RPC_URL', 'must be set to the mainnet RPC endpoint');
  } else if (!/^(https|wss):\/\//i.test(rpcUrl)) {
    refuse('BLOCKCHAIN_RPC_URL', 'must use https or wss: transactions and balances are read over this link');
  } else if (LOCAL_HOST.test(rpcHost)) {
    refuse('BLOCKCHAIN_RPC_URL', `"${rpcHost}" is a local node, not mainnet`);
  }

  const privateKey = text(env, 'BLOCKCHAIN_PRIVATE_KEY').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) {
    refuse('BLOCKCHAIN_PRIVATE_KEY', 'must be set to a 32-byte hex key (without it the anvil development key is used)');
  } else if (knownDevKeys().has(privateKey)) {
    refuse('BLOCKCHAIN_PRIVATE_KEY', 'is a published anvil/hardhat development key');
  }

  const previousKey = text(env, 'BLOCKCHAIN_PREVIOUS_PRIVATE_KEY').toLowerCase();
  if (previousKey !== '' && knownDevKeys().has(previousKey)) {
    // During the overlap this key is still accepted as the rail's signature.
    refuse('BLOCKCHAIN_PREVIOUS_PRIVATE_KEY', 'is a published anvil/hardhat development key');
  }

  const hub = text(env, 'ESCROW_HUB_ADDRESS');
  if (!/^0x[0-9a-fA-F]{40}$/.test(hub)) {
    refuse('ESCROW_HUB_ADDRESS', 'must be set to the deployed EscrowHub address');
  } else if (/^0x0{40}$/.test(hub)) {
    refuse('ESCROW_HUB_ADDRESS', 'is the zero address');
  }

  const confirmations = text(env, 'TX_CONFIRMATIONS');
  if (confirmations !== '' && !(Number(confirmations) >= MIN_MAINNET_CONFIRMATIONS)) {
    refuse('TX_CONFIRMATIONS', `must be at least ${MIN_MAINNET_CONFIRMATIONS} on mainnet (profile default: 12)`);
  }
  const feeCap = text(env, 'MAX_FEE_PER_GAS_GWEI');
  if (feeCap !== '' && !(Number(feeCap) > 0)) {
    refuse('MAX_FEE_PER_GAS_GWEI', 'must be above 0: the fee cap cannot be switched off on mainnet');
  }

  // --- secrets -------------------------------------------------------------
  for (const name of ['JWT_SECRET', 'CSRF_SECRET']) {
    const secret = text(env, name);
    if (secret === '') refuse(name, 'must be set (the built-in default is public)');
    else if (DEFAULT_SECRETS.has(secret)) refuse(name, 'is a default value from the repository');
    else if (secret.length < MIN_SECRET_LENGTH) {
      refuse(name, `must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (text(env, 'JWT_SECRET') !== '' && text(env, 'JWT_SECRET') === text(env, 'CSRF_SECRET')) {
    refuse('CSRF_SECRET', 'must differ from JWT_SECRET');
  }

  // --- database ------------------------------------------------------------
  const dbPassword = text(env, 'DATABASE_PASSWORD');
  if (dbPassword === '' || DEFAULT_DATABASE_PASSWORDS.has(dbPassword.toLowerCase())) {
    refuse('DATABASE_PASSWORD', 'must be set to a non-default password');
  }
  if (text(env, 'DATABASE_SYNCHRONIZE') === 'true' && text(env, 'MAINNET_ALLOW_SCHEMA_SYNC') !== 'true') {
    refuse(
      'DATABASE_SYNCHRONIZE',
      'schema sync rewrites tables on boot; on mainnet it also needs MAINNET_ALLOW_SCHEMA_SYNC=true, for the one deploy that changes the schema',
    );
  }

  // --- http surface --------------------------------------------------------
  const origins = text(env, 'CORS_ORIGINS').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    refuse('CORS_ORIGINS', 'must list the allowed origins (the default is http://localhost:3000)');
  }
  for (const origin of origins) {
    const host = hostOf(origin);
    if (origin === '*' || host === null) refuse('CORS_ORIGINS', `"${origin}" is not an explicit origin`);
    else if (!origin.toLowerCase().startsWith('https://')) refuse('CORS_ORIGINS', `"${origin}" must use https`);
    else if (LOCAL_HOST.test(host)) refuse('CORS_ORIGINS', `"${origin}" is a local origin`);
  }
  if (text(env, 'HSTS_ENABLED') === 'false') {
    refuse('HSTS_ENABLED', 'must not be disabled on mainnet');
  }
  if (text(env, 'WEBHOOK_ALLOW_HTTP') === 'true') {
    refuse('WEBHOOK_ALLOW_HTTP', 'payment events must not be delivered over plain http');
  }

  return violations;
}

/**
 * `validate` hook of ConfigModule.forRoot. Returns the config untouched or
 * throws with every violation listed, one per line.
 */
export function validateConfig(env: Env): Env {
  // Throws on an unknown NETWORK_PROFILE, whichever profile was meant.
  const profile = resolveNetworkProfile(env as Record<string, string | undefined>);
  if (profile.name !== 'mainnet') return env;

  const violations = findUnsafeMainnetSettings(env);
  if (violations.length > 0) {
    throw new Error(
      `Refusing to start with NETWORK_PROFILE=mainnet: ${violations.length} unsafe setting(s)\n` +
        violations.map(({ variable, message }) => `  - ${variable}: ${message}`).join('\n'),
    );
  }
  return env;
}
