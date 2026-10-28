# Database

PostgreSQL through TypeORM. The schema is derived from the entities
(`synchronize: true` in `src/config/database.config.ts`): adding a column or an
index to an entity is the whole change, there is no migration to write. Every
new column must therefore be nullable or carry a default, so it can be added to
a table that already has rows.

## Composite indexes

Declared with `@Index` on the entity, always with an explicit name. Column
order is deliberate: the equality column first, the range or sort column
second. `src/common/database/indexes.spec.ts` pins the list.

| index                              | table               | columns                     | serves                                                            |
|------------------------------------|---------------------|-----------------------------|-------------------------------------------------------------------|
| `IDX_receipt_escrow_created`       | `payment_receipts`  | `escrowId, createdAt`       | `GET /receipts/:escrowId`                                         |
| `IDX_receipt_settlement_batch`     | `payment_receipts`  | `settlementId, batchIndex`  | inclusion proofs (all receipts of a batch, leaf order)            |
| `IDX_receipt_unsettled` (partial)  | `payment_receipts`  | `createdAt, id`             | batch scheduler scan, `WHERE settlementId IS NULL`                |
| `IDX_receipt_hash`                 | `payment_receipts`  | `receiptHash`               | proof and validation lookups                                      |
| `IDX_escrow_status_created`        | `escrow_sessions`   | `status, createdAt`         | expiry sweep, reconciliation, status gauges                       |
| `IDX_escrow_awaiting_refund` (partial) | `escrow_sessions` | `status, closedAt`        | refund sweep, `WHERE refundedAt IS NULL`                          |
| `IDX_settlement_escrow_created`    | `settlements`       | `escrowId, createdAt`       | `GET /settlements?escrowId=`, refund and reconciliation sums      |
| `IDX_settlement_retry_queue`       | `settlements`       | `status, nextRetryAt`       | retry queue poll, dead-letter list                                |
| `IDX_settlement_created_id`        | `settlements`       | `createdAt, id`             | export keyset pagination                                          |
| `IDX_stream_claim_escrow_claimed`  | `stream_claims`     | `escrowId, claimedAt`       | latest claim of an escrow, per-escrow sums                        |
| `IDX_webhook_delivery_retry_queue` | `webhook_deliveries`| `status, nextAttemptAt`     | webhook retry poll                                                |

The two partial indexes cover only the rows still waiting for work (unsettled
receipts, unrefunded sessions), so they stay small as history grows.

The export pages with `(createdAt, id) > (:cursorAt, :cursorId)` on the bare
columns. The cursor carries `createdAt` as text with microseconds taken from
the database, because rounding it through a JavaScript `Date` (milliseconds)
would skip or repeat rows that share a millisecond.

## Known gap

The spending-limit window filters on `LOWER("agentA")`, because addresses were
stored in whatever case the caller sent. An expression index cannot be
declared through entity decorators, and schema sync drops indexes it does not
know about, so that query is not index-backed yet. It becomes one once
addresses are normalised on write and the filter can use the bare column.
