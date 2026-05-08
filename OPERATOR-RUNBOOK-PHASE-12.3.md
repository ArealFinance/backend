# Operator Runbook — Phase 12.3.1

Markets aggregates + Socket.IO realtime substrate.

## What landed

- **3 new tables** in `areal` schema:
  - `pool_snapshots` (60s cadence, append-only)
  - `daily_pool_aggregates` (5min cadence, UPSERT per `(pool, day)`)
  - `protocol_summary` (singleton, 30s cadence, UPDATE in place)
- **3 cron jobs** registered as Bull repeatables on the
  `markets-aggregator` queue — `pg_try_advisory_xact_lock` makes them
  multi-replica safe.
- **3 REST endpoints** under `/markets`:
  - `GET /markets/pools/:pool/snapshots`
  - `GET /markets/pools/:pool/aggregate?days=N`
  - `GET /markets/summary`
- **Socket.IO gateway** on `/realtime` namespace with Redis adapter.

## Migration 0005

Run AFTER deploy, BEFORE traffic ramp:

```bash
npm run migration:run
```

Verifies:
- `areal.pool_snapshots`, `areal.daily_pool_aggregates`,
  `areal.protocol_summary` tables exist.
- `protocol_summary` contains exactly one row with `id='singleton'`:
  ```sql
  SELECT count(*), id FROM areal.protocol_summary GROUP BY id;
  -- expect: (1, 'singleton')
  ```
- The CHECK constraint rejects a second insert (defensive):
  ```sql
  INSERT INTO areal.protocol_summary (id) VALUES ('not-singleton');
  -- expect: ERROR: new row for relation "protocol_summary" violates check constraint
  ```

Rollback (if needed):
```bash
npm run migration:revert
```

## Bull repeatable verification

Within 60 seconds of process start, the bootstrap registers three
repeatables. Verify with `redis-cli`:

```bash
# Should be ≥ 1 (first scheduled run)
redis-cli zcard bull:markets-aggregator:delayed

# Repeatable definitions (should be 3)
redis-cli zrange bull:markets-aggregator:repeat 0 -1
```

If any are missing:
1. Check process logs for `markets-aggregator repeatables registered (60s / 5min / 30s)`.
2. Ensure the process has `BullModule` configured with the same Redis URL
   the verification command points to.
3. Check `MarketsAggregatorBootstrap.onModuleInit` did not throw — the
   try/catch in Nest's lifecycle log surfaces it as a hard ERROR.

## Socket.IO smoke test

From a browser DevTools console (any allowed origin):

```js
const s = io('wss://api.areal.finance/realtime', {
  transports: ['websocket'],
});
s.on('connect', () => {
  console.log('connected', s.id);
  s.emit('subscribe', { room: 'protocol' }, console.log);
});
s.on('protocol_summary_tick', (p) => console.log('tick', p));
```

Expected: a `protocol_summary_tick` payload arrives within 30 seconds
(the cron cadence).

For the `wallet:*` private-room path, attach a JWT via either the
`Authorization` header (browser-side requires custom transports) OR the
`auth.token` body field:

```js
const s = io('wss://api.areal.finance/realtime', {
  transports: ['websocket'],
  auth: { token: 'eyJ...' },
});
s.emit('subscribe', { room: 'wallet:<your-base58>' }, console.log);
// expect: { ok: true } if jwt.sub === <your-base58>
```

## Prometheus metrics

New metrics scraped on the existing `/metrics` listener
(`http://127.0.0.1:9201/metrics`):

| Metric                              | Type      | Labels        |
| ----------------------------------- | --------- | ------------- |
| `aggregator_latency_seconds`        | Histogram | `job`         |
| `aggregator_skip_total`             | Counter   | `job`         |
| `aggregator_rpc_failures_total`     | Counter   | `job`         |
| `realtime_connections_total`        | Counter   | —             |
| `realtime_emits_total`              | Counter   | `channel`     |
| `realtime_subscriptions_total`      | Counter   | `room_type`, `outcome` |
| `realtime_handshake_rejected_total` | Counter   | `reason`      |

Verification:
```bash
curl -s http://127.0.0.1:9201/metrics | grep -E '^(aggregator|realtime)_'
```

## Realtime handshake throttle (R-12.3.1-6)

Per-IP rate-limit on the Socket.IO handshake hot path. Defends the JWT
HMAC-verify against bogus-token connection floods. The cap is a sliding
window in Redis; rejections happen BEFORE `jwt.verifyAsync`, so an attacker
can't burn CPU by holding many invalid sockets open.

Defaults: **20 connect attempts / 60s rolling window per IP**. Override at
process start via:

```bash
REALTIME_HANDSHAKE_RATE_LIMIT_COUNT=40
REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC=60
```

Tuning guidance:
- A legitimate UI client opens ~1 socket per tab; Socket.IO reconnect backs
  off to 5s, so even a flapping link stays well below 20/min. If you see
  sustained `realtime_handshake_rejected_total{reason="rate_limit"}` on a
  legitimate origin, raise `_COUNT` rather than disabling the throttle.
- A `redis_error` rate above zero means the Redis client driving the
  counter is unhealthy — connections are still admitted (fail-open), but
  the throttle is effectively disabled while the error rate is high. Page
  the Redis owner.

Monitor: `realtime_handshake_rejected_total` rate. The Alertmanager rule
below fires on sustained rejections (production = real attack, dev = a
local script gone wrong).

## Alert rules (Prometheus)

Add to the existing rule file (`prometheus/alerts.yml` or equivalent):

```yaml
groups:
  - name: areal_aggregator
    rules:
      - alert: AggregatorSnapshotSlow
        # p95 latency for the 60s cron > 30s — the next tick will starve
        # and the realtime emit cadence drifts away from "every 60 seconds".
        expr: histogram_quantile(
                0.95,
                sum by (le) (
                  rate(aggregator_latency_seconds_bucket{job="snapshot60s"}[5m])
                )
              ) > 30
        for: 10m
        labels:
          severity: warning
          team: ops
        annotations:
          summary: "snapshot60s p95 latency > 30s"
          description: "Aggregator snapshot cron is slow; realtime emits will drift."

      - alert: BullMarketsAggregatorBacklog
        # > 5 waiting jobs on the markets-aggregator queue means the
        # consumer cannot keep up with the cron cadence. Diagnose via
        # `bull:markets-aggregator:wait` set in Redis.
        expr: bull_queue_waiting{queue="markets-aggregator"} > 5
        for: 5m
        labels:
          severity: warning
          team: ops
        annotations:
          summary: "markets-aggregator queue backlog > 5"

      - alert: AggregatorRpcFailures
        # Sustained RPC failures — the chain reader is unreachable;
        # snapshot60s will skip after 3 consecutive failures.
        expr: rate(aggregator_rpc_failures_total[5m]) > 0
        for: 10m
        labels:
          severity: warning
          team: ops
        annotations:
          summary: "aggregator RPC failures sustained"

  - name: areal_realtime
    rules:
      - alert: RealtimeHandshakeRejectionsSustained
        # Sustained per-IP throttle rejections. Above ~0.5 rejects/sec on
        # a public-facing edge usually means either a misbehaving client
        # (Socket.IO reconnect storm) or an actual connect-flood attempt.
        # Investigate via the gateway logs (`handshake rejected: ip=...`).
        expr: sum(rate(realtime_handshake_rejected_total{reason="rate_limit"}[5m])) > 0.5
        for: 10m
        labels:
          severity: warning
          team: ops
        annotations:
          summary: "realtime handshake rejections sustained > 0.5/s"
          description: "Per-IP throttle is rejecting handshakes for >10m. Inspect logs for offending IPs."

      - alert: RealtimeHandshakeThrottleRedisError
        # Counter for the fail-open path: Redis is unreachable so the
        # throttle is silently bypassed. Connections still flow but the
        # anti-DoS gate is effectively off — page the Redis owner.
        expr: sum(rate(realtime_handshake_rejected_total{reason="redis_error"}[5m])) > 0
        for: 5m
        labels:
          severity: warning
          team: ops
        annotations:
          summary: "handshake-throttle Redis errors sustained"
          description: "Throttle is failing open. Anti-DoS gate effectively disabled."
```

## Operational checklist

Post-deploy (10 gates — all must be GREEN before traffic ramp):
- [ ] **1. `migration:run` succeeded** — `0005-markets-aggregates` applied;
      `SELECT * FROM areal.protocol_summary` returns exactly one row with
      `id='singleton'`.
- [ ] **2. Bull repeatables visible in Redis (3 entries)** —
      `redis-cli zcard bull:markets-aggregator:repeat = 3`.
- [ ] **3. First `pool_snapshots` row appears within 60s** of process start.
- [ ] **4. First `daily_pool_aggregates` row appears within 5min** (only if
      there is `transactions` activity in the window).
- [ ] **5. `protocol_summary.updated_at` advances every ~30s** (poll twice
      with a >30s gap; timestamps must differ).
- [ ] **6. `/realtime` namespace reachable from staging app origin** — JS
      smoke from `https://app.areal.finance` DevTools console connects
      without CORS error.
- [ ] **7. Realtime auth gate behaves per spec** — anonymous `subscribe`
      to `protocol` returns `{ ok: true }`; anonymous `subscribe` to
      `wallet:<X>` returns `{ ok: false, error: 'auth_required' }`;
      JWT-authed `subscribe` to `wallet:<jwt.sub>` returns `{ ok: true }`;
      JWT-authed `subscribe` to a different `wallet:<other>` returns
      `{ ok: false, error: 'auth_mismatch' }`.
- [ ] **8. All new Prometheus metrics present** —
      `curl -s http://127.0.0.1:9201/metrics | grep -E '^(aggregator|realtime)_'`
      shows the six new series.
- [ ] **9. Multi-replica safety verified** — a second backend replica
      against the same Postgres + Redis runs cleanly; within 5 min the
      `aggregator_skip_total` counter is non-zero on at least one of the
      two processes (proving the advisory-lock skip path fires).
- [ ] **10. Alert rules loaded + green on the Alertmanager dashboard** —
      `AggregatorSnapshotSlow`, `BullMarketsAggregatorBacklog`,
      `AggregatorRpcFailures` all in `Inactive` state with no firing
      events.

Rollback:
1. `migration:revert` (drops the 3 tables; Bull repeatables remain harmless
   in Redis — the consumer is removed from DI so they never fire).
2. Redeploy previous artifact.
3. Optionally clean Bull repeatables:
   ```bash
   redis-cli del bull:markets-aggregator:repeat bull:markets-aggregator:delayed
   ```
