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

### 3.1 Compact layout (v2)

The 80-byte layout repeats the payer and the payee on every receipt and spends
eight bytes on amounts that are almost always round numbers. The batch
scheduler therefore encodes batches with `batch-calldata.util.ts`:

| part        | size          | notes                                              |
|-------------|---------------|----------------------------------------------------|
| version     | 1             | `0x02`                                             |
| addresses   | 1 + 20 * A    | dictionary, order of first appearance              |
| count       | 2             | uint16 number of receipts                          |
| receiptHash | 32            | per receipt                                        |
| payer/payee | 1 + 1         | per receipt, indexes into the dictionary           |
| amount      | 1 + 1 + L     | per receipt: decimal exponent, length, mantissa    |

`amount = mantissa * 10^exponent`, so `1.5` ether (`1500000000000000000` wei)
is the mantissa `15` and the exponent `17`: one byte instead of eight, and the
amount is no longer limited to uint64. A typical receipt takes 37 bytes instead
of 80; for a 100-receipt batch the EIP-2028 calldata gas (`calldataGas()`) drops
by more than half. The Merkle root is the same as in v1.

The blob is stored with the settlement (`settlements.packedReceipts`).
`EscrowHub.settleBatch` as deployed takes only the root and the total, so the
blob is not sent on-chain yet: it is the payload format for a hub version that
accepts receipt data, and until then it is what an auditor re-derives the root
from.

### 3.2 Merkle batching and inclusion proofs

The batch root (`settlement.receiptsHash`) is a Merkle root over the receipt
hashes in batch order (`src/modules/receipts/merkle.util.ts`): a parent is
`keccak256(min(a, b) ++ max(a, b))` and an odd level pairs its last node with
itself. Because pairs are sorted, a proof is a plain list of sibling hashes.

The position of a receipt in its batch is stored (`payment_receipts.batchIndex`),
so the tree can be rebuilt at any time:

- `GET /receipts/proof/:receiptHash` returns
  `{ receiptHash, settlementId, index, leafCount, root, proof }`; `404` for an
  unknown receipt, `409` while the receipt is not batched yet. `root` equals
  `receiptsHash` of the settlement.
- `POST /receipts/proof/verify` with `{ receiptHash, proof, root }` answers
  `{ valid }`; the check is pure and needs no database.

A payee verifies its receipt with `log2(N)` hashes and never sees the other
receipts of the batch. Note that the value passed to `EscrowHub.settleBatch` is
`keccak256(utf8(receiptsHash))`, so to tie a proof to the chain hash the root
string once more before comparing it with the `BatchSettled` event.

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

### 6.1 Refunds of expired and cancelled sessions

Sessions that end without the payer closing them are refunded by
`RefundsService` (`src/modules/refunds/`):

- **cancelled**: `POST /escrow/:id/cancel` moves an `open` session to
  `cancelled` (`409` for any other status);
- **expired**: the expiry sweep moves `open` sessions with
  `createdAt + ttl <= now` to `expired`.

`POST /refunds/:escrowId` then returns the unspent deposit:

```
refund = deposit - sum(settled settlements) - sum(stream claims)   (floor 0)
```

One row per escrow is kept in `escrow_refunds` (`escrowId` is unique). A
repeated request returns that row; if its transaction failed (`failed`,
`lastError`), the request retries it. A session in any other status is `409`.
With `ESCROW_HUB_ADDRESS` set the refund calls `EscrowHub.emergencyClose`, the
owner-only function that pays `deposit - spent` back to the payer
(`closeEscrow` is payer-only and cannot be called by the rail); without a hub
the refund is recorded off-chain only. A completed refund stamps
`escrow_sessions.refundedAt` and emits `escrow.refunded`.

The sweep is opt-in (`ESCROW_EXPIRY_SWEEP_ENABLED=true`): every
`ESCROW_EXPIRY_SWEEP_MS` (60 s) it expires due sessions and refunds up to
`ESCROW_EXPIRY_SWEEP_BATCH` (50) expired or cancelled sessions that have no
`refundedAt` yet. With the sweep off, sessions are not marked expired on their
own and refunds happen only through the endpoint.

## 6a. Batch scheduler

`SettlementBatchScheduler` (`src/modules/settlement/settlement-batch.scheduler.ts`)
turns accumulated receipts into settlements without a caller asking for it. It
is opt-in (`SETTLEMENT_BATCH_ENABLED=true`).

Every `SETTLEMENT_BATCH_TICK_MS` it loads the oldest unsettled receipts
(`payment_receipts.settlementId IS NULL`), groups them by escrow and flushes an
escrow when either bound is hit:

| bound  | variable                        | default | effect                                            |
|--------|---------------------------------|--------:|---------------------------------------------------|
| window | `SETTLEMENT_BATCH_WINDOW_MS`    |   60000 | oldest receipt waited this long: flush everything |
| cap    | `SETTLEMENT_BATCH_MAX_RECEIPTS` |     100 | a full batch is flushed early, the rest waits     |

A batch never holds more than the cap; a backlog is split into several
settlements. The batch hash is the Merkle root of the receipt hashes in
creation order and the total is summed in wei with `bigint`. Receipts are
attached to the settlement through `settlementId` whatever the on-chain
outcome: a failed settlement is completed by the retry queue (6b), never by
batching the same receipts a second time. Ticks never overlap inside one
process.

## 6b. Retry queue and dead letter

Every on-chain submission goes through `SettlementService.attempt()`, which
records the outcome on the settlement row:

| outcome                               | status        | next step                              |
|---------------------------------------|---------------|----------------------------------------|
| mined                                 | `settled`     | none                                   |
| contract revert (`CALL_EXCEPTION`)    | `rejected`    | manual replay only                     |
| transient error (RPC, timeout, nonce) | `retrying`    | retried at `nextRetryAt`               |
| transient error, attempts used up     | `dead_letter` | manual replay only                     |

`SettlementRetryService` polls the queue (`status = retrying AND nextRetryAt <=
now`) every `SETTLEMENT_RETRY_TICK_MS` and retries one settlement at a time,
because all attempts share one signer nonce. The delay doubles per attempt from
`SETTLEMENT_RETRY_BASE_DELAY_MS` (30 s) up to `SETTLEMENT_RETRY_MAX_DELAY_MS`
(1 h); after `SETTLEMENT_RETRY_MAX_ATTEMPTS` (5) the row is dead-lettered.

The contract does not deduplicate batches, so a retry must not double-pay. The
transaction hash is stored (`settlements.txHash`) before waiting for the
receipt; a retry first looks that hash up: mined means settled, still pending
means wait without resending, unknown or reverted means send again.

Operator endpoints:

- `GET /settlements/dead-letter` lists `dead_letter` and `rejected` rows with
  `attempts` and `lastError`.
- `POST /settlements/:id/replay` (role `admin`) resets the attempts and submits
  again at once; `409` for any other status.

## 6c. Fee policy

`FeePolicyService` (`src/modules/fees/`) decides the protocol fee of a
settlement: `fee = floor(amount * bps / 10000)`, clamped into
`[minFee, maxFee]` and never above the amount. The default policy comes from
`FEE_DEFAULT_BPS` (50, the value of `EscrowHub.feePercent`), `FEE_DEFAULT_MIN`
and `FEE_DEFAULT_MAX`; `FEE_POLICIES` overrides it per chain id and inherits
whatever it leaves out:

```
FEE_POLICIES={"71234":{"bps":30,"minFee":"0.0001","maxFee":"5"}}
```

A rate above 1000 bps (10%), a non-integer rate, or `maxFee < minFee` stops the
service at startup. Each settlement stores its fee in `settlements.feeAmount`,
computed for the chain in `CHAIN_ID`. `GET /fees/quote?amount=1.5&chainId=71234`
returns fee, net and which bound applied; `GET /fees/policies` lists the
effective policies.

The contract still withholds its own `feePercent` on-chain. Keep the policy of
a chain equal to the deployed `feePercent` unless bounds are wanted: with
equal basis points and no bounds both sides round down to the same wei.

## 6d. Fee ledger

`FeeLedgerService` keeps an append-only ledger (`fee_ledger_entries`):

- an `accrual` row is written when a settlement becomes `settled`, for its
  `feeAmount` and the chain in `CHAIN_ID`. `settlementId` is unique, so a
  retried or replayed settlement cannot accrue twice. A failing ledger write is
  logged and does not undo the settlement;
- a `withdrawal` row is written by `POST /fees/withdrawals` (role `admin`,
  accepts `Idempotency-Key`) with `{ amount, recipient, chainId?, txHash?, note? }`.

`available = sum(accruals) - sum(withdrawals)` per chain. A withdrawal above
the available balance is `409`. Withdrawals of one chain are serialised with a
transaction-scoped Postgres advisory lock, so two concurrent requests cannot
both spend the same balance. `GET /fees/ledger?chainId=` returns the balance
and the 50 most recent entries.

The ledger is the rail's own book. `EscrowHub` leaves withheld fees in the
contract balance and has no payout function, so a withdrawal does not send a
transaction: it records the treasury payout (`txHash` when known) and enforces
that payouts never exceed what was accrued.

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
