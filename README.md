# A2A Payment Rail

PROM Micropayment & Settlement Rail — escrow, streaming payments, batch settlements, and receipt management for the A2A protocol.

> **Status:** Phase 1 complete

## Tech Stack

- **Backend**: NestJS (TypeScript)
- **Database**: PostgreSQL (TypeORM)
- **Contracts**: Solidity 0.8.24 (Foundry)
- **Blockchain**: Ethers.js v6

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start in development mode
npm run start:dev
```

The API runs on `http://localhost:3003`. Swagger docs are at `http://localhost:3003/api`.

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run start:dev` | Start with watch mode |
| `npm run start:prod` | Start production build |
| `npm run lint` | Lint source files |
| `npm run test` | Run unit tests |
| `npm run test:e2e` | Run integration tests (supertest) |

## Smart Contracts

Contracts live in `contracts/` and use Foundry.

```bash
cd contracts

# Build
forge build

# Test
forge test

# Deploy (local)
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast
```

## API Modules

| Module | Base Path | Description |
|---|---|---|
| Escrow | `/escrow` | Open, query, close escrow sessions |
| Settlement | `/settlements` | Batch settlement submission and queries |
| Streaming | `/streaming` | Streaming micro-payment claims |
| Verdicts | `/verdicts` | Verdict status and fund release |
| Receipts | `/receipts` | Payment receipt creation and validation |
| Health | `/health` | Service health check |

## Docker

```bash
docker build -f docker/Dockerfile -t a2a-payment-rail .
docker run -p 3003:3003 --env-file .env a2a-payment-rail
```

Or via the infra-compose stack (recommended):

```bash
# In a2a-infra-compose/
docker compose up --build -d
```

## Cross-Cutting Features

| Feature | File | Description |
|---|---|---|
| Graceful shutdown | `src/main.ts` | `enableShutdownHooks()` for clean SIGTERM handling |
| HTTP logging | `src/common/interceptors/logging.interceptor.ts` | Logs method, URL, status, duration, IP, user-agent |
| Unified errors | `src/common/filters/http-exception.filter.ts` | Consistent `{ statusCode, error, message, path, timestamp }` |
| Validation | `src/main.ts` | Global `ValidationPipe` with whitelist and transform |
| Blockchain | `src/common/blockchain/blockchain.service.ts` | ethers.js v6 provider + signer + contract ABI |

## Project Structure

```
src/
├── main.ts
├── app.module.ts
├── config/
│   ├── database.config.ts
│   └── blockchain.config.ts
├── common/
│   ├── filters/
│   │   └── http-exception.filter.ts
│   ├── interceptors/
│   │   └── logging.interceptor.ts
│   └── blockchain/
│       ├── blockchain.module.ts
│       ├── blockchain.service.ts
│       └── abis/
│           └── escrow-hub.abi.ts
└── modules/
    ├── escrow/         # Escrow lifecycle management
    ├── settlement/     # Batch settlement
    ├── streaming/      # Streaming micropayments
    ├── verdicts/       # Verdict-aware fund release
    ├── receipts/       # Payment receipts
    └── health/         # Health check endpoint
contracts/
├── src/
│   ├── EscrowHub.sol
│   └── VerdictIntegration.sol
├── test/
└── script/
test/
├── jest-e2e.json
└── app.e2e-spec.ts
```
