# Mainnet runbook

How to launch `a2a-payment-rail` on mainnet, how to operate it, and how to back
out. Everything here refers to behaviour that exists in this repository; where
the code has a limit, the limit is stated instead of worked around on paper.

Related: [SECURITY.md](SECURITY.md) (startup validation, pause, signer
rotation), [ADVANCED.md](ADVANCED.md) (profiles, batching),
[OBSERVABILITY.md](OBSERVABILITY.md) (metrics, reconciliation),
[CI-CD.md](CI-CD.md) (pipelines, image tags).

## 1. What the mainnet profile changes

`NETWORK_PROFILE=mainnet` (see `src/config/network.config.ts`):

| setting | local | mainnet |
|---|---|---|
| confirmations before a transaction counts | 1 | 12 |
| wait for those confirmations | forever | 10 min, then the settlement goes to the retry queue |
| fee cap for settlements | none | 50 gwei (`MAX_FEE_PER_GAS_GWEI`) |
| schema sync on boot | on | off unless explicitly allowed |
| startup validation | none | refuses to boot on unsafe settings |

`.env.mainnet.example` is the template. Its placeholders (`<...>`) are not
valid values. Startup validation rejects a copy that still has one for the
chain id, RPC endpoint, signer key, hub address, either secret or the CORS
origins; a placeholder left in the database settings fails at the first
connection, and one left in the spending limit stops the service at startup.

## 2. Known limits to accept before launch

Read these with whoever signs off the launch. None of them is hidden by the
software.

1. **The rail is custodial on-chain.** `POST /escrow` makes the rail's signer
   call `openEscrow` and send the deposit as `msg.value`. On the hub the
   "payer" of every escrow is therefore the signer address, not the `agentA`
   of the request: the signer wallet must hold the deposits it opens, not just
   gas, and what the hub pays back on a close or a refund returns to the
   signer wallet. Crediting the real payer is the off-chain record
   (`escrow_refunds`), settled by whatever treasury process funds the wallet.
2. **Hub ownership is fixed.** `EscrowHub.owner` is the deployer and cannot be
   transferred. `emergencyClose`, which refunds use, is owner-only. Deploy the
   hub **from the settlement signer**, or refunds fail on-chain (the refund
   row is kept as `failed` and can be retried). `closeEscrow`, used by
   `POST /escrow/:id/close`, is restricted to the address that opened the
   escrow. Both restrictions are why a signer rotation needs preparation
   (section 7).
3. **`settleBatch` is not access-controlled and does not deduplicate.** Anyone
   can call it for an active escrow within its budget; the rail protects
   against its own double submission (stored transaction hash), not against a
   third party. `freezeOnDispute` is also callable by anyone.
4. **One chain per process**, one hub per process (ADVANCED.md, section 1).
5. **The batch scheduler must run on exactly one instance.** Its overlap guard
   is per process.
6. **No migrations.** The schema comes from entity sync. Schema changes are
   additive by convention (new columns are nullable or have defaults), and
   rolling back the image does not roll back the schema (section 6).
7. **Auth is opt-in per route.** Operator routes (`/admin/*`, `/webhooks`,
   `/settlements/export`, `/settlements/:id/replay`, `/fees/withdrawals`,
   `/reconciliation/run`, `PUT|DELETE /spending-limits/:payer`) require an
   `admin` (or `service`) token. The escrow, receipt, settlement-submission,
   release, refund and streaming routes do **not** check a token in this
   service. Mainnet must put them behind the gateway or a private network; do
   not expose port 3003 to the internet.
8. **Fee withdrawals are bookkeeping.** `POST /fees/withdrawals` records a
   payout and enforces the balance; the hub has no function that pays fees
   out.

## 3. Launch checklist

### 3.1 Before the day

- [ ] `EscrowHub` deployed on mainnet from the settlement signer address;
      address recorded; `feePercent` read from the contract.
- [ ] Signer wallet funded: the deposits of the escrows it will open (limit 1)
      plus gas for settlements, releases and refunds. Decide how it is topped
      up and who watches its balance.
- [ ] Postgres provisioned with a dedicated role (not `postgres`), backups and
      point-in-time recovery enabled, restore tested once.
- [ ] Secrets created in the secret store: `BLOCKCHAIN_PRIVATE_KEY`,
      `DATABASE_PASSWORD`, `JWT_SECRET`, `CSRF_SECRET` (the last two at least
      32 characters and different from each other).
- [ ] Environment filled in from `.env.mainnet.example`:
      `CHAIN_ID`, `BLOCKCHAIN_RPC_URL` (https), `ESCROW_HUB_ADDRESS`,
      `CORS_ORIGINS` (https origins only), `FEE_DEFAULT_BPS` equal to the hub's
      `feePercent`, `SPENDING_LIMIT_DAILY_DEFAULT` decided.
- [ ] Network path: only the gateway reaches the service (limit 7).
- [ ] Prometheus scrapes `/metrics`; alerts exist for
      `payment_rail_reconciliation_mismatches > 0`, a stale
      `payment_rail_reconciliation_last_run_timestamp_seconds`,
      `payment_rail_paused == 1`, and the HTTP alerts from OBSERVABILITY.md.
- [ ] An `admin` token can be issued for the on-call operator, and the
      operator has run the pause drill (3.4) on staging.
- [ ] Image to deploy chosen by its immutable `sha-...` tag, and the previous
      tag written down for rollback.

### 3.2 First boot

1. Start **one** instance with the mainnet environment plus, for this boot
   only, `DATABASE_SYNCHRONIZE=true` and `MAINNET_ALLOW_SCHEMA_SYNC=true`, and
   with `SETTLEMENT_BATCH_ENABLED=false`, `ESCROW_EXPIRY_SWEEP_ENABLED=false`.
2. If it exits immediately, read the log: startup validation prints
   `Refusing to start with NETWORK_PROFILE=mainnet: N unsafe setting(s)` and
   one line per variable (never the values). Fix all of them and start again.
3. Check the log line `Blockchain connected: ... wallet: 0x..., profile:
   mainnet, confirmations: 12`. The wallet must be the address that deployed
   the hub.
4. `GET /health` answers `status: ok` with `paused.settlement: false`.
5. Remove the two schema-sync variables and restart. From now on the service
   does not alter tables on boot.

### 3.3 Smoke test with real, small value

With a test payer and payee you control and the smallest sensible amounts:

1. `POST /escrow` and confirm the `EscrowOpened` event on the hub.
2. `POST /receipts` twice, then `POST /settlements/batch` for their total.
   The request returns after 12 confirmations, or the settlement shows
   `retrying` and settles on a later pass of the retry queue. Confirm
   `BatchSettled` and the payee balance.
3. `GET /fees/ledger`: one accrual, equal to the fee withheld on-chain.
4. `POST /escrow/:id/release` for a small amount, then
   `GET /escrow/:id/balance`.
5. `POST /escrow/:id/cancel` on a second escrow and `POST /refunds/:escrowId`:
   status `completed` with a transaction hash; the remainder is back in the
   signer wallet (limit 1).
6. `POST /reconciliation/run`: status `ok`, `mismatches: 0`.
7. Create a webhook subscription to an endpoint you control, repeat step 1 and
   verify the signature of the delivery (WEBHOOKS.md).

Stop if any step differs. Do not enable the automatic jobs to "see if it
sorts itself out".

### 3.4 Pause drill

1. `POST /admin/pause` `{ "scope": "all", "reason": "launch drill" }`.
2. `POST /settlements/batch` and `POST /streaming/claim` answer `503`;
   `GET /health` still answers `200` with both scopes paused.
3. `POST /admin/resume` `{ "scope": "all" }`; both calls work again.

### 3.5 Turning on the automatic jobs

One at a time, each followed by a reconciliation run and a look at the logs:

1. `RECONCILIATION_INTERVAL_MS=900000` (already in the template).
2. `SETTLEMENT_BATCH_ENABLED=true` on **one** instance only. Start with a
   small `SETTLEMENT_BATCH_MAX_RECEIPTS` and raise it once batches settle
   cleanly.
3. `ESCROW_EXPIRY_SWEEP_ENABLED=true`. Every expired session becomes an
   `emergencyClose` transaction, so check the signer's gas first.

Additional instances may serve the API, with the batch scheduler off.

## 4. Routine operation

| signal | where | action |
|---|---|---|
| settlements in `dead_letter` / `rejected` | `GET /settlements/dead-letter` | read `lastError`; fix the cause; `POST /settlements/:id/replay`. A `rejected` row is a contract revert: replaying without a change reverts again |
| settlements stuck in `retrying` with "fee above the cap" | logs, `lastError` | gas spike: wait, or raise `MAX_FEE_PER_GAS_GWEI` deliberately and restart |
| reconciliation `mismatch` | `GET /reconciliation/latest` | section 5.2 |
| reconciliation `failed` | same | RPC problem, not a ledger problem; check the endpoint |
| webhook deliveries `exhausted` | `GET /webhooks/:id/deliveries` | subscriber was down for the whole retry schedule; tell the integrator, events are not resent automatically |
| signer low on gas | chain | top up; settlements fail as transient and retry on their own |

Monthly: run the settlement export for the period
(`GET /settlements/export?from=...&to=...`) and reconcile its fee column with
`GET /fees/ledger`.

## 5. Incidents

### 5.1 First response: pause

When funds may be leaving wrongly, pause first and investigate second:

```
POST /admin/pause   { "scope": "settlement", "reason": "<incident id>" }
```

Effective at once on the instance that took the call and within 5 seconds on
the others. Payouts, retries, replays, releases and the batch scheduler stop;
receipts keep being accepted and wait. Payers can still cancel and be
refunded. A transaction already broadcast is not recalled.

If the API or the admin credentials are what is compromised, set
`EMERGENCY_PAUSE=all` in the environment and restart: that pause cannot be
lifted through the API. Remember that a pause in this service does not stop
anybody from calling the contract directly (limit 3).

### 5.2 Reconciliation mismatch

| kind | usual meaning | first step |
|---|---|---|
| `missing_on_chain` | the escrow was recorded but `openEscrow` failed (the API logs the failure and still returns the session) | do not settle against it; cancel it |
| `inactive_on_chain` | closed on-chain outside the rail | close the session in the ledger after confirming the `EscrowClosed` event |
| `deposit_mismatch` | deposit on-chain differs from the request | treat as an incident; pause settlement for that payer's sessions by pausing the scope |
| `spent_mismatch` | the payee claimed directly with `claimStream`, or a third party called `settleBatch` | compare `BatchSettled` / `StreamClaimed` events with `settlements` and `escrow_releases` |
| `hub_balance_shortfall` | the hub holds less than open sessions are owed | pause `all`; this should be impossible without a contract-level problem |

The job never corrects anything by itself.

### 5.3 Suspected signer key compromise

1. Pause `all`.
2. Move the signer's remaining gas funds to a safe address.
3. Rotate the key with `SIGNER_OVERLAP_SECONDS=0`, so the old key is not
   accepted for a single second (section 7).
4. Because of limit 2, the new key can neither refund nor close the sessions
   the old key opened: plan the hub redeployment and the migration of open
   sessions before resuming.

## 6. Rollback

### 6.1 Application

Images are tagged by commit (`sha-...`) and immutable. Roll back by deploying
the previous tag (CI-CD.md). Before doing so:

1. Pause `settlement` so no payout is in flight during the switch.
2. Deploy the previous tag. Keep the environment: the mainnet variables are
   forward and backward compatible within this phase, and an older image
   simply ignores variables it does not know.
3. `GET /health`, then `POST /reconciliation/run` if the older image has it.
4. Resume.

**Never roll back to an image from before the mainnet profile.** Those images
have schema sync hard-wired on: started against the mainnet database they
would alter it to match their older entities, dropping the columns added
since. The oldest safe rollback target is the first image that contains
startup validation.

What survives a rollback and what does not:

- **Schema.** Not rolled back. Changes are additive, so an older image runs
  against the newer schema: it ignores columns and tables it does not know.
  Do not drop them while a rollback is still possible. The exception is an
  older image that predates a status value: rows in `retrying`, `dead_letter`
  or `cancelled` are unknown to images from before those features, so finish
  or replay such rows before rolling back that far.
- **The pause switch.** Stored in `system_flags`. An image from before the
  pause feature does not read it: rolling back that far silently lifts the
  pause. `EMERGENCY_PAUSE` only helps on images that have the feature; for
  older images, stop the service instead.
- **Queued work.** Settlements in `retrying` and failed webhook deliveries
  stay in their tables and continue when an image that knows them runs.

### 6.2 Configuration

A configuration change that fails validation never takes effect: the new
instance exits at startup and the old one keeps serving, provided the
deployment waits for health before replacing instances. Roll back by
restoring the previous environment.

### 6.3 Leaving mainnet

To stop the service for good or move to a new hub:

1. Pause `settlement` and `streaming`.
2. Let the retry queue empty; resolve every row in
   `GET /settlements/dead-letter`.
3. Cancel or let expire the open sessions and refund them
   (`POST /refunds/:escrowId`, or the expiry sweep).
4. Run reconciliation: `checked: 0` open sessions.
5. Export settlements and the fee ledger for the record.

## 7. Signer rotation

Planned rotation, no compromise suspected:

0. Drain first. The new key cannot close or refund sessions the old key
   opened (limit 2), so pause new escrows at the gateway, let open sessions
   finish, and close or refund the rest with the **old** key still active.
   `POST /reconciliation/run` should report `checked: 0`.
1. Fund the new address (deposits and gas, limit 1).
2. Set `BLOCKCHAIN_PRIVATE_KEY` to the new key,
   `BLOCKCHAIN_PREVIOUS_PRIVATE_KEY` to the old one, `SIGNER_ROTATED_AT` to
   the current instant, and keep `SIGNER_OVERLAP_SECONDS` at 86400.
3. Restart every instance. `GET /admin/signer` shows the new address as
   current and the old one with `acceptedUntil`.
4. From this moment the new key signs every transaction and attestation.
   Attestations signed by the old key verify until `acceptedUntil`.
5. After the window, remove the two rotation variables (the service logs a
   reminder at every start until you do) and destroy the old key.

Settlements and releases work with the new key at once (`settleBatch` is not
restricted). Refunds do not, unless the new key is the hub owner, which a
fixed owner rules out: until the hub supports changing its owner, a signer
rotation that must keep refunds working is also a hub redeployment from the
new key. That is the reason for step 0.
