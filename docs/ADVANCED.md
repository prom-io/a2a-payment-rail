# Advanced topics

How the three larger subsystems of the Payment Rail are built and, just as
important, where each one currently stops: multi-chain support, streaming v2
and batch settlement. Wire formats and endpoint contracts live in
[SETTLEMENT-PROTOCOL.md](SETTLEMENT-PROTOCOL.md); this document is the map.

## 1. Multi-chain

### What exists

| piece | file | role |
|---|---|---|
| Chain registry | `src/blockchain/chain-registry.ts` | `getChain(chainId)` / `registerChain(cfg)`: name, RPC URL, confirmations, gas caps per chain |
| Provider interface | `src/blockchain/chain-provider.interface.ts` | `ChainProvider`: `getBlockNumber`, `waitForConfirmations`, `sendRaw` |
| EVM provider | `src/blockchain/evm-chain-provider.ts` | `ChainProvider` over an ethers `JsonRpcProvider` built from the registry entry |
| Session keys | `src/blockchain/session-key.ts` | `buildSessionKey(chainId, agentId, nonce)` -> `<name>:<chainId>:<agentId>:<nonce>` |
| Fee policy | `src/modules/fees/fee-policy.service.ts` | basis points, minimum and cap per chain id (`FEE_POLICIES`) |
| Fee ledger | `src/modules/fees/fee-ledger.service.ts` | accruals, withdrawals and balance keyed by chain id |

The registry ships one entry, `prom-testnet` (chain id `71234`, RPC from
`PROM_TESTNET_RPC_URL`, 1 confirmation, 5 gwei max fee, 1 gwei priority fee).
Other chains are added with `registerChain` at startup.

Session keys carry the chain name and id so the same agent and nonce on two
chains never produce the same key. `parseSessionKey` reads the id back; it
splits on `:`, so an agent id must not contain a colon.

`getChain` throws for an unknown id. That is deliberate: an unknown chain must
fail loudly rather than fall back to some default RPC.

### Where it stops

The Nest services still talk to **one** chain per process:

- `BlockchainService` (`src/common/blockchain/`) builds a single provider and a
  single signer from `BLOCKCHAIN_RPC_URL` / `BLOCKCHAIN_PRIVATE_KEY`, and
  escrow, settlement, release, refund and reconciliation all use it together
  with the one `ESCROW_HUB_ADDRESS`.
- `CHAIN_ID` (default `31337`) says which chain that is. It labels the escrow
  and stream gauges, selects the fee policy and is the key the fee ledger
  accrues under.
- `escrow_sessions` and `settlements` have no chain column. The registry,
  `EvmChainProvider` and the session keys are not injected into those modules
  yet.

So today "multi-chain" means: run one instance per chain, each with its own
`CHAIN_ID`, RPC, hub address and database (or at least its own tables), and
give each chain its own fee policy. The provider abstraction is what a single
multi-chain process will be built on; routing a request to a chain inside one
process is not implemented.

### Adding a chain to a deployment

1. Deploy `EscrowHub` on the chain (`contracts/script/Deploy.s.sol`).
2. Start an instance with `CHAIN_ID`, `BLOCKCHAIN_RPC_URL`,
   `BLOCKCHAIN_PRIVATE_KEY` and `ESCROW_HUB_ADDRESS` of that chain.
3. If its fee differs from the default, add it to `FEE_POLICIES`
   (`{"<chainId>": {"bps": 30, "maxFee": "5"}}`). Keep `bps` equal to the
   `feePercent` of the hub deployed there.
4. Register the chain (`registerChain`) if code that uses `getChain` or session
   keys runs against it.

## 2. Streaming v2

### Model

`src/streaming/streaming-v2.service.ts` prices a stream by time instead of by
reported usage:

```ts
interface Stream {
  id: string;
  ratePerSecond: bigint;   // wei per second
  startedAt: number;       // ms since epoch
  lastClaimAt: number;     // ms since epoch, the checkpoint
  claimed: bigint;         // wei claimed so far
}
```

- `accrued(stream, now)` = `floor((now - lastClaimAt) / 1000) * ratePerSecond`.
  Whole seconds only; a clock that runs backwards accrues zero, never a
  negative amount.
- `claim(stream, now)` returns the accrued amount and a new stream whose
  checkpoint is `now`. Because the amount is derived from the checkpoint,
  claiming twice at the same instant pays once: the second claim accrues zero.

`src/streaming/stream-mutations.ts` changes a running stream:

- `changeRate(stream, newRate, now)` first settles what accrued at the old rate
  into `claimed`, then moves the checkpoint and applies the new rate. Seconds
  already streamed are never repriced.
- `topUp(stream, amount)` returns the stream unchanged. The balance of a stream
  lives in its escrow; a top-up extends the runway there and has nothing to
  update in the stream itself.

Everything is `bigint`, and both functions return new objects instead of
mutating their input.

### Where it stops

Streaming v2 is a domain model. It is not persisted, not a Nest provider and
not reachable over HTTP. The HTTP streaming API is still v1
(`src/modules/streaming/`): `POST /streaming/claim` records a `usageDelta`
reported by the caller and keeps a running `cumulativeAmount`, and
`POST /streaming/refund` closes the escrow and returns `deposit - claims`. One
thing to know about `changeRate`: it adds the settled amount to `claimed`
without returning it, so a caller that wants to pay out at the moment of a
rate change must claim first.

### Tests

`test/streaming-v2.property.spec.ts` checks the accrual against a reference
model and that a rate change never reprices past seconds. It sits outside both
Jest configurations (unit tests run from `src/`, the e2e config only matches
`*.e2e-spec.ts`), so it is not part of `npm test` or CI. Run it directly:

```bash
npx jest --rootDir . --testRegex "test/streaming-v2\.property\.spec\.ts$"
```

## 3. Batching

Receipts are settled in batches, not one transaction each. The pipeline:

```
POST /receipts ──▶ payment_receipts (settlementId NULL)
                         │  SettlementBatchScheduler: window or cap reached
                         ▼
               settlements row  ── packed calldata (v2), Merkle root, fee
                         │  SettlementService.attempt
                         ▼
        EscrowHub.settleBatch ──▶ settled ──▶ fee ledger accrual, webhook
                         │
                         └─ failure ─▶ retrying ─▶ ... ─▶ dead_letter / rejected
                                                              │
                                              POST /settlements/:id/replay
```

| stage | code | protocol section |
|---|---|---|
| Collect and group | `settlement-batch.scheduler.ts` | 6a |
| Encode | `batch-calldata.util.ts` (v2), `receipt-packing.util.ts` (v1) | 3, 3.1 |
| Root and proofs | `receipts/merkle.util.ts`, `GET /receipts/proof/:hash` | 3.2 |
| Submit, retry, dead letter | `settlement.service.ts`, `settlement-retry.service.ts` | 6b |
| Fees | `fees/fee-policy.service.ts`, `fees/fee-ledger.service.ts` | 6c, 6d |
| Export | `settlement-export.service.ts`, `GET /settlements/export` | 6e |

### Choosing the window and the cap

`SETTLEMENT_BATCH_WINDOW_MS` is the longest a payee waits for money that is
already earned; `SETTLEMENT_BATCH_MAX_RECEIPTS` bounds one batch. A longer
window and a larger cap mean fewer transactions for the same receipts. A batch
is one `settleBatch` call whatever its size, so the transaction cost per
receipt falls roughly as `1 / batch size`; what grows with the batch is the
packed blob (about 37 bytes per receipt, section 3.1) and the damage of one
failed transaction. The defaults (60 s, 100 receipts) favour latency.

The scheduler looks at no more than `SETTLEMENT_BATCH_SCAN_LIMIT` (1000)
unsettled receipts per tick, oldest first. If the backlog is permanently above
that, raise it or shorten the tick (`SETTLEMENT_BATCH_TICK_MS`): otherwise the
newest escrows wait behind the oldest ones.

### Guarantees and their limits

- **A receipt is batched once.** It is attached to its settlement
  (`settlementId`, `batchIndex`) and the scan only reads unattached receipts.
  The in-flight guard that stops overlapping ticks is per process: run the
  scheduler (`SETTLEMENT_BATCH_ENABLED=true`) on **one** instance. Two
  instances scanning at the same moment can both batch the same receipts.
- **A settlement is paid once.** The contract does not deduplicate batches, so
  the retry path looks up the stored transaction hash before sending again
  (section 6b). This covers a lost connection; it does not cover an operator
  replaying a settlement that was in fact mined under a hash the rail never
  stored.
- **A failed batch keeps its receipts.** It is retried as the same settlement,
  and ends as `settled`, `rejected` or `dead_letter`. Nothing is re-batched
  behind the operator's back.
- **The packed blob is stored, not sent.** `EscrowHub.settleBatch` takes a
  root and a total. The compact encoding is the payload for a hub version that
  accepts receipt data and, until then, what an auditor rebuilds the root from
  (`settlements.packedReceipts`).

### Related jobs

All periodic work follows the same pattern: a `setInterval` that is `unref`ed
and cleared on shutdown, an in-process "already running" guard, and a public
method that takes `now` so tests and operators can run one pass by hand.

| job | switch | default |
|---|---|---|
| Batch scheduler | `SETTLEMENT_BATCH_ENABLED` | off |
| Settlement retry queue | `SETTLEMENT_RETRY_ENABLED` | on |
| Webhook retries | `WEBHOOK_RETRY_ENABLED` | on |
| Escrow expiry and refund sweep | `ESCROW_EXPIRY_SWEEP_ENABLED` | off |
| Reconciliation | `RECONCILIATION_INTERVAL_MS` | off (`0`) |

The jobs that start transactions on their own (batching, expiry refunds) are
opt-in; the ones that only finish work somebody else started are on.

## 4. See also

- [SETTLEMENT-PROTOCOL.md](SETTLEMENT-PROTOCOL.md): formats, endpoints, state machines.
- [WEBHOOKS.md](WEBHOOKS.md): events, signatures, redelivery.
- [DATABASE.md](DATABASE.md): schema handling and the indexes behind the hot queries.
- [OBSERVABILITY.md](OBSERVABILITY.md): metrics, reconciliation, alerts.
- [SECURITY.md](SECURITY.md): threat model, spending limits.
