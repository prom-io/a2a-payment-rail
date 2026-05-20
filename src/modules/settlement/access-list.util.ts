import { ethers } from 'ethers';

/**
 * EIP-2930 access list helpers for settlement-batch transactions.
 *
 * Settlement reads a small, known set of storage slots in EscrowHub:
 *   - escrows[escrowId]         (slot 0 base)
 *   - escrows[escrowId].balance
 *   - escrows[escrowId].budget
 *   - settledBatches[receiptsHash] (slot 1 base)
 *
 * Providing a pre-computed access list saves ~2400 gas per cold SLOAD on the
 * affected slots compared to letting the EVM warm them on demand.
 *
 * Slot layout (must stay in sync with EscrowHub.sol):
 *   slot 0: mapping(bytes32 => Escrow)        // escrows
 *   slot 1: mapping(bytes32 => bool)          // settledBatches
 *   slot 2: mapping(bytes32 => uint256)       // totalSettled
 */

const SLOT_ESCROWS = 0n;
const SLOT_SETTLED_BATCHES = 1n;
const SLOT_TOTAL_SETTLED = 2n;
const ESCROW_STRUCT_FIELDS = 6n;

export interface SettlementAccessListInput {
  escrowHubAddress: string;
  escrowIdHash: string;
  receiptsHash: string;
}

export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

export function buildSettlementAccessList(
  input: SettlementAccessListInput,
): AccessListEntry[] {
  const escrowsBase = mappingSlot(input.escrowIdHash, SLOT_ESCROWS);
  const escrowStructKeys: string[] = [];
  for (let i = 0n; i < ESCROW_STRUCT_FIELDS; i += 1n) {
    escrowStructKeys.push(addToSlot(escrowsBase, i));
  }

  const settledBatchesSlot = mappingSlot(input.receiptsHash, SLOT_SETTLED_BATCHES);
  const totalSettledSlot = mappingSlot(input.escrowIdHash, SLOT_TOTAL_SETTLED);

  return [
    {
      address: ethers.getAddress(input.escrowHubAddress),
      storageKeys: [...escrowStructKeys, settledBatchesSlot, totalSettledSlot],
    },
  ];
}

function mappingSlot(key: string, slot: bigint): string {
  return ethers.keccak256(
    ethers.concat([key, ethers.zeroPadValue(ethers.toBeHex(slot), 32)]),
  );
}

function addToSlot(base: string, offset: bigint): string {
  const baseBig = BigInt(base);
  return ethers.zeroPadValue(ethers.toBeHex(baseBig + offset), 32);
}
