# Webhooks

The Payment Rail can push escrow and settlement events to HTTP endpoints, so an
integrator does not have to poll `GET /escrow/:id` or `GET /settlements/:id`.

Code: `src/modules/webhooks/`.

## Events

| event                | emitted when                                                    |
|----------------------|-----------------------------------------------------------------|
| `escrow.opened`      | `POST /escrow` stored the session (after the on-chain attempt)  |
| `escrow.closed`      | a session was closed, emergency-closed, cancelled or expired    |
| `escrow.refunded`    | the unspent deposit of an expired or cancelled session was returned |
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
  delivery `delivered`; anything else marks it `failed`, records the status
  or the error in `lastError` and schedules a retry (see below).
- Redirects are not followed.
- Deliveries are sent after the state change is committed and never block or
  fail the API call that caused them.
- Every delivery is stored in `webhook_deliveries`, so the outcome can be
  inspected through `GET /webhooks/:id/deliveries`.

## Retries

A failed delivery is retried with exponential backoff by `WebhookRetryService`,
which polls `webhook_deliveries` for `failed` rows whose `nextAttemptAt` has
passed every `WEBHOOK_RETRY_TICK_MS` (default 10 s).

| variable                      | default | meaning                                  |
|-------------------------------|--------:|------------------------------------------|
| `WEBHOOK_MAX_ATTEMPTS`        |       6 | attempts per delivery, the first included |
| `WEBHOOK_RETRY_BASE_DELAY_MS` |   10000 | delay before the second attempt          |
| `WEBHOOK_RETRY_MAX_DELAY_MS`  | 3600000 | ceiling of the doubled delay             |
| `WEBHOOK_RETRY_ENABLED`       |    true | `false` stops the poller                 |

With the defaults the attempts are spaced 10 s, 20 s, 40 s, 80 s and 160 s
apart. The delay is counted from the failed attempt.

A delivery ends as `exhausted`, and is not sent again, when

- the attempts are used up;
- the endpoint answers `410 Gone`: the subscription is also set inactive, since
  the subscriber said the endpoint will not come back;
- its subscription was removed or deactivated in the meantime.

Timeouts, connection errors and every non-2xx status other than 410 are
retried. A redelivery keeps the delivery id (`X-Prom-Delivery` and `id` in the
body) and gets a new signature timestamp, so receivers must treat the id as
the idempotency key: the same event can arrive more than once, for example
when the receiver processed it but answered too late.

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
| `escrow.refunded`    | `escrowId, reason, depositAmount, spentAmount, refundAmount, txHash`                     |
| `settlement.settled` | `settlementId, escrowId, totalAmount, feeAmount, receiptsHash, receiptCount, txHash`     |
| `settlement.failed`  | the same, plus `status, attempts, lastError`                                             |
