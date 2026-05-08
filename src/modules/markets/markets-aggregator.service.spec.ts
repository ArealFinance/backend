import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
import { computeApy24h, MarketsAggregatorService } from './markets-aggregator.service.js';

/**
 * Aggregator unit tests. We mock the DataSource transaction wrapper, the
 * SDK markets reader (via vi.mock), the realtime emit, and just exercise
 * the lock + metric + retry behaviour.
 *
 * We share one MetricsService instance across the suite — prom-client's
 * default registry would otherwise reject duplicate registration on
 * re-instantiation.
 */

const SHARED_METRICS = new MetricsService();
SHARED_METRICS.onModuleInit();

vi.mock('@areal/sdk/markets', () => ({
  // Default mock — overridden per-test as needed.
  getMarketsSnapshot: vi.fn().mockResolvedValue({
    tokens: [],
    pools: [],
    rwtVault: null,
    fetchedAt: 0,
    slot: 0,
  }),
}));

import { getMarketsSnapshot } from '@areal/sdk/markets';

interface FakeManager {
  query: ReturnType<typeof vi.fn>;
  getRepository: ReturnType<typeof vi.fn>;
}

function makeFakeManager(
  opts: {
    lockResult?: boolean;
    insertedRows?: unknown[];
    rawMany?: unknown[];
    rawOne?: unknown;
    queryResults?: unknown[];
  } = {},
): FakeManager {
  const inserted = opts.insertedRows ?? [];
  const rawMany = opts.rawMany ?? [];
  const rawOne = opts.rawOne ?? {};
  const queryResults = opts.queryResults ?? [];
  let queryCallIdx = 0;

  const fakeRepo = {
    insert: vi.fn().mockImplementation(async (row: unknown) => {
      inserted.push(row);
    }),
    createQueryBuilder: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getRawMany: vi.fn().mockResolvedValue(rawMany),
      getRawOne: vi.fn().mockResolvedValue(rawOne),
    }),
  };

  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      // First query in `runWithLock` is the advisory lock probe. Surface
      // the configured outcome there; subsequent .query() calls cycle
      // through `queryResults` so writers can match each statement.
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return [{ locked: opts.lockResult ?? true }];
      }
      const idx = queryCallIdx++;
      const r = queryResults[idx];
      return r ?? [];
    }),
    getRepository: vi.fn().mockReturnValue(fakeRepo),
  };
}

function makeService(manager: FakeManager, opts: { realtimeEmit?: ReturnType<typeof vi.fn> } = {}) {
  const dataSource = {
    transaction: vi.fn().mockImplementation(async (cb: (m: FakeManager) => Promise<void>) => {
      await cb(manager);
    }),
  };
  const conn = {} as unknown;
  const config = {
    get: vi.fn().mockReturnValue('devnet'),
  };
  const realtime = {
    emitPoolSnapshot: opts.realtimeEmit ?? vi.fn(),
    emitProtocolSummaryTick: vi.fn(),
    emitTransactionIndexed: vi.fn(),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  return new MarketsAggregatorService(
    dataSource as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    conn as any,
    config as any,
    realtime as any,
    SHARED_METRICS,
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarketsAggregatorService', () => {
  describe('snapshotPools60s', () => {
    it('emits pool_snapshot per pool after a successful chain read', async () => {
      const fakePool = {
        poolAddress: { toBase58: () => 'POOL1111111111111111111111111111' },
        tokenAMint: { toBase58: () => 'MINTA111111111111111111111111111' },
        tokenBMint: { toBase58: () => 'MINTB111111111111111111111111111' },
        reserveA: 100n,
        reserveB: 200n,
        tvlUsdc: 42.5,
        rawPool: {
          cumulativeFeesPerShareA: 1n,
          cumulativeFeesPerShareB: 2n,
          totalLpShares: 1000n,
        },
      };
      vi.mocked(getMarketsSnapshot).mockResolvedValueOnce({
        tokens: [],
        pools: [fakePool],
        rwtVault: null,
        fetchedAt: 0,
        slot: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const emit = vi.fn();
      const manager = makeFakeManager({ lockResult: true });
      const svc = makeService(manager, { realtimeEmit: emit });
      await svc.snapshotPools60s();
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]![0]).toMatchObject({
        pool: 'POOL1111111111111111111111111111',
        tvlUsd: 42.5,
        reserveA: '100',
        reserveB: '200',
        feeGrowthA: '1',
        feeGrowthB: '2',
        lpSupply: '1000',
      });
    });

    it('persists per-token prices + decimals when tokens are in snapshot.tokens', async () => {
      const fakePool = {
        poolAddress: { toBase58: () => 'POOL1111111111111111111111111111' },
        tokenAMint: { toBase58: () => 'MINTA111111111111111111111111111' },
        tokenBMint: { toBase58: () => 'MINTB111111111111111111111111111' },
        reserveA: 100n,
        reserveB: 200n,
        tvlUsdc: 42.5,
        rawPool: {
          cumulativeFeesPerShareA: 1n,
          cumulativeFeesPerShareB: 2n,
          totalLpShares: 1000n,
        },
      };
      vi.mocked(getMarketsSnapshot).mockResolvedValueOnce({
        tokens: [
          {
            mint: { toBase58: () => 'MINTA111111111111111111111111111' },
            decimals: 9,
            priceUsdc: 1.25,
          },
          {
            mint: { toBase58: () => 'MINTB111111111111111111111111111' },
            decimals: 6,
            priceUsdc: 99.5,
          },
        ],
        pools: [fakePool],
        rwtVault: null,
        fetchedAt: 0,
        slot: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const insertedRows: unknown[] = [];
      const manager = makeFakeManager({ lockResult: true, insertedRows });
      const svc = makeService(manager);
      await svc.snapshotPools60s();
      // The PoolSnapshot row inserted into the repo carries the captured
      // per-token prices + decimals, ready for the rollup to consume.
      expect(insertedRows.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = insertedRows[0] as any;
      expect(row.priceAUsdc).toBe('1.25');
      expect(row.priceBUsdc).toBe('99.5');
      expect(row.decimalsA).toBe(9);
      expect(row.decimalsB).toBe(6);
    });

    it('persists NULL prices/decimals when a token is missing from snapshot.tokens', async () => {
      const fakePool = {
        poolAddress: { toBase58: () => 'POOL1111111111111111111111111111' },
        tokenAMint: { toBase58: () => 'MINTA111111111111111111111111111' },
        tokenBMint: { toBase58: () => 'MINTB111111111111111111111111111' },
        reserveA: 100n,
        reserveB: 200n,
        tvlUsdc: null,
        rawPool: {
          cumulativeFeesPerShareA: 1n,
          cumulativeFeesPerShareB: 2n,
          totalLpShares: 1000n,
        },
      };
      vi.mocked(getMarketsSnapshot).mockResolvedValueOnce({
        // tokens list is empty — both A and B should land as NULL.
        tokens: [],
        pools: [fakePool],
        rwtVault: null,
        fetchedAt: 0,
        slot: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const insertedRows: unknown[] = [];
      const manager = makeFakeManager({ lockResult: true, insertedRows });
      const svc = makeService(manager);
      await svc.snapshotPools60s();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = insertedRows[0] as any;
      expect(row.priceAUsdc).toBeNull();
      expect(row.priceBUsdc).toBeNull();
      expect(row.decimalsA).toBeNull();
      expect(row.decimalsB).toBeNull();
    });

    it('skips work when the advisory lock is held by another worker', async () => {
      const manager = makeFakeManager({ lockResult: false });
      const emit = vi.fn();
      const svc = makeService(manager, { realtimeEmit: emit });
      await svc.snapshotPools60s();
      // No SDK call when we couldn't take the lock.
      expect(getMarketsSnapshot).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      // Skip metric incremented for snapshot60s.
      const skipMetric = await SHARED_METRICS.aggregatorSkipTotal.get();
      const snapshotSkip = skipMetric.values.find((v) => v.labels.job === 'snapshot60s');
      expect(snapshotSkip).toBeTruthy();
      expect(snapshotSkip?.value ?? 0).toBeGreaterThan(0);
    });

    it('increments rpc-failure counter on chain read error and does not emit', async () => {
      vi.mocked(getMarketsSnapshot).mockRejectedValueOnce(new Error('rpc 500'));
      const manager = makeFakeManager({ lockResult: true });
      const emit = vi.fn();
      const svc = makeService(manager, { realtimeEmit: emit });
      await svc.snapshotPools60s();
      expect(emit).not.toHaveBeenCalled();
      const m = await SHARED_METRICS.aggregatorRpcFailures.get();
      const v = m.values.find((x) => x.labels.job === 'snapshot60s');
      expect(v?.value ?? 0).toBeGreaterThan(0);
    });

    it('records latency histogram on every run (lock acquired or not)', async () => {
      const before = await SHARED_METRICS.aggregatorLatency.get();
      const beforeCount =
        before.values.find(
          (v) =>
            v.metricName === 'aggregator_latency_seconds_count' && v.labels.job === 'snapshot60s',
        )?.value ?? 0;

      const manager = makeFakeManager({ lockResult: false });
      const svc = makeService(manager);
      await svc.snapshotPools60s();

      const after = await SHARED_METRICS.aggregatorLatency.get();
      const afterCount =
        after.values.find(
          (v) =>
            v.metricName === 'aggregator_latency_seconds_count' && v.labels.job === 'snapshot60s',
        )?.value ?? 0;

      expect(afterCount).toBeGreaterThan(beforeCount);
    });
  });

  describe('rollupDailyAggregates5m', () => {
    it('UPSERTs one row per distinct pool with activity in the window', async () => {
      const manager = makeFakeManager({
        lockResult: true,
        rawMany: [
          { pool: 'POOLAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
          { pool: 'POOLBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
        ],
        rawOne: { volume_a: '100', volume_b: '200', tx_count: '5', wallets: '3' },
      });
      const svc = makeService(manager);
      await svc.rollupDailyAggregates5m();
      // 1 advisory-lock query + 2 INSERT … ON CONFLICT queries (one per pool).
      const upsertCalls = manager.query.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' && c[0].includes('INSERT INTO "areal"."daily_pool_aggregates"'),
      );
      expect(upsertCalls.length).toBe(2);
    });

    it('produces NO writes when there is no activity in the window', async () => {
      const manager = makeFakeManager({
        lockResult: true,
        rawMany: [], // no distinct pools
      });
      const svc = makeService(manager);
      await svc.rollupDailyAggregates5m();
      const upsertCalls = manager.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO'),
      );
      expect(upsertCalls.length).toBe(0);
    });

    it('R-12.3.1-1: computes and binds apy_24h from the latest snapshot prices', async () => {
      // The rollup runs 3 query() calls per pool (after the lock):
      //   1. SELECT latest pool_snapshots row (price + decimals + tvl)
      //   2. SELECT existing fees_a_24h / fees_b_24h on the daily aggregate
      //   3. INSERT … ON CONFLICT DO UPDATE (the upsert)
      // We override `query` to route by SQL fingerprint and assert the apy
      // bound at the upsert is the formula's expected value.
      const lockResult = true;
      const fakeRepo = {
        insert: vi.fn(),
        createQueryBuilder: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          addSelect: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          andWhere: vi.fn().mockReturnThis(),
          getRawMany: vi.fn().mockResolvedValue([{ pool: 'POOLA' }]),
          getRawOne: vi
            .fn()
            .mockResolvedValue({ volume_a: '0', volume_b: '0', tx_count: '1', wallets: '1' }),
        }),
      };
      const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
      const fakeManager = {
        getRepository: vi.fn().mockReturnValue(fakeRepo),
        query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          queryCalls.push({ sql, params });
          if (sql.includes('pg_try_advisory_xact_lock')) {
            return [{ locked: lockResult }];
          }
          if (sql.includes('FROM "areal"."pool_snapshots"')) {
            // Return a latest-snapshot row with valid prices/decimals/tvl.
            return [
              {
                price_a_usdc: '2.0',
                price_b_usdc: '3.0',
                decimals_a: 9,
                decimals_b: 6,
                tvl_usd: '1000',
              },
            ];
          }
          if (
            sql.includes('FROM "areal"."daily_pool_aggregates"') &&
            !sql.includes('INSERT INTO')
          ) {
            // Existing fees row. We seed both sides so apy_24h is non-zero.
            return [{ fees_a_24h: '1000000000', fees_b_24h: '0' }];
          }
          // INSERT … ON CONFLICT ...
          return [];
        }),
      };
      const svc = makeService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeManager as any,
      );
      await svc.rollupDailyAggregates5m();

      // Find the UPSERT call and inspect the apy_24h param (last positional
      // before the timestamp — see the SQL in the service).
      const upsert = queryCalls.find(
        (c) => c.sql.includes('INSERT INTO "areal"."daily_pool_aggregates"'),
      );
      expect(upsert).toBeTruthy();
      // Param order matches the service: [pool, day, vA, vB, fA, fB, txCount, wallets, apy]
      const params = upsert!.params!;
      const apyParam = params[params.length - 1] as string | null;
      expect(apyParam).not.toBeNull();
      // 1e9 fees / 1e9 = 1 token A at $2 = $2 fees_usd. tvl=$1000.
      // apy = ($2 / $1000) * 365 = 0.73
      expect(Number(apyParam)).toBeCloseTo(0.73, 4);
    });

    it('R-12.3.1-1: leaves apy_24h NULL when latest snapshot has no prices', async () => {
      const fakeRepo = {
        insert: vi.fn(),
        createQueryBuilder: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          addSelect: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          andWhere: vi.fn().mockReturnThis(),
          getRawMany: vi.fn().mockResolvedValue([{ pool: 'POOLA' }]),
          getRawOne: vi
            .fn()
            .mockResolvedValue({ volume_a: '0', volume_b: '0', tx_count: '1', wallets: '1' }),
        }),
      };
      const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
      const fakeManager = {
        getRepository: vi.fn().mockReturnValue(fakeRepo),
        query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          queryCalls.push({ sql, params });
          if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked: true }];
          if (sql.includes('FROM "areal"."pool_snapshots"')) {
            // Snapshot exists but prices/decimals are NULL — historical
            // pre-0006 data, or a pool whose tokens aren't in the markets
            // reader's token list.
            return [
              {
                price_a_usdc: null,
                price_b_usdc: null,
                decimals_a: null,
                decimals_b: null,
                tvl_usd: null,
              },
            ];
          }
          if (
            sql.includes('FROM "areal"."daily_pool_aggregates"') &&
            !sql.includes('INSERT INTO')
          ) {
            return [{ fees_a_24h: '1000000000', fees_b_24h: '0' }];
          }
          return [];
        }),
      };
      const svc = makeService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeManager as any,
      );
      await svc.rollupDailyAggregates5m();

      const upsert = queryCalls.find(
        (c) => c.sql.includes('INSERT INTO "areal"."daily_pool_aggregates"'),
      );
      const params = upsert!.params!;
      const apyParam = params[params.length - 1];
      // All-or-nothing: any NULL input → apy_24h is NULL.
      expect(apyParam).toBeNull();
    });
  });

  describe('computeApy24h (R-12.3.1-1)', () => {
    // Pure-function tests against the helper. We exercise the all-or-nothing
    // input-null contract, the formula's correctness on known values, the
    // tvl_usd <= 0 guard, and the cap on outliers.

    it('returns null when ANY input is missing (all-or-nothing contract)', () => {
      const base = {
        feesA: '1000',
        feesB: '2000',
        priceAUsdc: '1.0',
        priceBUsdc: '50.0',
        decimalsA: 9,
        decimalsB: 6,
        tvlUsd: '10000',
      };
      // Each input nulled in turn → null result.
      expect(computeApy24h({ ...base, priceAUsdc: null })).toBeNull();
      expect(computeApy24h({ ...base, priceBUsdc: null })).toBeNull();
      expect(computeApy24h({ ...base, decimalsA: null })).toBeNull();
      expect(computeApy24h({ ...base, decimalsB: null })).toBeNull();
      expect(computeApy24h({ ...base, tvlUsd: null })).toBeNull();
    });

    it('returns null when tvl_usd <= 0', () => {
      const base = {
        feesA: '1000',
        feesB: '2000',
        priceAUsdc: '1.0',
        priceBUsdc: '50.0',
        decimalsA: 9,
        decimalsB: 6,
        tvlUsd: '0',
      };
      expect(computeApy24h(base)).toBeNull();
      expect(computeApy24h({ ...base, tvlUsd: '-1' })).toBeNull();
    });

    it('computes apy_24h correctly when all inputs are present', () => {
      // 1e9 fees on side A (9 decimals → 1.0 token) at $1 = $1.
      // 2e6 fees on side B (6 decimals → 2.0 tokens) at $50 = $100.
      // fees_usd_24h = $101. tvl_usd = $10,000.
      // apy_24h = ($101 / $10000) * 365 = 3.6865 (i.e. 368.65%).
      const result = computeApy24h({
        feesA: '1000000000',
        feesB: '2000000',
        priceAUsdc: '1.0',
        priceBUsdc: '50.0',
        decimalsA: 9,
        decimalsB: 6,
        tvlUsd: '10000',
      });
      expect(result).not.toBeNull();
      expect(Number(result)).toBeCloseTo(3.6865, 4);
    });

    it('caps the result at APY_24H_CAP_RATIO (1000) on outliers', () => {
      // $1000 fees / $1 TVL * 365 = 365,000. Cap at 1000.
      const result = computeApy24h({
        feesA: '1000000000', // 1.0 token at 9 decimals
        feesB: '0',
        priceAUsdc: '1000',
        priceBUsdc: '0',
        decimalsA: 9,
        decimalsB: 6,
        tvlUsd: '1',
      });
      expect(result).not.toBeNull();
      expect(Number(result)).toBe(1000);
    });

    it('returns 0 (not null) when fees are zero but inputs are otherwise valid', () => {
      // Fees=0 → fees_usd=0 → apy=0. Distinct from "missing input" → null.
      const result = computeApy24h({
        feesA: '0',
        feesB: '0',
        priceAUsdc: '1.0',
        priceBUsdc: '50.0',
        decimalsA: 9,
        decimalsB: 6,
        tvlUsd: '10000',
      });
      expect(result).not.toBeNull();
      expect(Number(result)).toBe(0);
    });
  });

  describe('writeProtocolSummary30s', () => {
    it('emits protocol_summary_tick after the singleton UPDATE', async () => {
      const manager = makeFakeManager({
        lockResult: true,
        // 3 raw queries between lock + UPDATE: tvl, pool_count,
        // cumulative_distributor_count
        queryResults: [
          [{ total_tvl_usd: '1234.5' }],
          [{ pool_count: '7' }],
          [{ cumulative_distributor_count: '3' }],
          [], // UPDATE returns []
        ],
        rawOne: { volume_usd: '99.9', tx_count: '10', wallets: '4' },
      });
      const realtimeEmitTick = vi.fn();
      const svc = makeService(manager);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).realtime.emitProtocolSummaryTick = realtimeEmitTick;
      await svc.writeProtocolSummary30s();
      expect(realtimeEmitTick).toHaveBeenCalledOnce();
      expect(realtimeEmitTick.mock.calls[0]![0]).toMatchObject({
        totalTvlUsd: 1234.5,
        volume24hUsd: 99.9,
        txCount24h: 10,
        activeWallets24h: 4,
        poolCount: 7,
        cumulativeDistributorCount: 3,
      });
    });

    it('does not emit when the lock is held by another worker', async () => {
      const manager = makeFakeManager({ lockResult: false });
      const realtimeEmitTick = vi.fn();
      const svc = makeService(manager);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (svc as any).realtime.emitProtocolSummaryTick = realtimeEmitTick;
      await svc.writeProtocolSummary30s();
      expect(realtimeEmitTick).not.toHaveBeenCalled();
    });
  });
});
