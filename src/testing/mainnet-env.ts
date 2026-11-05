/**
 * A mainnet environment with nothing wrong with it. Specs start from this and
 * break one thing at a time, so each test shows exactly which setting it is about.
 * The values are made up: the chain id and the hosts do not exist.
 */
export const SAFE_MAINNET_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'production',
  NETWORK_PROFILE: 'mainnet',
  CHAIN_ID: '8800',
  BLOCKCHAIN_RPC_URL: 'https://rpc.mainnet.example/v1/key',
  BLOCKCHAIN_PRIVATE_KEY: '0x' + '4f'.repeat(32),
  ESCROW_HUB_ADDRESS: '0x' + 'a1'.repeat(20),
  JWT_SECRET: 'j'.repeat(48),
  CSRF_SECRET: 'c'.repeat(48),
  DATABASE_PASSWORD: 'S3cure-and-long-database-password',
  CORS_ORIGINS: 'https://console.example,https://ops.example',
});
