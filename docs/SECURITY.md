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
