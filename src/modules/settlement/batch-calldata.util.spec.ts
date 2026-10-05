import {
  calldataGas,
  COMPACT_VERSION,
  packReceiptsCompact,
  unpackReceiptsCompact,
} from './batch-calldata.util';
import { PackableReceipt, packReceipts } from './receipt-packing.util';

const PAYER = '0x' + 'a1'.repeat(20);
const PAYEE = '0x' + 'b2'.repeat(20);

function receipts(count: number, amount = (i: number) => BigInt(i + 1) * 10n ** 15n): PackableReceipt[] {
  return Array.from({ length: count }, (_, i) => ({
    receiptHash: '0x' + (i + 1).toString(16).padStart(64, 'f'),
    payer: PAYER,
    payee: PAYEE,
    amountMinor: amount(i),
  }));
}

describe('compact batch calldata', () => {
  it('round-trips receipts without loss', () => {
    const input = receipts(25);
    const packed = packReceiptsCompact(input);

    expect(packed.count).toBe(25);
    expect(packed.blob.slice(2, 4)).toBe(COMPACT_VERSION.toString(16).padStart(2, '0'));
    expect(unpackReceiptsCompact(packed.blob)).toEqual(input);
  });

  it('keeps the merkle root of the v1 packing', () => {
    const input = receipts(7, () => 1_000n);
    expect(packReceiptsCompact(input).root).toBe(packReceipts(input).root);
  });

  it('stores each address once however many receipts use it', () => {
    const few = packReceiptsCompact(receipts(1));
    const many = packReceiptsCompact(receipts(11));
    // header: version + address count + 2 addresses + receipt count
    expect(few.bytes).toBe(1 + 1 + 40 + 2 + (32 + 4 + 1));
    expect((many.bytes - few.bytes) / 10).toBeLessThan(40);
  });

  it('encodes round amounts as mantissa and exponent', () => {
    const [decoded] = unpackReceiptsCompact(
      packReceiptsCompact(receipts(1, () => 1_500_000_000_000_000_000n)).blob,
    );
    expect(decoded.amountMinor).toBe(1_500_000_000_000_000_000n);
    // 15 * 10^17 -> one mantissa byte instead of eight
    expect(packReceiptsCompact(receipts(1, () => 1_500_000_000_000_000_000n)).bytes).toBe(44 + 37);
  });

  it('carries amounts beyond uint64 and zero amounts', () => {
    const big = (1n << 200n) + 7n;
    const input = receipts(2, (i) => (i === 0 ? big : 0n));
    expect(unpackReceiptsCompact(packReceiptsCompact(input).blob)).toEqual(input);
  });

  it('cuts calldata gas by more than half against v1 on a realistic batch', () => {
    const input = receipts(100);
    const v1 = calldataGas(packReceipts(input).blob);
    const v2 = calldataGas(packReceiptsCompact(input).blob);

    expect(v2).toBeLessThan(v1 * 0.5);
    expect(v2 / 100).toBeLessThan(v1 / 100);
  });

  it('prices zero and non-zero bytes per EIP-2028', () => {
    expect(calldataGas('0x')).toBe(0);
    expect(calldataGas('0x00ff0001')).toBe(4 + 16 + 4 + 16);
  });

  it('rejects malformed input instead of producing a wrong batch', () => {
    expect(() => packReceiptsCompact([{ ...receipts(1)[0], payer: '0x123' }])).toThrow(/payer/);
    expect(() => packReceiptsCompact([{ ...receipts(1)[0], amountMinor: -1n }])).toThrow(/uint256/);
    const blob = packReceiptsCompact(receipts(2)).blob;
    expect(() => unpackReceiptsCompact(blob.slice(0, -2))).toThrow(/truncated/);
    expect(() => unpackReceiptsCompact(blob + '00')).toThrow(/trailing/);
    expect(() => unpackReceiptsCompact('0x01' + blob.slice(4))).toThrow(/version/);
  });
});
