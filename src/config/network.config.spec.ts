import { ethers } from 'ethers';
import { getChain } from '../blockchain/chain-registry';
import { BlockchainService } from '../common/blockchain/blockchain.service';
import { SignerKeyringService } from '../common/blockchain/signer-keyring.service';
import { configStub } from '../testing/stubs';
import networkConfig, { NETWORK_PROFILES, resolveNetworkProfile } from './network.config';

describe('network profiles', () => {
  it('defaults to the local profile', () => {
    expect(resolveNetworkProfile({})).toEqual(NETWORK_PROFILES.local);
    expect(resolveNetworkProfile({}).confirmations).toBe(1);
  });

  it('gives mainnet conservative finality and a fee cap', () => {
    expect(resolveNetworkProfile({ NETWORK_PROFILE: 'mainnet' })).toEqual({
      name: 'mainnet',
      chainName: 'prom-mainnet',
      confirmations: 12,
      confirmationTimeoutMs: 600_000,
      maxFeePerGasGwei: 50,
      maxPriorityFeePerGasGwei: 2,
    });
  });

  it('is stricter on mainnet than on every other profile, in every dimension', () => {
    const { mainnet, ...others } = NETWORK_PROFILES;
    for (const profile of Object.values(others)) {
      expect(mainnet.confirmations).toBeGreaterThan(profile.confirmations);
    }
    expect(mainnet.confirmationTimeoutMs).toBeGreaterThan(0);
    expect(mainnet.maxFeePerGasGwei).toBeGreaterThan(0);
    expect(mainnet.maxPriorityFeePerGasGwei).toBeLessThanOrEqual(mainnet.maxFeePerGasGwei);
  });

  it('keeps the testnet profile in step with the built-in registry entry', () => {
    const registered = getChain(71234);
    expect(NETWORK_PROFILES.testnet).toMatchObject({
      chainName: registered.name,
      confirmations: registered.confirmations,
      maxFeePerGasGwei: registered.maxFeePerGasGwei,
      maxPriorityFeePerGasGwei: registered.maxPriorityFeePerGasGwei,
    });
  });

  it.each(['MAINNET', ' mainnet ', 'Mainnet'])('reads the profile name %p leniently', (name) => {
    expect(resolveNetworkProfile({ NETWORK_PROFILE: name }).name).toBe('mainnet');
  });

  it.each(['prod', 'main', 'mainnet2', ''])('refuses the unknown profile %p', (name) => {
    // '' is what a mistyped secret reference tends to resolve to
    const env = { NETWORK_PROFILE: name };
    if (name === '') expect(() => resolveNetworkProfile(env)).toThrow(/is not one of: local, testnet, mainnet/);
    else expect(() => resolveNetworkProfile(env)).toThrow(`NETWORK_PROFILE "${name}" is not one of`);
  });

  it('applies single-value overrides on top of the profile', () => {
    const profile = resolveNetworkProfile({
      NETWORK_PROFILE: 'mainnet',
      TX_CONFIRMATIONS: '20',
      TX_CONFIRMATION_TIMEOUT_MS: '900000',
      MAX_FEE_PER_GAS_GWEI: '12.5',
    });

    expect(profile).toMatchObject({
      confirmations: 20,
      confirmationTimeoutMs: 900_000,
      maxFeePerGasGwei: 12.5,
      maxPriorityFeePerGasGwei: 2,
    });
  });

  it.each(['', '  ', 'twelve', '-3', 'NaN'])(
    'falls back to the profile value when an override is %p',
    (value) => {
      const profile = resolveNetworkProfile({ NETWORK_PROFILE: 'mainnet', TX_CONFIRMATIONS: value });
      expect(profile.confirmations).toBe(12);
    },
  );

  it('floors a fractional confirmation count', () => {
    expect(resolveNetworkProfile({ TX_CONFIRMATIONS: '7.9' }).confirmations).toBe(7);
  });

  describe('config factory', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('registers the configured chain under the mainnet name with the profile numbers', () => {
      process.env.NETWORK_PROFILE = 'mainnet';
      process.env.CHAIN_ID = '880011';
      process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.mainnet.example';

      const profile = networkConfig();

      expect(profile.name).toBe('mainnet');
      expect(getChain(880011)).toEqual({
        chainId: 880011,
        name: 'prom-mainnet',
        rpcUrl: 'https://rpc.mainnet.example',
        confirmations: 12,
        maxFeePerGasGwei: 50,
        maxPriorityFeePerGasGwei: 2,
      });
    });

    it('leaves the built-in testnet entry alone', () => {
      process.env.NETWORK_PROFILE = 'testnet';
      process.env.CHAIN_ID = '71234';
      process.env.BLOCKCHAIN_RPC_URL = 'https://should-not-replace.example';

      networkConfig();

      expect(getChain(71234).rpcUrl).not.toBe('https://should-not-replace.example');
    });

    it('registers nothing without a chain id', () => {
      process.env.NETWORK_PROFILE = 'mainnet';
      delete process.env.CHAIN_ID;

      expect(() => networkConfig()).not.toThrow();
    });
  });
});

describe('BlockchainService under the mainnet profile', () => {
  const KEY = '0x' + '5a'.repeat(32);
  let service: BlockchainService;

  beforeEach(() => {
    const profile = resolveNetworkProfile({ NETWORK_PROFILE: 'mainnet' });
    const config = configStub({
      'blockchain.rpcUrl': 'http://127.0.0.1:1',
      'blockchain.privateKey': KEY,
      'network.name': profile.name,
      'network.confirmations': profile.confirmations,
      'network.confirmationTimeoutMs': profile.confirmationTimeoutMs,
      'network.maxFeePerGasGwei': profile.maxFeePerGasGwei,
    });
    service = new BlockchainService(config, new SignerKeyringService(config));
    service.onModuleInit();
  });

  afterEach(() => {
    service.getProvider().destroy();
  });

  it('signs with the configured key', async () => {
    expect(await service.getWalletAddress()).toBe(new ethers.Wallet(KEY).address);
  });

  it('waits for twelve confirmations with a ten minute ceiling', async () => {
    const receipt = { hash: '0xabc' };
    const tx = { hash: '0xabc', wait: jest.fn().mockResolvedValue(receipt) };

    await expect(service.waitFor(tx)).resolves.toBe(receipt);

    expect(service.confirmations).toBe(12);
    expect(tx.wait).toHaveBeenCalledWith(12, 600_000);
  });

  it('passes the timeout of the wait on to the caller', async () => {
    const timeout = Object.assign(new Error('wait for transaction timeout'), { code: 'TIMEOUT' });
    const tx = { hash: '0xabc', wait: jest.fn().mockRejectedValue(timeout) };

    await expect(service.waitFor(tx)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('treats a missing receipt as a failure, never as success', async () => {
    const tx = { hash: '0xabc', wait: jest.fn().mockResolvedValue(null) };
    await expect(service.waitFor(tx)).rejects.toThrow('Transaction 0xabc has no receipt');
  });

  it.each([
    ['at the cap', 50n, true],
    ['one wei above the cap', 50n * 10n ** 9n + 1n, false],
    ['far above the cap', 400n * 10n ** 9n, false],
  ])('fee %s', async (_label, fee, allowed) => {
    const maxFeePerGas = fee < 10n ** 6n ? fee * 10n ** 9n : fee;
    service.getProvider().getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas, gasPrice: null });

    if (allowed) await expect(service.assertGasWithinCap()).resolves.toBeUndefined();
    else await expect(service.assertGasWithinCap()).rejects.toMatchObject({ code: 'GAS_PRICE_ABOVE_CAP' });
  });

  it('falls back to the legacy gas price on chains without EIP-1559', async () => {
    service.getProvider().getFeeData = jest
      .fn()
      .mockResolvedValue({ maxFeePerGas: null, gasPrice: 80n * 10n ** 9n });

    await expect(service.assertGasWithinCap()).rejects.toThrow(/80 gwei is above the cap of 50 gwei/);
  });
});
