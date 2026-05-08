import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
import { MarketsAggregatorService } from './markets-aggregator.service.js';

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
  });

  describe('writeProtocolSummary30s', () => {
    it('emits protocol_summary_tick after the singleton UPDATE', async () => {
      const manager = makeFakeManager({
        lockResult: true,
        // 3 raw queries between lock + UPDATE: tvl, pool_count, distributor_count
        queryResults: [
          [{ total_tvl_usd: '1234.5' }],
          [{ pool_count: '7' }],
          [{ distributor_count: '3' }],
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
        distributorCount: 3,
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
