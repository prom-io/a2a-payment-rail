# Payment Rail — Security Architecture

This document describes the security controls implemented in the Payment Rail service.

## Threat Model

The Payment Rail mediates escrow, receipts, settlement and streaming between agents.
Primary threats:

| # | Threat | Control |
|---|--------|---------|
| T1 | Unauthorized escrow creation | JWT auth + RBAC (`admin`, `agent`) |
| T2 | Replay of refresh tokens | Refresh-token rotation + revocation list |
| T3 | Cross-site request forgery | Double-submit CSRF token with HMAC signature |
| T4 | Brute-force on password endpoints | `@nestjs/throttler` dual-tier rate limits |
| T5 | Injection via request body | `SanitizePipe` + `class-validator` DTOs |
| T6 | Leak of internal info via headers | `SecurityHeadersMiddleware` (CSP, HSTS, X-Frame-Options) |
| T7 | Passwords stored in plaintext | `PasswordService` with `scrypt` + `timingSafeEqual` |
| T8 | Unlogged privileged actions | `AuditInterceptor` on every mutating request |
| T9 | Compromised or runaway payer drains its funds into escrow | Rolling spending limit per payer (`SpendingLimitService`) |

## Emergency pause

`PauseService` (`src/modules/ops/`) stops money from leaving towards payees
without stopping the service.

| scope | blocks (HTTP 503) | automatic jobs |
|---|---|---|
| `settlement` | `POST /settlements/batch`, `POST /settlements/:id/replay`, `POST /escrow/:id/release` | batch scheduler and retry queue do nothing; receipts and queued settlements wait |
| `streaming` | `POST /streaming/claim` | none |

Never blocked: opening, closing and cancelling an escrow, refunds, all reads.
A pause must not trap a payer's deposit. A settlement whose transaction was
already sent when the pause came is not recalled.

- `POST /admin/pause` `{ "scope": "settlement" | "streaming" | "all", "reason": "..." }`
  and `POST /admin/resume` `{ "scope": ... }`, role `admin`;
  `GET /admin/pause` shows the state with reason, actor and time.
- The switch is a row per scope in `system_flags`. It takes effect at once on
  the instance that received the call and within `PAUSE_REFRESH_MS` (5 s) on
  the others, and it survives restarts. If the table cannot be read the last
  known state is kept.
- `EMERGENCY_PAUSE=all` (or a comma-separated list of scopes) pauses from the
  environment, for the case where the API or the admin credentials are what
  failed. It cannot be lifted through the API, only by removing it and
  restarting. A misspelled value stops the service at startup.
- `GET /health` reports `paused.settlement` / `paused.streaming` and stays
  `ok`: a paused rail must not be restarted by an orchestrator. The gauge
  `payment_rail_paused{scope}` is `1` while a scope is paused.

## Startup validation (mainnet)

`ConfigModule` runs `validateConfig` (`src/config/config-validation.ts`)
before any module is built. With `NETWORK_PROFILE=mainnet` the process refuses
to start, listing every problem at once, when:

| variable | refused when |
|---|---|
| `NODE_ENV` | not `production` |
| `CHAIN_ID` | missing, or a development/testnet id (31337, 1337, 71234) |
| `BLOCKCHAIN_RPC_URL` | missing, not `https`/`wss`, or a local host |
| `BLOCKCHAIN_PRIVATE_KEY` | missing or malformed (the fallback is the anvil key), or one of the published anvil/hardhat keys |
| `ESCROW_HUB_ADDRESS` | missing, malformed or the zero address |
| `TX_CONFIRMATIONS` | set below 6 |
| `MAX_FEE_PER_GAS_GWEI` | set to 0 (the fee cap cannot be disabled) |
| `JWT_SECRET`, `CSRF_SECRET` | missing, a default from the repository, shorter than 32 characters, or equal to each other |
| `DATABASE_PASSWORD` | missing or a default (`postgres`, ...) |
| `DATABASE_SYNCHRONIZE` | `true` without `MAINNET_ALLOW_SCHEMA_SYNC=true` |
| `CORS_ORIGINS` | missing, `*`, not `https`, or a local origin |
| `HSTS_ENABLED` | `false` |
| `WEBHOOK_ALLOW_HTTP` | `true` |

The error names the variables and never prints their values. An unknown
`NETWORK_PROFILE` is refused on every profile. The `local` and `testnet`
profiles are not checked: the values refused here are the ones that make a
development setup work without configuration.

Schema sync follows the same idea: on mainnet `synchronize` is off unless
`DATABASE_SYNCHRONIZE=true` and `MAINNET_ALLOW_SCHEMA_SYNC=true` are both set
for the deploy that changes the schema; on the other profiles it stays on.

## Spending limits

`POST /escrow` counts the deposit against the payer (`agentA`):

- the limit is the payer's row in `spending_limits`
  (`PUT /spending-limits/:payer`, role `admin`, body `{ "dailyLimit": "25" }`)
  or, without one, `SPENDING_LIMIT_DAILY_DEFAULT`. An empty or zero default
  means unlimited; an override of `"0"` exempts a single payer;
  `DELETE /spending-limits/:payer` removes the override;
- "spent" is the sum of deposits of the sessions the payer opened in the last
  `SPENDING_LIMIT_WINDOW_HOURS` (24), cancelled sessions excluded. The window
  rolls, it does not reset at midnight;
- a deposit that would exceed the limit is refused with `403` before anything
  is stored or sent on-chain. Check and insert run in one transaction under a
  per-payer Postgres advisory lock, so concurrent requests cannot pass together;
- `GET /spending-limits/:payer` returns
  `{ dailyLimit, source, windowHours, windowStart, spent, remaining }`.

## Authentication

- **JWT Bearer** — access tokens, short TTL (`JWT_EXPIRES_IN`, default 1h).
- **Refresh tokens** — long-lived (`JWT_REFRESH_EXPIRES_IN`, default 7d), rotated on every refresh; previous refresh token is pushed to an in-memory revocation list.
- **Passwords** — hashed with `scrypt` (N=16384, r=8, p=1), 16-byte salt, 64-byte key, compared in constant time.

## Authorization

- `RolesGuard` reads `@Roles(...)` metadata and compares against `req.user.role`.
- `@Public()` bypasses `JwtAuthGuard` globally.
- Known roles: `admin`, `agent`, `validator`, `service`.

## Input handling

- `SanitizePipe` runs before `ValidationPipe`: strips HTML, trims strings, recurses into objects and arrays.
- DTOs use `class-validator` with strict constraints (`@IsEthereumAddress`, `@Min`, `@Max`, `@Matches`).
- `ParseEthereumAddressPipe` normalizes and validates route params.

## Transport & headers

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `0` (CSP preferred) |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | `default-src 'self'` |

CORS is pinned to the list in `CORS_ORIGINS`.

## Rate limiting

- **Short**: 10 req / 1s per IP (burst protection).
- **Long**: 100 req / 60s per IP (sustained-load protection).
- `@SkipThrottle()` whitelisted on `/health`.

## CSRF

- Tokens are `nonce.HMAC-SHA256(nonce, CSRF_SECRET)`.
- Double-submit: `X-CSRF-Token` header must equal `csrf-token` cookie.
- Only enforced on non-safe methods (POST, PUT, PATCH, DELETE).

## Audit

`AuditInterceptor` logs one line per mutating request:

```
audit method=POST path=/escrow user=<sub> ip=<ip> ua="..." status=201 durationMs=42
```

## Environment variables

See `.env.example` for `JWT_*`, `THROTTLE_*`, `CSRF_SECRET`, `CORS_ORIGINS`.

## Responsible disclosure

Report vulnerabilities to `security@prom.io`. We aim to acknowledge within 48h.
