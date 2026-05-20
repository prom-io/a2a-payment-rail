import { ethers } from 'ethers';

/**
 * Packs an array of receipt records into a tight bytes blob for on-chain settlement.
 *
 * Wire format (per receipt, 80 bytes):
 *   [0..32)  bytes32  receiptHash      // keccak256 of canonical receipt JSON
 *   [32..52) address  payer            // sender (agent A)
 *   [52..72) address  payee            // recipient (agent B)
 *   [72..80) uint64   amountMinor      // amount in minor units (e.g. gwei)
 *
 * The Merkle root of the unpacked receiptHash list is supplied separately to
 * the contract so on-chain verification is O(log N) without re-hashing on chain.
 *
 * Packing yields ~80 bytes per receipt vs ~256 bytes for naive ABI encoding,
 * which translates to ~3x calldata-gas reduction on EIP-1559 chains where
 * calldata is the dominant cost.
 */

export interface PackableReceipt {
  receiptHash: string;
  payer: string;
  payee: string;
  amountMinor: bigint | string | number;
}

const RECEIPT_BYTES = 80;

export function packReceipts(receipts: PackableReceipt[]): {
  blob: string;
  root: string;
  count: number;
} {
  if (receipts.length === 0) {
    return { blob: '0x', root: ethers.ZeroHash, count: 0 };
  }

  const parts: string[] = [];
  const leaves: string[] = [];

  for (const r of receipts) {
    assertHash32(r.receiptHash, 'receiptHash');
    assertAddress(r.payer, 'payer');
    assertAddress(r.payee, 'payee');
    const amount = BigInt(r.amountMinor);
    if (amount < 0n || amount > 0xffffffffffffffffn) {
      throw new Error(`amountMinor ${amount} does not fit in uint64`);
    }

    parts.push(
      r.receiptHash.slice(2).toLowerCase().padStart(64, '0') +
        r.payer.slice(2).toLowerCase().padStart(40, '0') +
        r.payee.slice(2).toLowerCase().padStart(40, '0') +
        amount.toString(16).padStart(16, '0'),
    );
    leaves.push(r.receiptHash);
  }

  const blob = '0x' + parts.join('');
  if ((blob.length - 2) / 2 !== receipts.length * RECEIPT_BYTES) {
    throw new Error('Packing produced unexpected blob size');
  }

  return {
    blob,
    root: buildMerkleRoot(leaves),
    count: receipts.length,
  };
}

export function unpackReceipts(blob: string): PackableReceipt[] {
  if (!blob.startsWith('0x') || (blob.length - 2) % (RECEIPT_BYTES * 2) !== 0) {
    throw new Error('Invalid packed blob');
  }
  const out: PackableReceipt[] = [];
  for (let i = 2; i < blob.length; i += RECEIPT_BYTES * 2) {
    out.push({
      receiptHash: '0x' + blob.slice(i, i + 64),
      payer: '0x' + blob.slice(i + 64, i + 64 + 40),
      payee: '0x' + blob.slice(i + 64 + 40, i + 64 + 40 + 40),
      amountMinor: BigInt('0x' + blob.slice(i + 64 + 40 + 40, i + RECEIPT_BYTES * 2)),
    });
  }
  return out;
}

function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ethers.ZeroHash;
  let layer = leaves.map((l) => l.toLowerCase());
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : a;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      next.push(ethers.keccak256(ethers.concat([lo, hi])));
    }
    layer = next;
  }
  return layer[0];
}

function assertHash32(value: string, field: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed 32-byte hex string`);
  }
}

function assertAddress(value: string, field: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed Ethereum address`);
  }
}
