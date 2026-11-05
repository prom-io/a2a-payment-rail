import { SAFE_MAINNET_ENV } from '../testing/mainnet-env';
import { findUnsafeMainnetSettings, validateConfig } from './config-validation';

const variables = (env: Record<string, unknown>) =>
  findUnsafeMainnetSettings(env).map((violation) => violation.variable);

describe('startup config validation', () => {
  it('accepts a safe mainnet environment', () => {
    expect(findUnsafeMainnetSettings(SAFE_MAINNET_ENV)).toEqual([]);
    expect(validateConfig(SAFE_MAINNET_ENV)).toBe(SAFE_MAINNET_ENV);
  });

  it('does not hold the local and testnet profiles to mainnet rules', () => {
    expect(validateConfig({})).toEqual({});
    expect(() => validateConfig({ NETWORK_PROFILE: 'local' })).not.toThrow();
    expect(() => validateConfig({ NETWORK_PROFILE: 'testnet', JWT_SECRET: 'short' })).not.toThrow();
  });

  it('refuses an unknown profile whatever else is set', () => {
    expect(() => validateConfig({ ...SAFE_MAINNET_ENV, NETWORK_PROFILE: 'mainet' })).toThrow(
      /NETWORK_PROFILE "mainet" is not one of/,
    );
  });

  it('refuses the anvil development key', () => {
    const env = {
      ...SAFE_MAINNET_ENV,
      BLOCKCHAIN_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    };
    expect(findUnsafeMainnetSettings(env)).toEqual([
      { variable: 'BLOCKCHAIN_PRIVATE_KEY', message: 'is a published anvil/hardhat development key' },
    ]);
  });

  it('refuses a missing signer key, which would fall back to the development key', () => {
    const { BLOCKCHAIN_PRIVATE_KEY: _omitted, ...env } = SAFE_MAINNET_ENV;
    expect(variables(env)).toEqual(['BLOCKCHAIN_PRIVATE_KEY']);
  });

  it('refuses default and short secrets', () => {
    expect(variables({ ...SAFE_MAINNET_ENV, JWT_SECRET: 'dev-secret-change-me' })).toEqual(['JWT_SECRET']);
    expect(variables({ ...SAFE_MAINNET_ENV, CSRF_SECRET: 'too-short' })).toEqual(['CSRF_SECRET']);
  });

  it('refuses a local RPC endpoint and a zero hub address', () => {
    expect(variables({ ...SAFE_MAINNET_ENV, BLOCKCHAIN_RPC_URL: 'http://localhost:8545' })).toEqual([
      'BLOCKCHAIN_RPC_URL',
    ]);
    expect(variables({ ...SAFE_MAINNET_ENV, ESCROW_HUB_ADDRESS: '0x' + '0'.repeat(40) })).toEqual([
      'ESCROW_HUB_ADDRESS',
    ]);
  });

  it('reports every problem at once so one restart is enough to see them all', () => {
    let message = '';
    try {
      validateConfig({ NETWORK_PROFILE: 'mainnet' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/^Refusing to start with NETWORK_PROFILE=mainnet: 9 unsafe setting\(s\)/);
    for (const variable of [
      'NODE_ENV',
      'CHAIN_ID',
      'BLOCKCHAIN_RPC_URL',
      'BLOCKCHAIN_PRIVATE_KEY',
      'ESCROW_HUB_ADDRESS',
      'JWT_SECRET',
      'CSRF_SECRET',
      'DATABASE_PASSWORD',
      'CORS_ORIGINS',
    ]) {
      expect(message).toContain(`  - ${variable}: `);
    }
  });

  it('never prints a secret value in the error', () => {
    const env = { ...SAFE_MAINNET_ENV, JWT_SECRET: 'hunter2-hunter2', DATABASE_PASSWORD: 'postgres' };
    let message = '';
    try {
      validateConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(SAFE_MAINNET_ENV.BLOCKCHAIN_PRIVATE_KEY);
  });
});
