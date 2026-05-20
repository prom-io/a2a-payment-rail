# Settlement Protocol

This document describes the settlement protocol used by `a2a-payment-rail` to
finalise A2A payments on-chain in a gas-efficient and verifiable way.

## 1. Overview

A2A interactions accumulate **receipts** off-chain. Each receipt is a signed
record of a single billable unit (e.g. an API call, a streamed token window).
At settlement time, batches of receipts for a given escrow are aggregated and
submitted to `EscrowHub.settleBatch(...)` on-chain.

```
agent A ─┐                                  ┌─> EscrowHub.settleBatch
         ├── receipts (signed) ─> batcher ──┤
agent B ─┘                                  └─> payment rail DB (audit)
```

## 2. Receipt format

Canonical JSON used for hashing:

```json
{
  "version": 1,
  "escrowId": "<uuid>",
  "sequence": 42,
  "payer": "0x...",
  "payee": "0x...",
  "amountMinor": "1000",
  "timestamp": "2026-05-20T12:00:00Z",
  "metaHash": "0x..."
}
```

The receipt hash is `keccak256(canonicalJson)`. Both parties sign the receipt
hash with secp256k1; both signatures must be present in the batch.

## 3. Calldata layout (packed)

To minimise calldata gas, receipts are packed by the batcher using
`receipt-packing.util.ts`. Each receipt is 80 bytes:

| offset | size | field        | notes                              |
|--------|------|--------------|------------------------------------|
| 0      | 32   | receiptHash  | keccak256 of canonical JSON        |
| 32     | 20   | payer        | EIP-55 address (lowercased on-wire)|
| 52     | 20   | payee        | EIP-55 address                     |
| 72     | 8    | amountMinor  | uint64 (minor units, e.g. gwei)    |

A Merkle root over the receipt hashes is supplied separately so the contract
can verify membership in O(log N) without rehashing the entire payload.

## 4. Access list (EIP-2930)

The batcher precomputes the storage slots touched by `settleBatch`:

- `escrows[escrowId]`           — 6 slots (struct fields)
- `settledBatches[receiptsHash]` — 1 slot
- `totalSettled[escrowId]`       — 1 slot

This saves ~2400 gas per cold SLOAD versus a legacy type-2 transaction.
The access list is built by `access-list.util.ts` and must be regenerated when
`EscrowHub` storage layout changes (see slot constants).

## 5. On-chain verification

`settleBatch(bytes32 escrowId, bytes32 receiptsRoot, uint256 totalAmount)`:

1. Require `escrows[escrowId].status == OPEN`.
2. Require `settledBatches[receiptsRoot] == false`.
3. Require `totalSettled[escrowId] + totalAmount <= escrows[escrowId].budget`.
4. Transfer `totalAmount` from escrow balance to `payee`.
5. `settledBatches[receiptsRoot] = true`.
6. `totalSettled[escrowId] += totalAmount`.
7. Emit `BatchSettled(escrowId, receiptsRoot, totalAmount)`.

Re-submission of the same `receiptsRoot` is rejected on step 2 — this is the
duplicate-protection invariant.

## 6. Refund flow (early termination)

If a party terminates the session before the budget is exhausted, the
streaming module exposes `POST /streaming/refund` which:

1. Loads the escrow and asserts it is still `OPEN`.
2. Sums all claims for the escrow.
3. Computes `refundAmount = deposit - sum(claims)`.
4. Closes the escrow.
5. Returns the refund record. The actual on-chain refund is then triggered by
   the batcher as a regular `closeEscrow` call.

## 7. Gas budget

Targets enforced by the `forge snapshot --diff` CI gate (`.gas-snapshot`):

| operation                        | target gas |
|----------------------------------|-----------:|
| openEscrow (happy path)          |    115 000 |
| closeEscrow (by payer)           |     75 000 |
| settleBatch (1 receipt)          |    145 000 |
| settleBatch (10 receipts, packed)|    310 000 |
| streaming.claim                  |     90 000 |
| refund on close                  |    125 000 |

Tolerance is `±1` unit in the snapshot file; any larger change must be
committed as an intentional update to `.gas-snapshot`.

## 8. Versioning

This document tracks protocol version `1`. Breaking changes to the receipt
canonical JSON, the packed calldata layout, or the storage slots used by the
access list bump the major version and require a contract migration.
