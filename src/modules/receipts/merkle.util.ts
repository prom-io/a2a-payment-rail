import { ethers } from 'ethers';

/**
 * Merkle tree over receipt hashes.
 *
 * Construction (unchanged from the root the batcher has always produced):
 *   - leaves are the receipt hashes in batch order, used as they are;
 *   - a parent is keccak256(min(a, b) ++ max(a, b)): the pair is sorted, so a
 *     proof is a plain list of siblings with no left/right flags;
 *   - a level with an odd number of nodes pairs its last node with itself.
 *
 * A proof for one receipt is log2(N) hashes, so a payee can check that its
 * receipt is inside a settled batch without seeing the other receipts.
 */

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function hashPair(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([lo, hi]));
}

function normalise(leaves: string[]): string[] {
  return leaves.map((leaf) => {
    if (!HASH_PATTERN.test(leaf)) throw new Error('Merkle leaf must be a 0x-prefixed 32-byte hex string');
    return leaf.toLowerCase();
  });
}

function parentLevel(level: string[]): string[] {
  const parents: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    parents.push(hashPair(level[i], i + 1 < level.length ? level[i + 1] : level[i]));
  }
  return parents;
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ethers.ZeroHash;
  let level = normalise(leaves);
  while (level.length > 1) level = parentLevel(level);
  return level[0];
}

/** Siblings from the leaf level up to, but not including, the root. */
export function merkleProof(leaves: string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`Leaf index ${index} is outside the batch of ${leaves.length}`);
  }
  const proof: string[] = [];
  let level = normalise(leaves);
  let position = index;
  while (level.length > 1) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    proof.push(sibling < level.length ? level[sibling] : level[position]);
    level = parentLevel(level);
    position = Math.floor(position / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  if (!HASH_PATTERN.test(leaf) || !HASH_PATTERN.test(root)) return false;
  if (proof.some((sibling) => !HASH_PATTERN.test(sibling))) return false;
  const computed = proof.reduce(
    (node, sibling) => hashPair(node, sibling.toLowerCase()),
    leaf.toLowerCase(),
  );
  return computed === root.toLowerCase();
}
