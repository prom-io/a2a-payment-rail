# a2a-payment-rail — Onboarding

Read this **after** the top-level `HANDOFF.md` in `a2a-infra-compose`. This document is specific to the Payment Rail service.

## 1. What this service does

The Payment Rail mediates value transfer between agents:

- **Escrow** — Agent A locks funds against Agent B for a session (cap, TTL, optional streaming flag).
- **Receipts** — Cryptographically-signed proofs that work was delivered. Receipts are validated and aggregated.
- **Settlement** — Periodic batch settlement of accumulated receipts on-chain.
- **Streaming** — Continuous claim of funds during long-running sessions, with stream-rate accounting.
- **Verdicts** — Integration with the Verification Network: only "valid" verdicts release funds; "invalid" or "disputed" can claw back.

Think of it as the "billing + escrow + settlement" backend for agent transactions.

## 2. How it fits in

```
agent-layer (3001) ──── opens escrow ───▶ payment-rail (3003)
                                                │
                          submits receipts ─────┤
                                                │
                                ◀── verdicts ───── verification-network (3002)
                                                │
                                          settles on-chain
                                                │
                                          ▼
                                       Anvil EVM (8545)
                                       (in prod: a real EVM chain)
```

## 3. Tech stack (specifics)

- NestJS 10, TypeORM, PostgreSQL
- ethers.js v6, Solidity 0.8.24 (Foundry)
- `@nestjs/throttler`, `@nestjs/jwt`, `@nestjs/passport` for security
- `class-validator` + `class-transformer` for DTO validation
- Jest + Supertest for tests

## 4. Repository layout

```
a2a-payment-rail/
├── src/
│   ├── main.ts                 # bootstrap: pipes, interceptors, filters, Swagger
│   ├── app.module.ts           # Throttler, Auth, security middleware wiring
│   ├── config/
│   │   ├── database.config.ts
│   │   ├── blockchain.config.ts
│   │   ├── security.config.ts  # JWT/Throttler/CORS/Headers from env
│   │   └── throttler.config.ts
│   ├── common/
│   │   ├── auth/               # JWT strategy + guard, RBAC roles, refresh tokens, password hashing
│   │   ├── decorators/         # @Public, @CurrentUser, @Roles, @SkipThrottle re-export
│   │   ├── filters/            # global exception filter
│   │   ├── interceptors/       # logging, audit
│   │   ├── middleware/         # security headers, CSRF
│   │   ├── pipes/              # SanitizePipe, ParseEthereumAddressPipe
│   │   └── blockchain/         # ethers wrapper, ABIs
│   └── modules/
│       ├── escrow/             # POST /escrow, GET /escrow/:id, ...
│       ├── settlement/         # POST /settlements
│       ├── streaming/          # POST /streaming/claim
│       ├── verdicts/           # GET /verdicts/:sessionId, ...
│       ├── receipts/           # POST /receipts, POST /receipts/validate
│       └── health/             # GET /health, GET /ready
├── contracts/                  # Foundry: src/, test/, script/
│   ├── src/
│   │   ├── EscrowHub.sol
│   │   └── VerdictIntegration.sol
│   ├── test/
│   ├── script/Deploy.s.sol
│   ├── foundry.toml
│   └── lib/forge-std (submodule)
├── docker/
│   ├── Dockerfile              # production
│   └── Dockerfile.dev          # hot-reload + debugger port 9229
├── docker-compose.dev.yml      # standalone local stack
├── docs/
│   └── SECURITY.md             # threat model + controls
├── test/                       # e2e tests (supertest)
└── .env.example                # all required env vars with sample values
```

## 5. Environment variables

Copy `.env.example` to `.env` and adjust as needed. Key groups:

| Group | Variables | Notes |
|---|---|---|
| Database | `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` | for local dev: defaults work with `docker-compose.dev.yml` |
| Blockchain | `RPC_URL`, `PRIVATE_KEY`, `ESCROW_HUB_ADDRESS` | local dev: anvil RPC + first anvil dev key |
| API | `PORT` (default 3003), `CORS_ORIGINS` | comma-separated list |
| JWT | `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | generate a strong secret for non-dev |
| Throttler | `THROTTLE_SHORT_TTL`, `THROTTLE_SHORT_LIMIT`, `THROTTLE_LONG_TTL`, `THROTTLE_LONG_LIMIT` | dual-tier rate limiting |
| Headers | `HSTS_MAX_AGE`, `CSP_DIRECTIVES` | optional overrides |
| CSRF | `CSRF_SECRET` | required in production |

## 6. Local development

### Option A — full stack (recommended for first run)

```bash
cd a2a-infra-compose
docker compose up --build -d
docker compose logs -f payment-rail
```

### Option B — service-only with hot-reload

```bash
cd a2a-payment-rail
cp .env.example .env
docker compose -f docker-compose.dev.yml up
```

That spins up `postgres`, `anvil`, and `payment-rail` (hot-reload, debug port 9229).

### Option C — bare metal (PostgreSQL + anvil already running)

```bash
npm install
cp .env.example .env
npm run start:dev
```

Smoke test:

```bash
curl http://localhost:3003/health
# → { "status": "ok", "components": { ... } }
```

## 7. Running tests

```bash
npm run test            # unit tests
npm run test:e2e        # supertest integration tests, requires running infra
npm run test:cov        # coverage report
```

Security-focused e2e tests live in `test/security.e2e-spec.ts` and cover headers, validation, and rate limiting.

## 8. Working with smart contracts

```bash
cd contracts
forge install     # only first time, after cloning
forge build
forge test
forge test -vvv   # verbose for debugging

# Deploy to local anvil
forge script script/Deploy.s.sol \
  --rpc-url http://localhost:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast
```

The deploy script writes contract addresses to stdout — copy `EscrowHub` address into `.env` as `ESCROW_HUB_ADDRESS`. For the integrated stack, `a2a-infra-compose/scripts/deploy-contracts.sh` does this automatically.

## 9. Conventions specific to this repo

- **Ethereum addresses** — always passed through `ParseEthereumAddressPipe` (lowercased, regex-validated) before reaching the service layer.
- **Money amounts** — passed and stored as **decimal strings** (`"1000000000000000000"` = 1 ETH in wei). Never use JS `number` for money.
- **Session IDs** — UUID v4. Validate with `@IsUUID('4')` in DTOs.
- **Hashes** — 0x-prefixed 32-byte hex (`/^0x[0-9a-fA-F]{64}$/`).
- **Logging** — use the injected `Logger` with the class name as the context. Don't `console.log`.
- **Errors** — throw the appropriate Nest exception (`BadRequestException`, `NotFoundException`, ...). The global `AllExceptionsFilter` formats the response.
- **Public endpoints** — annotate with `@Public()` (from `src/common/decorators/public.decorator.ts`) to bypass JWT auth.
- **Rate-limit-exempt endpoints** — annotate with `@SkipThrottle()` (typically `/health`, `/ready`, `/metrics`).
- **Mutations** — auto-audited by `AuditInterceptor` (POST/PUT/PATCH/DELETE). One log line per request.

## 10. Common tasks

### Add a new endpoint

1. Pick the right module under `src/modules/`.
2. Add a method in the controller with `@ApiOperation`, `@ApiResponse`, `@ApiParam` decorators.
3. Add a DTO under `dto/` with strict `class-validator` constraints.
4. Implement business logic in the service.
5. If it mutates state, no extra work — `AuditInterceptor` covers it.
6. Add a unit test (`*.spec.ts` next to the service) and/or an e2e test in `test/`.

### Add a new entity

1. Create `src/modules/<module>/entities/<thing>.entity.ts`.
2. Register it in the module's `forFeature([...])`.
3. Run `npm run start:dev` once locally — TypeORM `synchronize: true` (dev only) will create the table.
4. For production: generate a migration (planned — not yet wired into this repo, see "next steps").

### Add a new contract

1. Add `.sol` file under `contracts/src/`.
2. Add tests under `contracts/test/`.
3. Update `contracts/script/Deploy.s.sol` if the deploy flow needs it.
4. Update `a2a-infra-compose/scripts/deploy-contracts.sh` to capture the new address into `.env`.
5. Add ABI under `src/common/blockchain/abis/<name>.abi.ts`.
6. Wire it where you need it via `BlockchainService.getContract(address, ABI)`.

## 11. What's done and what's next

Done (Phases 0–2):

- P0 Foundation — NestJS scaffold, modules, DTOs, contracts, Docker.
- P1 Hardening — graceful shutdown, logging interceptor, exception filter, e2e tests.
- P2 Security — RBAC, JWT refresh, password hashing (scrypt), CSRF, security headers, audit interceptor, security e2e tests, threat model docs.

Likely next (per the Google Sheets plan):

- P3 Observability — `/metrics` (Prometheus), structured request IDs, distributed tracing.
- P3 Migrations — replace TypeORM `synchronize` with `migrationsRun` + first migration.
- P4 Settlement gas optimisation — batch packing, EIP-2930 access lists.
- P4 Streaming refinements — refund flow on early termination.

Confirm with the owner before starting any of these — the sheet is canonical.

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ECONNREFUSED 5432` on startup | PostgreSQL is not running. `docker compose up postgres` or check your local instance. |
| `nonce too low` from ethers | anvil was reset; restart the service so the wallet refetches its nonce. |
| 401 on every request | JWT auth is on by default. Use `@Public()` for endpoints that don't need auth, or send a valid bearer token. |
| 429 Too Many Requests | rate limiter triggered. Wait, or annotate the route with `@SkipThrottle()` if appropriate. |
| Migration mismatch errors | `synchronize: true` is dev-only; once migrations land, set `NODE_ENV=production` and run them explicitly. |
| `forge build` errors about missing `forge-std` | run `forge install` inside `contracts/` once. |
