# A2A Payment Rail

PROM Micropayment & Settlement Rail — escrow, streaming payments, batch settlements, and receipt management for the A2A protocol.

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
| `npm run test:e2e` | Run e2e tests |

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
