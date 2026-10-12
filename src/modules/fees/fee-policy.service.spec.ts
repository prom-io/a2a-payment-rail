import { BadRequestException } from '@nestjs/common';
import { configStub } from '../../testing/stubs';
import { computeFee, MAX_FEE_BPS } from './fee-policy';
import { FeePolicyService } from './fee-policy.service';

const ETHER = 10n ** 18n;

function service(config: Record<string, unknown> = {}): FeePolicyService {
  return new FeePolicyService(configStub(config));
}

describe('computeFee', () => {
  it('charges the proportional fee and rounds down', () => {
    expect(computeFee(ETHER, { bps: 50, minFee: 0n, maxFee: null })).toMatchObject({
      fee: 5n * 10n ** 15n,
      net: 995n * 10n ** 15n,
      bound: 'none',
    });
    // 199 * 50 / 10000 = 0.995 -> 0
    expect(computeFee(199n, { bps: 50, minFee: 0n, maxFee: null }).fee).toBe(0n);
    expect(computeFee(200n, { bps: 50, minFee: 0n, maxFee: null }).fee).toBe(1n);
  });

  it('applies the minimum, the cap, and never exceeds the amount', () => {
    const policy = { bps: 100, minFee: 10n, maxFee: 1_000n };
    expect(computeFee(500n, policy)).toMatchObject({ fee: 10n, bound: 'min' });
    expect(computeFee(50_000n, policy)).toMatchObject({ fee: 500n, bound: 'none' });
    expect(computeFee(1_000_000n, policy)).toMatchObject({ fee: 1_000n, bound: 'max' });
    expect(computeFee(4n, policy)).toMatchObject({ fee: 4n, net: 0n, bound: 'amount' });
  });

  it('rejects negative amounts', () => {
    expect(() => computeFee(-1n, { bps: 1, minFee: 0n, maxFee: null })).toThrow(/negative/);
  });
});

describe('FeePolicyService', () => {
  it('defaults to 50 bps on the configured chain, matching the contract', () => {
    expect(service().quote('2')).toEqual({
      chainId: 31337,
      amount: '2.0',
      fee: '0.01',
      net: '1.99',
      bps: 50,
      bound: 'none',
    });
  });

  it('uses the per-chain policy and inherits what it leaves out', () => {
    const fees = service({
      'fees.defaultBps': 50,
      'fees.defaultMaxFee': '1',
      'fees.policies': { '71234': { bps: 30, minFee: '0.001' }, '1': { bps: 0 } },
    });

    expect(fees.quote('10', 71234)).toMatchObject({ fee: '0.03', bps: 30 });
    expect(fees.quote('0.1', 71234)).toMatchObject({ fee: '0.001', bound: 'min' });
    // cap inherited from the default policy
    expect(fees.quote('1000', 71234)).toMatchObject({ fee: '1.0', bound: 'max' });
    expect(fees.quote('10', 1)).toMatchObject({ fee: '0.0', net: '10.0' });
    expect(fees.quote('10', 999)).toMatchObject({ fee: '0.05', bps: 50 });
  });

  it('lists the default policy first and chains in ascending order', () => {
    const fees = service({ 'fees.policies': { '71234': { bps: 30 }, '10': { maxFee: '2' } } });

    expect(fees.listPolicies()).toEqual([
      { chainId: 'default', bps: 50, minFee: '0.0', maxFee: null },
      { chainId: 10, bps: 50, minFee: '0.0', maxFee: '2.0' },
      { chainId: 71234, bps: 30, minFee: '0.0', maxFee: null },
    ]);
  });

  it('refuses to start with an unsafe or inconsistent policy', () => {
    expect(() => service({ 'fees.defaultBps': MAX_FEE_BPS + 1 })).toThrow(/bps/);
    expect(() => service({ 'fees.defaultBps': 12.5 })).toThrow(/bps/);
    expect(() => service({ 'fees.policies': { '5': { minFee: '2', maxFee: '1' } } })).toThrow(/maxFee/);
    expect(() => service({ 'fees.policies': { mainnet: { bps: 1 } } })).toThrow(/chain id/);
    expect(() => service({ 'fees.policies': { '5': { minFee: '1e-3' } } })).toThrow(/minFee/);
  });

  it('rejects amounts that are not plain decimals', () => {
    const fees = service();
    for (const bad of ['', '-1', '1e18', '0x10', '1.0000000000000000001', 'abc']) {
      expect(() => fees.quote(bad)).toThrow(BadRequestException);
    }
  });
});
