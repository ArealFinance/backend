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

Verification:
```bash
curl -s http://127.0.0.1:9201/metrics | grep -E '^(aggregator|realtime)_'
```

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
```

## Operational checklist

Post-deploy:
- [ ] `migration:run` succeeded
- [ ] Bull repeatables visible in Redis (3 entries)
- [ ] First `pool_snapshots` row appears within 60s
- [ ] First `daily_pool_aggregates` row appears within 5min (only if there
      is `transactions` activity in the window)
- [ ] `protocol_summary.updated_at` advances every ~30s
- [ ] `/realtime` namespace reachable from staging app origin
- [ ] All new Prometheus metrics present
- [ ] Alert rules loaded + green on the Alertmanager dashboard

Rollback:
1. `migration:revert` (drops the 3 tables; Bull repeatables remain harmless
   in Redis — the consumer is removed from DI so they never fire).
2. Redeploy previous artifact.
3. Optionally clean Bull repeatables:
   ```bash
   redis-cli del bull:markets-aggregator:repeat bull:markets-aggregator:delayed
   ```
