import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { getMarketsSnapshot } from '@areal/sdk/markets';
import {
  NATIVE_DEX_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  type ClusterName,
} from '@areal/sdk/network';
import { Connection } from '@solana/web3.js';
import { DataSource, Repository } from 'typeorm';

import { DailyPoolAggregate } from '../../entities/daily-pool-aggregate.entity.js';
import { PoolSnapshot } from '../../entities/pool-snapshot.entity.js';
import { ProtocolSummary } from '../../entities/protocol-summary.entity.js';
import { Transaction } from '../../entities/transaction.entity.js';
import { SOLANA_CONNECTION } from '../indexer/connection.provider.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/**
 * Postgres advisory-lock IDs for the three aggregator jobs.
 *
 * The locks are session-level via `pg_try_advisory_xact_lock` — held only
 * for the lifetime of the wrapping transaction. Two replicas hitting the
 * same job at the same minute will see one acquire the lock and run, the
 * other return false from `pg_try_advisory_xact_lock` and skip silently
 * (incrementing `aggregator_skip_total`).
 *
 * Magic numbers chosen at random within the bigint advisory-lock space —
 * never reuse across unrelated locks. The 0x12303001 prefix encodes the
 * phase (1230 = Phase 12.3) for a small mnemonic at trace-time.
 */
export const JOB_LOCK_IDS = {
  snapshot60s: 0x12303001n,
  rollup5m: 0x12303002n,
  summary30s: 0x12303003n,
} as const;

const RPC_FAILURE_THRESHOLD = 3;

interface AggregatorState {
  /**
   * Per-pool RPC failure counter. The 60s snapshot job increments on
   * `getMarketsSnapshot` throwing and resets on success. We skip the
   * pool emit for `RPC_FAILURE_THRESHOLD` consecutive failures so a
   * dead RPC doesn't surface as a blank chart.
   */
  rpcFailures: number;
}

/**
 * Markets aggregator (Phase 12.3.1).
 *
 * Three idempotent cron jobs:
 *   - `snapshotPools60s` — read on-chain pool state via SDK markets reader
 *     and append a `pool_snapshots` row per pool (60s cadence).
 *   - `rollupDailyAggregates5m` — UPSERT today's UTC day in
 *     `daily_pool_aggregates` from the last 24h of `transactions` (5min cadence).
 *   - `writeProtocolSummary30s` — UPDATE the singleton `protocol_summary`
 *     row from latest pool snapshots + 24h transaction aggregate (30s cadence).
 *
 * All three are guarded by `pg_try_advisory_xact_lock`; multiple replicas
 * are safe to run side-by-side. Each job emits a Prometheus latency
 * histogram and increments `aggregator_skip_total` on lock contention.
 *
 * Why a single service instead of one per job: the RPC failure counter
 * lives at the service level (per-process state), and centralising the
 * advisory-lock pattern keeps the divergence cost low.
 */
@Injectable()
export class MarketsAggregatorService {
  private readonly logger = new Logger(MarketsAggregatorService.name);
  private readonly state: AggregatorState = { rpcFailures: 0 };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PoolSnapshot)
    private readonly snapshots: Repository<PoolSnapshot>,
    @InjectRepository(DailyPoolAggregate)
    private readonly aggregates: Repository<DailyPoolAggregate>,
    @InjectRepository(ProtocolSummary)
    private readonly summary: Repository<ProtocolSummary>,
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 60-second cadence: read every pool from chain and append a snapshot row.
   *
   * Re-running at the same wall-clock minute is safe — `(pool, block_time)`
   * is not unique by design, the index just makes "latest" lookups O(log n).
   * Two replicas overlapping inserts a duplicate row at most; the writer for
   * the next minute happily appends without conflict.
   */
  async snapshotPools60s(): Promise<void> {
    const stop = this.metrics.aggregatorLatency.startTimer({ job: 'snapshot60s' });
    try {
      await this.runWithLock('snapshot60s', JOB_LOCK_IDS.snapshot60s, async (manager) => {
        let snapshot;
        try {
          snapshot = await getMarketsSnapshot(this.conn, this.cluster(), {
            nativeDexProgramId: NATIVE_DEX_PROGRAM_ID,
            ownershipTokenProgramId: OWNERSHIP_TOKEN_PROGRAM_ID,
            rwtEngineProgramId: RWT_ENGINE_PROGRAM_ID,
            includeNav: false, // 60s cadence — NAV doesn't drift fast enough
          });
          this.state.rpcFailures = 0;
        } catch (err) {
          this.state.rpcFailures += 1;
          this.metrics.aggregatorRpcFailures.inc({ job: 'snapshot60s' });
          this.logger.warn(
            `snapshot60s RPC failed (#${this.state.rpcFailures}): ${err instanceof Error ? err.message : String(err)}`,
          );
          if (this.state.rpcFailures >= RPC_FAILURE_THRESHOLD) {
            this.logger.error(
              `snapshot60s skipping — ${RPC_FAILURE_THRESHOLD} consecutive RPC failures`,
            );
          }
          return;
        }

        // The block_time we surface here is the slot wall clock (best-effort).
        // The SDK doesn't roundtrip a block_time alongside the snapshot, so we
        // use the cron's own clock — alright at 60s granularity.
        const nowSec = Math.floor(Date.now() / 1000);

        for (const pool of snapshot.pools) {
          const poolKey = pool.poolAddress.toBase58();
          const row: Partial<PoolSnapshot> = {
            pool: poolKey,
            blockTime: String(nowSec),
            tvlA: pool.reserveA.toString(),
            tvlB: pool.reserveB.toString(),
            tvlUsd: pool.tvlUsdc === null ? null : pool.tvlUsdc.toString(),
            reserveA: pool.reserveA.toString(),
            reserveB: pool.reserveB.toString(),
            feeGrowthA: pool.rawPool.cumulativeFeesPerShareA.toString(),
            feeGrowthB: pool.rawPool.cumulativeFeesPerShareB.toString(),
            lpSupply: pool.rawPool.totalLpShares.toString(),
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await manager.getRepository(PoolSnapshot).insert(row as any);

          // Emit AFTER successful insert so a downstream client can't see a
          // tick that doesn't have a corresponding row in the snapshots table.
          this.realtime.emitPoolSnapshot({
            pool: poolKey,
            blockTime: nowSec,
            tvlA: pool.reserveA.toString(),
            tvlB: pool.reserveB.toString(),
            tvlUsd: pool.tvlUsdc,
            reserveA: pool.reserveA.toString(),
            reserveB: pool.reserveB.toString(),
            feeGrowthA: pool.rawPool.cumulativeFeesPerShareA.toString(),
            feeGrowthB: pool.rawPool.cumulativeFeesPerShareB.toString(),
            lpSupply: pool.rawPool.totalLpShares.toString(),
          });
        }
      });
    } finally {
      stop();
    }
  }

  /**
   * 5-minute cadence: roll up the trailing 24h into per-(pool, day) UPSERT
   * rows. Volume / fees come from `transactions` of kind='swap'; tx_count
   * from any kind; unique_wallets from `COUNT(DISTINCT wallet)`.
   *
   * Idempotency: `(pool, day) UNIQUE` + `ON CONFLICT DO UPDATE`.
   */
  async rollupDailyAggregates5m(): Promise<void> {
    const stop = this.metrics.aggregatorLatency.startTimer({ job: 'rollup5m' });
    try {
      await this.runWithLock('rollup5m', JOB_LOCK_IDS.rollup5m, async (manager) => {
        // The aggregate window is "today's UTC bucket" — a fixed string
        // computed once so the upsert and the WHERE clause use exactly
        // the same value (defensive against UTC midnight crossings).
        const today = new Date();
        const utcDay = today.toISOString().slice(0, 10); // YYYY-MM-DD
        const since = new Date(today.getTime() - 24 * 60 * 60 * 1000);

        // Distinct pools that have activity in the window. Two-stage to keep
        // each query simple; a JOIN in one shot would also work but the EXPLAIN
        // is harder to read.
        const poolsRaw: Array<{ pool: string }> = await manager
          .getRepository(Transaction)
          .createQueryBuilder('t')
          .select('DISTINCT t.pool', 'pool')
          .where('t.pool IS NOT NULL')
          .andWhere('t.block_time >= :since', { since })
          .getRawMany();

        for (const { pool } of poolsRaw) {
          if (!pool) continue;
          const stats: {
            volume_a: string | null;
            volume_b: string | null;
            tx_count: string | null;
            wallets: string | null;
          } = (await manager
            .getRepository(Transaction)
            .createQueryBuilder('t')
            .select(
              `COALESCE(SUM(CASE WHEN t.kind = 'swap' THEN t.amount_a ELSE 0 END), 0)`,
              'volume_a',
            )
            .addSelect(
              `COALESCE(SUM(CASE WHEN t.kind = 'swap' THEN t.amount_b ELSE 0 END), 0)`,
              'volume_b',
            )
            .addSelect('COUNT(*)', 'tx_count')
            .addSelect('COUNT(DISTINCT t.wallet)', 'wallets')
            .where('t.pool = :pool', { pool })
            .andWhere('t.block_time >= :since', { since })
            .getRawOne()) ?? {
            volume_a: '0',
            volume_b: '0',
            tx_count: '0',
            wallets: '0',
          };

          // INSERT … ON CONFLICT DO UPDATE — TypeORM's `.upsert()` also works
          // but emits a verbose UPDATE clause. Raw SQL keeps the intent obvious.
          await manager.query(
            `INSERT INTO "areal"."daily_pool_aggregates"
              ("pool", "day", "volume_a_24h", "volume_b_24h", "fees_a_24h", "fees_b_24h",
               "tx_count_24h", "unique_wallets_24h", "apy_24h", "updated_at")
            VALUES ($1, $2, $3, $4, 0, 0, $5, $6, NULL, now())
            ON CONFLICT ("pool", "day") DO UPDATE SET
              "volume_a_24h" = EXCLUDED."volume_a_24h",
              "volume_b_24h" = EXCLUDED."volume_b_24h",
              "tx_count_24h" = EXCLUDED."tx_count_24h",
              "unique_wallets_24h" = EXCLUDED."unique_wallets_24h",
              "updated_at" = now()`,
            [
              pool,
              utcDay,
              stats.volume_a ?? '0',
              stats.volume_b ?? '0',
              parseInt(stats.tx_count ?? '0', 10),
              parseInt(stats.wallets ?? '0', 10),
            ],
          );
        }
      });
    } finally {
      stop();
    }
  }

  /**
   * 30-second cadence: refresh the singleton `protocol_summary` row.
   *
   * The migration seeds a row on `up()`, so this is always an UPDATE
   * (no INSERT branch). If a caller drops + recreates the table without
   * re-running the migration the UPDATE silently no-ops; surface that
   * as a 404 from `MarketsService.getSummary` so ops sees a hard signal.
   */
  async writeProtocolSummary30s(): Promise<void> {
    const stop = this.metrics.aggregatorLatency.startTimer({ job: 'summary30s' });
    try {
      await this.runWithLock('summary30s', JOB_LOCK_IDS.summary30s, async (manager) => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // TVL: sum of latest snapshot per pool. We use a window function so
        // two snapshots at the same `block_time` only contribute once (the
        // index ordering picks deterministically).
        const tvlRow: { total_tvl_usd: string | null } = (
          await manager.query(
            `WITH latest AS (
              SELECT DISTINCT ON ("pool") "tvl_usd"
              FROM "areal"."pool_snapshots"
              ORDER BY "pool", "block_time" DESC
            )
            SELECT COALESCE(SUM(tvl_usd), 0)::text AS total_tvl_usd FROM latest`,
          )
        )[0] ?? { total_tvl_usd: '0' };

        // 24h volume / tx_count / unique_wallets across all pools
        const txRow: {
          volume_usd: string | null;
          tx_count: string | null;
          wallets: string | null;
        } = (await manager
          .getRepository(Transaction)
          .createQueryBuilder('t')
          .select(
            `COALESCE(SUM(CASE WHEN t.kind = 'swap' THEN t.amount_a ELSE 0 END), 0)`,
            'volume_usd',
          )
          .addSelect('COUNT(*)', 'tx_count')
          .addSelect('COUNT(DISTINCT t.wallet)', 'wallets')
          .where('t.block_time >= :since', { since })
          .getRawOne()) ?? { volume_usd: '0', tx_count: '0', wallets: '0' };

        // pool_count + distributor_count = current chain state. Source of
        // truth differs from the 24h window — these are "how many exist now",
        // not "how many had activity". We approximate via the snapshots table
        // (DISTINCT pool) until a dedicated chain reader lands.
        const poolCountRow: { pool_count: string } = (
          await manager.query(
            `SELECT COUNT(DISTINCT "pool")::text AS pool_count FROM "areal"."pool_snapshots"`,
          )
        )[0] ?? { pool_count: '0' };
        const distributorCountRow: { distributor_count: string } = (
          await manager.query(
            `SELECT COUNT(DISTINCT "primary_actor")::text AS distributor_count
             FROM "areal"."events" WHERE "event_name" = 'RevenueDistributed'`,
          )
        )[0] ?? { distributor_count: '0' };

        const nowSec = Math.floor(Date.now() / 1000);
        await manager.query(
          `UPDATE "areal"."protocol_summary" SET
            "total_tvl_usd" = $1,
            "volume_24h_usd" = $2,
            "tx_count_24h" = $3,
            "active_wallets_24h" = $4,
            "pool_count" = $5,
            "distributor_count" = $6,
            "block_time" = $7,
            "updated_at" = now()
          WHERE "id" = 'singleton'`,
          [
            tvlRow.total_tvl_usd ?? '0',
            txRow.volume_usd ?? '0',
            parseInt(txRow.tx_count ?? '0', 10),
            parseInt(txRow.wallets ?? '0', 10),
            parseInt(poolCountRow.pool_count, 10),
            parseInt(distributorCountRow.distributor_count, 10),
            nowSec,
          ],
        );

        this.realtime.emitProtocolSummaryTick({
          totalTvlUsd: Number(tvlRow.total_tvl_usd ?? 0),
          volume24hUsd: Number(txRow.volume_usd ?? 0),
          txCount24h: parseInt(txRow.tx_count ?? '0', 10),
          activeWallets24h: parseInt(txRow.wallets ?? '0', 10),
          poolCount: parseInt(poolCountRow.pool_count, 10),
          distributorCount: parseInt(distributorCountRow.distributor_count, 10),
          blockTime: nowSec,
        });
      });
    } finally {
      stop();
    }
  }

  /**
   * Wraps the body in a single Postgres TX guarded by a session advisory
   * lock. Two replicas hitting the same job concurrently — one acquires
   * the lock and runs, the other no-ops + bumps the skip metric.
   *
   * Lock release: `pg_try_advisory_xact_lock` releases automatically at
   * COMMIT/ROLLBACK, so a wedged worker's lock evaporates with its TX.
   */
  private async runWithLock(
    job: keyof typeof JOB_LOCK_IDS,
    lockId: bigint,
    body: (manager: import('typeorm').EntityManager) => Promise<void>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lockResult: Array<{ locked: boolean }> = await manager.query(
        // Cast at the parameter site so node-postgres binds bigint strings
        // as `bigint` rather than the default `text` (Postgres advisory-lock
        // overloads are bigint, not text).
        `SELECT pg_try_advisory_xact_lock($1::bigint) AS locked`,
        [lockId.toString()],
      );
      const locked = lockResult[0]?.locked ?? false;
      if (!locked) {
        this.metrics.aggregatorSkipTotal.inc({ job });
        this.logger.debug(`${job}: advisory lock held by another worker, skipping`);
        return;
      }
      await body(manager);
    });
  }

  private cluster(): ClusterName {
    return (this.config.get<string>('solana.cluster') ?? 'devnet') as ClusterName;
  }
}
