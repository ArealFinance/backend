# @areal/backend

Backend service for the [Areal Finance](https://areal.finance) protocol.

Runs the on-chain **indexer** (subscribes to all 5 Areal programs, persists every event to Postgres), exposes a REST API for the user app and admin panel, and serves Prometheus metrics for observability.

## Stack

- **Nest.js 10** (TypeScript, CommonJS modules)
- **Postgres 15** + **TypeORM 0.3.x** (no `synchronize` — migrations only)
- **Redis 7** + **Bull** (indexer job queue)
- **Passport + JWT** (wallet-signature authentication)
- **Swagger** (`/api/docs`)
- **prom-client** (`/metrics`)

## Quick start

```bash
# 1. clone + checkout the parent repo with submodules
cd areal.newera/backend

# 2. one-shot bootstrap (installs deps, brings up Postgres + Redis, runs migrations)
./scripts/bootstrap.sh

# 3. start the dev server
npm run start:dev
```

Open:
- **Swagger UI** — http://127.0.0.1:3010/api/docs
- **Health** — http://127.0.0.1:3010/health
- **Metrics** — http://127.0.0.1:3010/metrics

## Repository layout

```
backend/
├── src/
│   ├── main.ts                 # Bootstrap (helmet, CORS, Swagger, validation)
│   ├── app.module.ts           # Root module composition
│   ├── data-source.ts          # TypeORM CLI data source (migrations only)
│   ├── config/configuration.ts # Env-driven config factory
│   ├── common/                 # Cross-cutting helpers
│   │   ├── decorators/
│   │   ├── filters/            # Global exception filter
│   │   └── pipes/              # PubkeyPipe (base58 validation)
│   ├── entities/               # TypeORM entities
│   │   ├── event.entity.ts     # Raw chain event (indexer source-of-truth)
│   │   ├── user.entity.ts
│   │   └── refresh-token.entity.ts
│   ├── modules/
│   │   ├── auth/               # Wallet-sig → JWT + refresh rotation
│   │   ├── indexer/            # Chain listener + reconcile + backfill + decoder + persister
│   │   ├── health/             # /health (DB + RPC)
│   │   └── metrics/            # /metrics (Prometheus)
│   └── migrations/0001-init.ts
├── docker-compose.yml          # Local dev (Postgres + Redis only)
├── docker-compose.prod.template.yml
├── Dockerfile
└── scripts/bootstrap.sh
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the indexer dataflow and design decisions.

## Environment

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres URL (use `?sslmode=require` in prod) |
| `REDIS_URL` | Redis URL for Bull |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | JWT signing keys (`openssl rand -hex 64`) |
| `RPC_URL_MAINNET` / `RPC_URL_DEVNET` | Solana RPC endpoints |
| `SOLANA_CLUSTER` | `mainnet` / `devnet` / `localnet` |
| `BACKFILL_BLOCKS` | Slots to walk back on first deploy (default `216000` ≈ 1 day) |

`JWT_SECRET` MUST differ between environments and MUST NOT be committed.

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` | Type-check + emit `dist/` |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | ESLint + Prettier (zero warnings allowed) |
| `npm run migration:generate` | Generate a migration from entity diffs |
| `npm run migration:run` | Apply pending migrations |
| `npm run migration:revert` | Roll back the last migration |

## Phase

This is **Phase 12.1** — backend skeleton + indexer + auth + ops infra. Phases 12.2 / 12.3 add projections (transactions, pool snapshots, leaderboards), the rest of the REST API, and Socket.IO real-time push.

## License

Apache-2.0 — see [LICENSE](./LICENSE) at the repo root.
