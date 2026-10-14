# Webhooks

The Payment Rail can push escrow and settlement events to HTTP endpoints, so an
integrator does not have to poll `GET /escrow/:id` or `GET /settlements/:id`.

Code: `src/modules/webhooks/`.

## Events

| event                | emitted when                                                    |
|----------------------|-----------------------------------------------------------------|
| `escrow.opened`      | `POST /escrow` stored the session (after the on-chain attempt)  |
| `escrow.closed`      | `POST /escrow/:id/close` or `/emergency-close` closed a session |
| `settlement.settled` | a settlement was mined (first attempt, retry or manual replay)  |
| `settlement.failed`  | a settlement became `rejected` or `dead_letter`                 |

A settlement that is merely `retrying` emits nothing: it will end as one of the
two final events.

## Managing subscriptions

All routes require a bearer token with role `admin` or `service`.

| route                           | purpose                                             |
|---------------------------------|-----------------------------------------------------|
| `POST /webhooks`                | create: `{ url, events[], description? }`           |
| `GET /webhooks`                 | list subscriptions, without secrets                 |
| `DELETE /webhooks/:id`          | remove a subscription                               |
| `GET /webhooks/:id/deliveries`  | the 50 most recent deliveries with their outcome    |

`POST /webhooks` answers with the subscription including its `secret` (32
random bytes, hex). This is the only time the secret is returned; store it.

`url` must be `http` or `https`. With `NODE_ENV=production` only `https` is
accepted unless `WEBHOOK_ALLOW_HTTP=true` is set.

## Delivery

Each event is sent as one `POST` per interested subscription:

```
POST <subscription url>
Content-Type: application/json
X-Prom-Event: settlement.settled
X-Prom-Delivery: 6a1f...            (delivery id, same as "id" in the body)

{
  "id": "6a1f...",
  "event": "settlement.settled",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "data": { "settlementId": "...", "escrowId": "...", "totalAmount": "1.5", ... }
}
```

- Any `2xx` answer within `WEBHOOK_TIMEOUT_MS` (default 5000) marks the
  delivery `delivered`; anything else marks it `failed` and records the status
  or the error in `lastError`.
- Redirects are not followed.
- Deliveries are sent after the state change is committed and never block or
  fail the API call that caused them.
- Every delivery is stored in `webhook_deliveries`, so the outcome can be
  inspected through `GET /webhooks/:id/deliveries`.

`data` by event:

| event                | fields                                                                                   |
|----------------------|------------------------------------------------------------------------------------------|
| `escrow.opened`      | `escrowId, agentA, agentB, depositAmount, budgetLimit, ttl, txHash`                      |
| `escrow.closed`      | `escrowId, status, reason, closedAt, txHash`                                             |
| `settlement.settled` | `settlementId, escrowId, totalAmount, feeAmount, receiptsHash, receiptCount, txHash`     |
| `settlement.failed`  | the same, plus `status, attempts, lastError`                                             |
