# Architecture — @areal/backend (Phase 12.1)

## Goals

1. Keep the **chain** as the source of truth. Every byte we serve to the frontend is derived from on-chain events captured by the indexer.
2. **Idempotent ingest**. Live websocket events, periodic reconcile, and one-shot backfill all funnel into the same persister; double-delivery is a no-op.
3. **Cheap to operate**. One Nest process holds the listener, queue worker, REST API, and metrics; we'll only split processes when load demands it.
4. **No business logic in Phase 12.1**. We capture raw events. Projections (transactions, pool snapshots, leaderboards) come in 12.2.

## Indexer dataflow

```
                          ┌──────────────────────┐
                          │ Solana RPC (5 progs) │
                          └──────────┬───────────┘
                                     │  ws onLogs(programId)
                                     ▼
            ┌──────────────────────────────────────────┐
            │ ChainListenerService                     │
            │  • per-program subscription              │
            │  • decode quickly (drop non-Areal logs)  │
            │  • enqueue Bull job (kind=live)          │
            └──────────────────────────┬───────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ Bull (Redis)     │
                              │ indexer:events   │◀── ReconcileService (cron 5min)
                              │                  │◀── BackfillService (boot, once)
                              └─────────┬────────┘
                                        │
                                        ▼
                            ┌─────────────────────────┐
                            │ IndexerConsumer         │
                            │  • live → decode        │
                            │  • historical →         │
                            │     getTransaction()    │
                            │     → decode            │
                            └────────────┬────────────┘
                                         │ DecoderService.decodeLogs()
                                         ▼
                            ┌─────────────────────────┐
                            │ PersisterService        │
                            │ UPSERT events           │
                            │  ON CONFLICT (sig,idx)  │
                            │  DO NOTHING             │
                            └────────────┬────────────┘
                                         │
                                         ▼
                                ┌────────────────┐
                                │ Postgres       │
                                │ areal.events   │
                                └────────────────┘
```

## Components

### ChainListenerService
- One websocket subscription per program (5 total) via `Connection.onLogs`.
- Each `onLogs` callback decodes inline; if no Areal events are present the log batch is dropped before hitting the queue.
- Live jobs ship the full log array (saves a redundant `getTransaction` round-trip on the worker side).

### ReconcileService
- Runs every 5 minutes via `@nestjs/schedule`.
- For each program: queries `MAX(slot) FROM events WHERE program_id = ?`, then walks back via `getSignaturesForAddress(programId, { before })` until it crosses the persisted slot.
- Strict `<` stop condition (not `<=`) so sibling events on the same slot aren't dropped.
- Hard cap on signatures per sweep (`MAX_RECONCILE_SIGNATURES`, default 50k) to keep RPC credit bounded.
- Pattern lifted from `bots/shared/src/reconcile.ts` (the merkle-publisher `EventWatcher.reconcile`).

### BackfillService
- Runs **once** on application bootstrap.
- For each program: if `events` already has a row → skip (reconcile will handle the gap). Otherwise walk back `BACKFILL_BLOCKS` slots from current.
- Fire-and-forget: a chatty program may take many minutes; restart-safe because the persister upserts.

### DecoderService
- Loads each program's IDL JSON from `@areal/sdk/idl/<name>.json` at module init.
- Builds a `discriminator → IdlEvent` map per program (Anchor convention: `sha256("event:<Name>")[..8]`).
- Uses `@arlex/client`'s `deserializeAccount` for borsh body deserialisation.
- Returns `{ programId, eventName, rawBody, data }`. `data` keeps snake_case field names from the IDL so projections can rely on a stable contract.
- **Note:** SDK 0.8.0 will likely ship `decodeEvent(programId, log)` — when it lands, replace this implementation with the SDK helper. The persister and consumer don't depend on the decoder's internals.

### PersisterService
- `UPSERT INTO areal.events ... ON CONFLICT (signature, log_index) DO NOTHING`.
- Coerces `bigint` → string and `Buffer` / `Uint8Array` → hex for JSON storage (Postgres `jsonb` rejects bigints).
- Extracts denormalised lookup columns (`primary_actor`, `pool`, `ot_mint`) from the decoded body so per-actor / per-pool queries stay index-only.

### IndexerConsumer
- Bull worker bound to `indexer:events`.
- Two job kinds:
  - `live` — logs in payload, decode + persist directly.
  - `historical` — fetch the tx via `getTransaction`, then decode + persist.
- Failures throw → Bull's exponential backoff (5 attempts, 2s base) retries.

## Auth

- POST `/auth/login` with `{ wallet, signature, message }` where `message` follows `Login to Areal at <ISO-8601> for wallet <pubkey>`.
- Server enforces:
  - 5-minute timestamp skew (replay defence),
  - the wallet pubkey appears verbatim in the message (replay-across-wallets defence),
  - ed25519 signature validates against the wallet pubkey.
- Issues a JWT access token (default 7d) + an opaque refresh token (default 30d).
- Refresh tokens are stored as **sha256 hashes** — a leaked DB cannot mint new access tokens.
- Refresh rotation: each `/auth/refresh` revokes the presented token and mints a new pair.

## Observability

- `/health` — DB + RPC liveness probes (Redis is implicitly healthy if Bull is alive).
- `/metrics` — Prometheus scrape endpoint with default node metrics + 4 custom vectors (events persisted, queue depth, persist latency, auth failures).
- Standard Nest `Logger` for app-level logs. Production should ship via stdout to whatever log aggregator the host environment provides.

## Deployment posture

- **Local dev:** `docker-compose up -d postgres redis` for storage, `npm run start:dev` for the app. See `scripts/bootstrap.sh`.
- **Production:** `docker-compose.prod.template.yml` materialises the full stack (Postgres + Redis + backend container). All ports bind to `127.0.0.1` — internet exposure is via a reverse proxy (Cloudflared / nginx) that owns TLS termination and ACLs.
- The Dockerfile produces a slim runtime image (multi-stage, production deps only, non-root user).

### Operator runbook — `/metrics` exposure

`/metrics` is mounted on the same Nest listener as the public REST surface (port 3010). For Phase 12.1 we did NOT split it onto a dedicated localhost-only port — the operator-side ACL is simpler and covers the same ground.

The Cloudflared (or nginx) config at `api.areal.finance` MUST drop external requests to `/metrics`:

```yaml
# cloudflared ingress (.cloudflared/config.yml)
ingress:
  - hostname: api.areal.finance
    path: /metrics(/.*)?
    service: http_status:404
  - hostname: api.areal.finance
    service: http://127.0.0.1:3010
```

Prometheus scrapes from inside the same host (over the docker bridge) directly to `http://127.0.0.1:3010/metrics`, bypassing Cloudflared. If we ever co-locate Prometheus on a different host, split `/metrics` onto a dedicated `127.0.0.1:9201` listener (a 10-line Nest standalone-app bootstrap inside `main.ts`) — a TODO in the Phase 12.2 hardening tail.

### Operator runbook — Postgres TLS

`docker-compose.prod.template.yml` ships `?sslmode=disable` because the backend and postgres containers share the compose bridge network — that bridge never crosses the host boundary and adding TLS on it just complicates cert rotation. AppModule's `TypeOrmModule.forRootAsync` opts the node-postgres driver into TLS ONLY when the connection URL contains `sslmode=require`, so changing the URL is the entire upgrade procedure for managed-Postgres / multi-host topologies.

## Decisions worth flagging

- **ESM, not CommonJS.** `package.json` declares `"type": "module"` and every internal import carries an explicit `.js` extension. Two transitive deps forced our hand: `bs58@6` (ESM-only since v6) and `@areal/sdk` (`"type": "module"` end-to-end). Going CommonJS would have meant pinning both back, which is a non-starter given the SDK is the source of truth for IDLs and program IDs. The TypeORM CLI is invoked via `node --loader ts-node/esm` (see the `migration:*` scripts in `package.json`); decorators work fine under ESM provided `reflect-metadata` is imported once at `main.ts` and `data-source.ts`.
- **One process holds everything.** Listener + worker + REST + metrics in one Node process for Phase 12.1. When we split (likely Phase 12.3 once Socket.IO lands) the worker container will pull from the same Bull queue.
- **No projections yet.** The `events` table is the only ingest target. Phases 12.2 / 12.3 introduce per-feature projection tables (transactions, pool_snapshots, leaderboards, etc.) populated by per-event handlers reading from `events`.
- **Redis is unauthenticated in dev.** `docker-compose.yml` runs Redis without `requirepass` — fine for localhost. The prod template adds `--requirepass`.
