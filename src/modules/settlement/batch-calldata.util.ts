import { buildMerkleRoot, PackableReceipt } from './receipt-packing.util';

/**
 * Compact (v2) calldata encoding for a settlement batch.
 *
 * The v1 layout in receipt-packing.util.ts spends 80 bytes on every receipt.
 * Most of that is redundant inside one batch:
 *   - payer and payee repeat on every receipt (a batch belongs to one escrow),
 *     so addresses move into a dictionary and receipts carry 1-byte indexes;
 *   - amounts are round decimal numbers, so `1500000000000000000` wei is sent
 *     as mantissa 15 and exponent 17 instead of eight raw bytes.
 *
 * Wire format:
 *   [0]        uint8    version (0x02)
 *   [1]        uint8    address count A (1..255)
 *   [2..)      address  A * 20 bytes, order of first appearance
 *   [..+2)     uint16   receipt count N
 *   N times:
 *     bytes32  receiptHash
 *     uint8    payer index
 *     uint8    payee index
 *     uint8    decimal exponent E (amount = mantissa * 10^E)
 *     uint8    mantissa length L (0..32)
 *     bytes    mantissa, big-endian, L bytes
 *
 * A typical receipt costs 37 bytes instead of 80, and the amount is no longer
 * limited to uint64. Decoding on-chain is one multiplication per receipt.
 */

export const COMPACT_VERSION = 0x02;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_ADDRESSES = 255;
const MAX_RECEIPTS = 0xffff;

// EIP-2028 calldata pricing.
const GAS_PER_ZERO_BYTE = 4;
const GAS_PER_NONZERO_BYTE = 16;

export interface CompactBatch {
  blob: string;
  root: string;
  count: number;
  bytes: number;
}

export function packReceiptsCompact(receipts: PackableReceipt[]): CompactBatch {
  if (receipts.length > MAX_RECEIPTS) {
    throw new Error(`A batch holds at most ${MAX_RECEIPTS} receipts`);
  }

  const addressIndex = new Map<string, number>();
  const indexOf = (address: string, field: string): number => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`${field} must be a 0x-prefixed Ethereum address`);
    }
    const key = address.slice(2).toLowerCase();
    let index = addressIndex.get(key);
    if (index === undefined) {
      index = addressIndex.size;
      if (index >= MAX_ADDRESSES) throw new Error('Too many distinct addresses in one batch');
      addressIndex.set(key, index);
    }
    return index;
  };

  const body: string[] = [];
  for (const receipt of receipts) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.receiptHash)) {
      throw new Error('receiptHash must be a 0x-prefixed 32-byte hex string');
    }
    const amount = BigInt(receipt.amountMinor);
    if (amount < 0n || amount > MAX_UINT256) {
      throw new Error(`amountMinor ${amount} does not fit in uint256`);
    }
    const payer = indexOf(receipt.payer, 'payer');
    const payee = indexOf(receipt.payee, 'payee');
    const { mantissa, exponent } = toScientific(amount);
    const mantissaHex = mantissa === 0n ? '' : evenHex(mantissa);

    body.push(
      receipt.receiptHash.slice(2).toLowerCase() +
        byte(payer) +
        byte(payee) +
        byte(exponent) +
        byte(mantissaHex.length / 2) +
        mantissaHex,
    );
  }

  const header =
    byte(COMPACT_VERSION) +
    byte(addressIndex.size) +
    [...addressIndex.keys()].join('') +
    receipts.length.toString(16).padStart(4, '0');
  const blob = '0x' + header + body.join('');

  return {
    blob,
    root: buildMerkleRoot(receipts.map((receipt) => receipt.receiptHash)),
    count: receipts.length,
    bytes: (blob.length - 2) / 2,
  };
}

export function unpackReceiptsCompact(blob: string): PackableReceipt[] {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(blob)) throw new Error('Invalid compact blob');
  const hex = blob.slice(2).toLowerCase();
  let cursor = 0;
  const take = (bytes: number): string => {
    const end = cursor + bytes * 2;
    if (end > hex.length) throw new Error('Compact blob is truncated');
    const chunk = hex.slice(cursor, end);
    cursor = end;
    return chunk;
  };

  const version = parseInt(take(1), 16);
  if (version !== COMPACT_VERSION) throw new Error(`Unsupported compact version ${version}`);

  const addressCount = parseInt(take(1), 16);
  const addresses: string[] = [];
  for (let i = 0; i < addressCount; i += 1) addresses.push('0x' + take(20));
  const lookup = (index: number): string => {
    if (index >= addresses.length) throw new Error(`Address index ${index} is out of range`);
    return addresses[index];
  };

  const count = parseInt(take(2), 16);
  const receipts: PackableReceipt[] = [];
  for (let i = 0; i < count; i += 1) {
    const receiptHash = '0x' + take(32);
    const payer = lookup(parseInt(take(1), 16));
    const payee = lookup(parseInt(take(1), 16));
    const exponent = parseInt(take(1), 16);
    const length = parseInt(take(1), 16);
    if (length > 32) throw new Error('Mantissa is longer than 32 bytes');
    const mantissa = length === 0 ? 0n : BigInt('0x' + take(length));
    const amountMinor = mantissa * 10n ** BigInt(exponent);
    if (amountMinor > MAX_UINT256) throw new Error('Decoded amount does not fit in uint256');
    receipts.push({ receiptHash, payer, payee, amountMinor });
  }
  if (cursor !== hex.length) throw new Error('Compact blob has trailing bytes');
  return receipts;
}

/** Intrinsic calldata gas of a hex payload (EIP-2028: 4 per zero byte, 16 otherwise). */
export function calldataGas(hexData: string): number {
  const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
  let gas = 0;
  for (let i = 0; i < hex.length; i += 2) {
    gas += hex.charCodeAt(i) === 48 && hex.charCodeAt(i + 1) === 48
      ? GAS_PER_ZERO_BYTE
      : GAS_PER_NONZERO_BYTE;
  }
  return gas;
}

/** Strips trailing decimal zeros: 1500 -> { mantissa: 15, exponent: 2 }. */
function toScientific(amount: bigint): { mantissa: bigint; exponent: number } {
  if (amount === 0n) return { mantissa: 0n, exponent: 0 };
  let mantissa = amount;
  let exponent = 0;
  while (mantissa % 10n === 0n) {
    mantissa /= 10n;
    exponent += 1;
  }
  return { mantissa, exponent };
}

function byte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function evenHex(value: bigint): string {
  const hex = value.toString(16);
  return hex.length % 2 === 0 ? hex : '0' + hex;
}
