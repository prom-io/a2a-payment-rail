import { ethers } from 'ethers';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { buildMerkleRoot } from '../settlement/receipt-packing.util';
import { PaymentReceipt } from './entities/payment-receipt.entity';
import { merkleProof, merkleRoot, verifyMerkleProof } from './merkle.util';
import { ReceiptsService } from './receipts.service';

const leaf = (i: number) => ethers.keccak256(ethers.toUtf8Bytes(`receipt-${i}`));
const leaves = (count: number) => Array.from({ length: count }, (_, i) => leaf(i));

describe('merkle tree over receipt hashes', () => {
  it('has well-defined roots for the degenerate sizes', () => {
    expect(merkleRoot([])).toBe(ethers.ZeroHash);
    expect(merkleRoot([leaf(0)])).toBe(leaf(0));
    expect(merkleProof([leaf(0)], 0)).toEqual([]);
  });

  it('hashes a pair in sorted order', () => {
    const [a, b] = [leaf(1), leaf(2)].sort();
    const expected = ethers.keccak256(ethers.concat([a, b]));
    expect(merkleRoot([a, b])).toBe(expected);
    expect(merkleRoot([b, a])).toBe(expected);
  });

  it('produces the root the batcher has always produced', () => {
    for (const size of [1, 2, 3, 7, 16, 33]) {
      expect(buildMerkleRoot(leaves(size))).toBe(merkleRoot(leaves(size)));
    }
  });

  it.each([1, 2, 3, 4, 5, 8, 13, 100])('proves every leaf of a batch of %i', (size) => {
    const batch = leaves(size);
    const root = merkleRoot(batch);
    batch.forEach((hash, index) => {
      const proof = merkleProof(batch, index);
      expect(proof.length).toBe(Math.ceil(Math.log2(size)));
      expect(verifyMerkleProof(hash, proof, root)).toBe(true);
    });
  });

  it('accepts hashes in any letter case', () => {
    const batch = leaves(5);
    const proof = merkleProof(batch, 3).map((p) => p.toUpperCase().replace('0X', '0x'));
    expect(verifyMerkleProof(batch[3].toUpperCase().replace('0X', '0x'), proof, merkleRoot(batch))).toBe(true);
  });

  it('rejects a foreign leaf, a tampered proof and a wrong root', () => {
    const batch = leaves(9);
    const root = merkleRoot(batch);
    const proof = merkleProof(batch, 4);

    expect(verifyMerkleProof(leaf(999), proof, root)).toBe(false);
    expect(verifyMerkleProof(batch[4], [...proof.slice(1), proof[0]], root)).toBe(false);
    expect(verifyMerkleProof(batch[4], proof.slice(0, -1), root)).toBe(false);
    expect(verifyMerkleProof(batch[4], proof, merkleRoot(leaves(10)))).toBe(false);
    expect(verifyMerkleProof(batch[4], ['0x1234'], root)).toBe(false);
  });

  it('refuses indexes outside the batch and malformed leaves', () => {
    expect(() => merkleProof(leaves(3), 3)).toThrow(/outside the batch/);
    expect(() => merkleProof(leaves(3), -1)).toThrow(/outside the batch/);
    expect(() => merkleRoot(['0xabc'])).toThrow(/32-byte/);
  });
});

describe('ReceiptsService.inclusionProof', () => {
  function service(rows: Partial<PaymentReceipt>[]) {
    const repo = {
      findOne: jest.fn(async ({ where }) => rows.find((r) => r.receiptHash === where.receiptHash) ?? null),
      find: jest.fn(async ({ where }) =>
        rows
          .filter((r) => r.settlementId === where.settlementId)
          .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0)),
      ),
    };
    return new ReceiptsService(repo as unknown as Repository<PaymentReceipt>);
  }

  const batch = leaves(6).map((receiptHash, i) => ({
    id: `r${i}`,
    receiptHash,
    settlementId: 'settlement-1',
    batchIndex: i,
  }));

  it('returns a proof that verifies against the batch root', async () => {
    const result = await service(batch).inclusionProof(leaf(4));

    expect(result).toMatchObject({
      receiptHash: leaf(4),
      settlementId: 'settlement-1',
      index: 4,
      leafCount: 6,
      root: merkleRoot(leaves(6)),
    });
    expect(verifyMerkleProof(result.receiptHash, result.proof, result.root)).toBe(true);
  });

  it('answers 404 for an unknown receipt and 409 for one that is not batched yet', async () => {
    const pending = { id: 'p', receiptHash: leaf(50), settlementId: null, batchIndex: null };
    const receipts = service([...batch, pending]);

    await expect(receipts.inclusionProof(leaf(404))).rejects.toBeInstanceOf(NotFoundException);
    await expect(receipts.inclusionProof(leaf(50))).rejects.toBeInstanceOf(ConflictException);
  });
});
