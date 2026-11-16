# Database

PostgreSQL through TypeORM. Connection settings live in
`src/common/database/database-options.ts` and are shared by the service and the
migration CLI, so both always talk to the same database and the same schema
history table (`schema_migrations`).

## Where the schema comes from

| environment        | schema                                                        |
|--------------------|---------------------------------------------------------------|
| laptop, tests, CI  | schema sync from the entities (`synchronize`), the default    |
| mainnet profile    | migrations only; sync needs MAINNET_ALLOW_SCHEMA_SYNC=true     |
| anywhere else      | migrations when `DATABASE_SYNCHRONIZE=false`                  |

Schema sync is convenient and dangerous for the same reason: it makes the
tables match the entities, including dropping a column that an entity no
longer has. Production databases change only through migrations.

## Migrations

Migrations live in `src/migrations`, one class per file, registered in
`src/migrations/index.ts` (oldest first). The CLI reads the compiled output:

```bash
npm run migration:generate -- src/migrations/AddPayoutMemo  # builds first, diffs entities vs database
npm run build
npm run migration:show      # [X] applied, [ ] pending
npm run migration:run       # applies everything pending, one transaction per migration
npm run migration:revert    # undoes the last one
```

`migration:generate` compares the entities with the database it is pointed
at, so point it at a database that is at the latest migration (run
`migration:run` first, with schema sync off). Review the generated SQL, add
the class to `index.ts`, and commit both. `src/common/database/registry.spec.ts`
fails when an entity file or a migration file is not registered.

Rules for a migration:

- a new column on an existing table is nullable or has a default, so it can be
  added to a table that already has rows;
- `down()` really undoes `up()`, so a release can be rolled back;
- data backfills go into their own migration, not into a schema one.

Deploys run `migration:run` once, before the new version starts (the
production image has no npm: `node node_modules/typeorm/cli.js -d
dist/common/database/data-source.js migration:run`). A single-instance setup
can set `DATABASE_RUN_MIGRATIONS=true` instead and let the service apply them
on boot; with several replicas that would race.

## TLS

`DATABASE_SSL=true` enables TLS with certificate checks; `DATABASE_SSL_CA`
takes the CA as PEM (literal `\n` is accepted). Skipping the check
(`DATABASE_SSL_REJECT_UNAUTHORIZED=false`) is for a self-signed staging server
only; the mainnet profile refuses to start with it.

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
