# Realtime Protocol — `/realtime` Socket.IO namespace

**Phase 12.3.1 — backend ↔ SDK contract — FROZEN 2026-05-08**

This document is the single source of truth for the `/realtime` Socket.IO
gateway exposed by `@areal/backend`. The Phase 12.3.2 SDK implementer
reads this file as the contract for `@areal/sdk/realtime`.

**Status:** **FROZEN as of 2026-05-08** (commit pinning Phase 12.3.1 deploy
to api.areal.finance via bootstrap-fornex.sh + 7 migrations applied + 8
Prometheus metrics live). Any breaking change here requires either a new
namespace (`/realtime-v2`) or a coordinated SDK + backend release with a
feature flag (per the «Versioning» section below). Additive changes (new
emit channels, new room types) remain non-breaking.

## Transport

- **Protocol**: Socket.IO 4.x
- **Namespace**: `/realtime`
- **URL example**: `wss://api.areal.finance/realtime`
- **CORS allow-list** (server-pinned, mirrored from REST allow-list):
  - `https://app.areal.finance`
  - `https://panel.areal.finance`
  - `http://localhost:5173`
  - `http://localhost:5174`
- **Transports**: server only enables `['websocket']`. Long-poll fallback
  is intentionally disabled — Socket.IO long-poll requires sticky sessions
  on a multi-replica deployment, and the WebSocket handshake is reachable
  through Cloudflared without session affinity.
- **Multi-node fan-out**: server uses `@socket.io/redis-adapter` so emits
  on one replica reach sockets connected to any other replica via Redis
  pub/sub.

## Handshake & authentication

A JWT is OPTIONAL at handshake. The server attempts extraction from two
sources, **header wins over body**:

1. `Authorization: Bearer <jwt>` HTTP header (preferred — same shape as REST).
2. `auth.token` field on the Socket.IO handshake body
   (`io(url, { auth: { token } })`).

A missing or invalid JWT results in an **anonymous** connection — the
socket is still established. Anonymous sockets can subscribe to public
rooms (`protocol`, `pool:<base58>`); they are rejected from private rooms
(`wallet:<base58>`).

The JWT's `sub` claim must be a base58 wallet pubkey. The server attaches
it to `socket.data.wallet` and uses it for the `wallet:*` room auth check.

### SDK example (browser)

```ts
import { io } from 'socket.io-client';

const socket = io('wss://api.areal.finance/realtime', {
  transports: ['websocket'],
  auth: { token: localStorage.getItem('accessToken') },
});

socket.on('connect', () => {
  socket.emit('subscribe', { room: 'protocol' }, (ack) => {
    if (!ack.ok) console.error('subscribe failed', ack.error);
  });
});
```

## Client → server messages

### `subscribe`

Join a room. The server validates the room name (single source of truth
in `src/modules/realtime/rooms.ts`) and applies auth gating:

| Room shape          | Auth requirement                         |
| ------------------- | ---------------------------------------- |
| `protocol`          | Public — anonymous OK                    |
| `pool:<base58>`     | Public — anonymous OK                    |
| `wallet:<base58>`   | JWT required AND `jwt.sub === <base58>` |

**Request**:
```json
{ "room": "wallet:DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK" }
```

**Ack** (success):
```json
{ "ok": true }
```

**Ack** (failure):
```json
{ "ok": false, "error": "auth_required" }   // anonymous + private room
{ "ok": false, "error": "auth_mismatch" }   // JWT.sub != room pubkey
{ "ok": false, "error": "unknown_room" }    // malformed / unknown shape
```

`subscribe` is **idempotent** — re-joining the same room is a no-op.

### `unsubscribe`

Leave a room. Symmetrical to `subscribe`; same validation, no auth check.
Leaving a room you're not in is also a no-op at the adapter level.

```json
{ "room": "pool:DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK" }
```

## Server → client emits

Three channels. Numeric precision: u64 fields are decimal **strings**
(lossless past 2^53); USD-denominated fields are JS **numbers** (always
fit comfortably below 2^53). Pubkeys are base58 strings.

### `pool_snapshot` — emitted to `pool:<base58>`

Per-pool state snapshot, ~60s cadence, fired by the
`MarketsAggregatorService.snapshotPools60s` cron AFTER the row commits.

```json
{
  "pool": "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK",
  "blockTime": 1714780800,
  "tvlA": "1500000000000",
  "tvlB": "2500000000000",
  "tvlUsd": 4250.75,
  "reserveA": "1500000000000",
  "reserveB": "2500000000000",
  "feeGrowthA": "987654321000000",
  "feeGrowthB": "987654321000000",
  "lpSupply": "1936491673000"
}
```

Field semantics:
- `pool` — pool PDA (base58).
- `blockTime` — unix seconds, set by the cron (best-effort wall clock).
- `tvlA` / `tvlB` — same as `reserveA` / `reserveB` for now (per-side TVL
  in token base units, lossless decimal strings).
- `tvlUsd` — USDC-denominated TVL. `null` when neither side priceable.
- `reserveA` / `reserveB` — on-chain reserves at snapshot time.
- `feeGrowthA` / `feeGrowthB` — `cumulativeFeesPerShare{A,B}`, q64.64
  fixed-point accumulators stringified as decimals.
- `lpSupply` — `totalLpShares`.

### `protocol_summary_tick` — emitted to `protocol`

Protocol-wide summary, ~30s cadence, fired by
`MarketsAggregatorService.writeProtocolSummary30s` AFTER the singleton
UPDATE commits.

```json
{
  "totalTvlUsd": 12345678.42,
  "volume24hUsd": 9876543.21,
  "txCount24h": 1532,
  "activeWallets24h": 287,
  "poolCount": 12,
  "cumulativeDistributorCount": 8,
  "blockTime": 1714780800
}
```

### `transaction_indexed` — emitted to `wallet:<base58>`

Per-wallet transaction notification, fired by `IndexerConsumer` AFTER
the wrapping persist+project transaction commits. **Never** emitted
inside the transaction — a rollback can't leak a transient notification.

```json
{
  "wallet": "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK",
  "kind": "swap",
  "signature": "5fJk...",
  "blockTime": 1714780800
}
```

`kind` is one of:
`'claim' | 'swap' | 'add_lp' | 'remove_lp' | 'zap_lp' | 'mint_rwt'`.
`RevenueDistributed` is wallet-less (fans out across N OT-holders inside
one instruction) and does NOT emit a `transaction_indexed` — per-wallet
visibility surfaces via the corresponding `RewardsClaimed` events on
subsequent claims.

## Reconnect / retry recommendations

Socket.IO's default reconnection policy is sane (exponential backoff
starting at 1s, ramping to 5s, with jitter). Recommended client settings:

```ts
const socket = io(url, {
  transports: ['websocket'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

After a successful reconnect, the client MUST re-issue any `subscribe`
calls — Socket.IO does NOT persist room membership across the underlying
connection. The SDK should track current subscriptions in-memory and
replay them on the `connect` event.

For graceful degradation: if the WS connection has been disconnected for
> 30 seconds, the client should also re-fetch the relevant REST endpoints
(`/markets/summary`, `/markets/pools/:pool/snapshots?limit=1`) to backfill
the gap. The realtime stream is an optimisation, NOT the source of truth —
all state can be reconstructed from the REST aggregate tables.

## Companion REST surface (`/markets/*`)

The realtime channel is paired with three public REST endpoints that the
SDK 12.3.2 implementer MUST consume for backfill / initial render. The
endpoints are derived from the same aggregate tables emitted on the
realtime channels.

### Pagination contract

`/markets/pools/:pool/snapshots` uses **time-window pagination**, NOT
opaque cursor pagination (the `/transactions` endpoint from Phase 12.2
uses cursors; snapshots intentionally diverge — see Phase 12.3.1
Decision #5 in the integration plan). Rationale: snapshots are an
equidistant 60s time-series; UIs naturally want time-range queries
("last 24h", "last 7d"), not next-N-after-signature.

| Endpoint | Query params | Default | Cap |
|----------|--------------|---------|-----|
| `GET /markets/pools/:pool/snapshots` | `from` (unix seconds, inclusive), `to` (unix seconds, inclusive), `limit` | `limit=100` | `limit ∈ [1, 200]`; absent `from`/`to` returns the most recent `limit` rows |
| `GET /markets/pools/:pool/aggregate` | `days` | `days=7` | `days ∈ [1, 90]` |
| `GET /markets/summary` | — | — | — (singleton row) |

### Response shapes

- `GET /markets/pools/:pool/snapshots` → `{ items: SnapshotRow[] }` ordered
  by `block_time DESC`. Note: `block_time` is the cron's wall-clock at
  job execution, NOT a Solana slot timestamp — adequate for charting,
  not for on-chain reconciliation.
- `GET /markets/pools/:pool/aggregate` → `{ items: DailyAggregate[] }`
  ordered by `day ASC`. `apy_24h` is a USD-derived ratio (1.0 = 100%)
  computed from the latest `pool_snapshots` row's captured prices /
  decimals via the 5min rollup. `null` when prices are unresolvable
  (no priceable pool for one or both sides) OR when `tvl_usd` is null
  / non-positive. Capped at `1000` (i.e. 100,000%) to defend dashboards
  from fee-spike-on-tiny-TVL outliers.
- `GET /markets/summary` → `ProtocolSummary` (single object). Returns 404
  if the singleton row is somehow missing (should be impossible after
  migration `0005`).

All three endpoints are **public-read** (no JWT). They are rate-limited by
the global Throttler envelope (60 req/min/IP). The SDK client should NOT
attach `Authorization` headers — surface remains anonymous-callable.

## Versioning

The `/realtime` namespace is currently un-versioned. Breaking changes
(new required field, removed field, renamed channel) require either:
1. A new namespace (`/realtime-v2`), OR
2. A coordinated SDK + backend release with a feature flag.

Adding a new emit channel or a new room type is non-breaking — clients
that don't subscribe simply don't receive it.
