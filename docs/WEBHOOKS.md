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
| `POST /webhooks/:id/rotate-secret` | issue a new secret (returned once)               |
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
X-Prom-Signature: t=1780315200,v1=5f2c...

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

## Verifying a delivery

Every delivery is signed with the secret of its subscription:

```
X-Prom-Signature: t=<unix seconds>,v1=<hex>
v1 = HMAC-SHA256(secret, "<t>.<raw request body>")
```

A receiver must:

1. compute the HMAC over the timestamp from the header, a dot and the **raw**
   body bytes (not re-serialised JSON), and compare it in constant time;
2. reject the request when `|now - t|` exceeds its tolerance (300 seconds is
   the default of the helper below). The timestamp is part of the signed
   payload, so it cannot be moved without breaking the signature;
3. remember `X-Prom-Delivery` for at least the tolerance window and ignore an
   id it has already processed. Steps 2 and 3 together stop replays: an old
   capture is too old, a recent one is a known id.

The header is signed when the request is sent, so a redelivery has a fresh
timestamp and the same delivery id.

Node receivers can reuse the rail's own check
(`src/modules/webhooks/webhook-signature.ts`):

```ts
const check = verifySignatureHeader({
  secret,                                   // from POST /webhooks
  header: req.headers['x-prom-signature'],
  body: rawBody,                            // string, exactly as received
  toleranceSeconds: 300,
});
if (!check.valid) return res.status(401).end(check.reason);
```

`check.reason` is `malformed_header`, `timestamp_out_of_tolerance` or
`signature_mismatch`. A header may carry several `v1` values; any match is
accepted, and unknown keys are ignored.

`POST /webhooks/:id/rotate-secret` replaces the secret at once: deliveries
sent afterwards verify only against the new one, so deploy the new secret to
the receiver (accepting both for a moment) before or right after rotating.

`data` by event:

| event                | fields                                                                                   |
|----------------------|------------------------------------------------------------------------------------------|
| `escrow.opened`      | `escrowId, agentA, agentB, depositAmount, budgetLimit, ttl, txHash`                      |
| `escrow.closed`      | `escrowId, status, reason, closedAt, txHash`                                             |
| `settlement.settled` | `settlementId, escrowId, totalAmount, feeAmount, receiptsHash, receiptCount, txHash`     |
| `settlement.failed`  | the same, plus `status, attempts, lastError`                                             |
