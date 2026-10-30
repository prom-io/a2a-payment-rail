import { ethers } from 'ethers';
import { Amount } from './amount';

const WEI = 10n ** 18n;

describe('Amount', () => {
  describe('parsing', () => {
    it.each([
      ['0', 0n],
      ['1', WEI],
      ['1.5', (15n * WEI) / 10n],
      ['1.500000000000000000', (15n * WEI) / 10n],
      ['0.000000000000000001', 1n],
      ['123456789012345678.123456789012345678', 123456789012345678123456789012345678n],
      ['-2.25', (-225n * WEI) / 100n],
      [' 7 ', 7n * WEI],
      ['1.5000000000000000000000', (15n * WEI) / 10n],
    ])('reads %p', (text, wei) => {
      expect(Amount.from(text).wei).toBe(wei);
    });

    it('reads DTO numbers, including the ones JS prints with an exponent', () => {
      expect(Amount.from(1).wei).toBe(WEI);
      expect(Amount.from(0.25).wei).toBe(WEI / 4n);
      expect(Amount.from(1e-7).wei).toBe(10n ** 11n);
      expect(Amount.from(1e21).wei).toBe(10n ** 39n);
      expect(Amount.from(2.5e-10).wei).toBe(25n * 10n ** 7n);
    });

    it.each(['', 'abc', '1,5', '0x10', '1.', '.5', '1..2', '--1', '1e', 'NaN', '1 000'])(
      'rejects %p',
      (text) => {
        expect(() => Amount.from(text)).toThrow(TypeError);
        expect(Amount.isValid(text)).toBe(false);
      },
    );

    it('rejects more than 18 significant decimals instead of rounding', () => {
      expect(() => Amount.from('0.0000000000000000001')).toThrow(/more than 18 decimals/);
      expect(() => Amount.from(1e-19)).toThrow(/more than 18 decimals/);
      expect(() => Amount.from(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => Amount.from(Number.NaN)).toThrow(TypeError);
    });

    it('agrees with ethers.parseUnits on valid input', () => {
      for (const text of ['0', '1', '0.1', '0.3', '19.99', '1000000.000000000000000001']) {
        expect(Amount.from(text).wei).toBe(ethers.parseUnits(text, 18));
      }
    });

    it('passes an Amount through and validates other types', () => {
      const amount = Amount.from('3');
      expect(Amount.from(amount)).toBe(amount);
      expect(Amount.isValid(amount)).toBe(true);
      expect(Amount.isValid('2.5')).toBe(true);
      expect(Amount.isValid(null)).toBe(false);
      expect(Amount.isValid({})).toBe(false);
    });
  });

  describe('arithmetic', () => {
    it('adds without floating point drift', () => {
      expect(Amount.from('0.1').plus('0.2').eq('0.3')).toBe(true);
      expect(0.1 + 0.2 === 0.3).toBe(false);
      expect(Amount.sum(['0.1', 0.2, Amount.from('0.000000000000000001')]).toString()).toBe(
        '0.300000000000000001',
      );
      expect(Amount.sum([])).toBe(Amount.ZERO);
    });

    it('keeps precision far beyond what a number can hold', () => {
      const big = Amount.from('9007199254740993.000000000000000001');
      expect(big.plus('0.000000000000000001').toString()).toBe('9007199254740993.000000000000000002');
    });

    it('subtracts, with and without a floor at zero', () => {
      expect(Amount.from('1').minus('2.5').toString()).toBe('-1.5');
      expect(Amount.from('1').minusFloored('2.5')).toBe(Amount.ZERO);
      expect(Amount.from('2.5').minusFloored('1').toString()).toBe('1.5');
    });

    it('multiplies by a ratio rounding down, like the contract does', () => {
      // 199 wei at 50 bps: 199 * 50 / 10000 = 0.995 -> 0
      expect(Amount.fromWei(199n).mulDiv(50n, 10_000n).wei).toBe(0n);
      expect(Amount.fromWei(200n).mulDiv(50n, 10_000n).wei).toBe(1n);
      expect(Amount.from('2').mulDiv(50n, 10_000n).toString()).toBe('0.01');
      expect(() => Amount.from('1').mulDiv(1n, 0n)).toThrow(RangeError);
    });

    it('compares', () => {
      const [small, large] = [Amount.from('1.000000000000000001'), Amount.from('1.000000000000000002')];
      expect(small.lt(large)).toBe(true);
      expect(small.lte(small)).toBe(true);
      expect(large.gt(small)).toBe(true);
      expect(large.gte('1.000000000000000002')).toBe(true);
      expect(small.eq(large)).toBe(false);
      expect(Amount.min(small, large)).toBe(small);
      expect(Amount.max(small, large)).toBe(large);
      expect(Amount.from('0').isZero()).toBe(true);
      expect(Amount.from('-1').isNegative()).toBe(true);
      expect(Amount.from('1').negated().toString()).toBe('-1.0');
    });

    it('never mutates', () => {
      const one = Amount.from('1');
      one.plus('5');
      one.minus('5');
      expect(one.toString()).toBe('1.0');
    });
  });

  describe('formatting', () => {
    it.each([
      ['0', '0.0', '0', '0.000000000000000000'],
      ['2', '2.0', '2', '2.000000000000000000'],
      ['1.50', '1.5', '1.5', '1.500000000000000000'],
      ['0.000000000000000001', '0.000000000000000001', '0.000000000000000001', '0.000000000000000001'],
      ['-0.5', '-0.5', '-0.5', '-0.500000000000000000'],
    ])('formats %p', (input, text, plain, fixed) => {
      const amount = Amount.from(input);
      expect(amount.toString()).toBe(text);
      expect(amount.toPlain()).toBe(plain);
      expect(amount.toFixed()).toBe(fixed);
      expect(JSON.stringify({ amount })).toBe(`{"amount":"${text}"}`);
    });

    it('prints exactly what ethers.formatUnits prints', () => {
      for (const wei of [0n, 1n, WEI, WEI / 3n, 15n * WEI, -WEI / 2n, 10n ** 40n + 7n]) {
        expect(Amount.fromWei(wei).toString()).toBe(ethers.formatUnits(wei, 18));
      }
    });

    it('round-trips through every textual form', () => {
      for (const text of ['0', '1', '0.1', '123.456', '0.000000000000000001', '-42.000000000000000042']) {
        const amount = Amount.from(text);
        expect(Amount.from(amount.toString()).wei).toBe(amount.wei);
        expect(Amount.from(amount.toPlain()).wei).toBe(amount.wei);
        expect(Amount.from(amount.toFixed()).wei).toBe(amount.wei);
      }
    });
  });
});
