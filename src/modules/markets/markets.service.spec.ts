import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MarketsService } from './markets.service.js';

/**
 * Read-side service tests. We mock the three repositories and assert the
 * clamping + filtering behaviour. Database semantics (the actual SQL plan)
 * are exercised by the integration / runbook procedures separately.
 */

const POOL = 'POOLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeRepo(rows: unknown[] = []) {
  const qb = {
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    getMany: vi.fn().mockResolvedValue(rows),
  };
  return {
    find: vi.fn().mockResolvedValue(rows),
    findOne: vi.fn().mockResolvedValue(rows[0] ?? null),
    createQueryBuilder: vi.fn().mockReturnValue(qb),
    qb,
  };
}

describe('MarketsService.listSnapshots', () => {
  it('passes from+to dual bounds via QueryBuilder', async () => {
    const snapshots = makeRepo([]);
    const aggregates = makeRepo();
    const summary = makeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    await svc.listSnapshots(POOL, { from: 100, to: 200 });
    expect(snapshots.createQueryBuilder).toHaveBeenCalledOnce();
    expect(snapshots.qb.andWhere).toHaveBeenCalledWith('s.block_time >= :from', { from: '100' });
    expect(snapshots.qb.andWhere).toHaveBeenCalledWith('s.block_time <= :to', { to: '200' });
  });

  it('clamps limit at the 200 ceiling', async () => {
    const snapshots = makeRepo([]);
    const aggregates = makeRepo();
    const summary = makeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    // The DTO would have rejected 500 — the service does its own clamp as
    // the last guard before SQL.
    await svc.listSnapshots(POOL, { limit: 500 });
    const findCall = snapshots.find.mock.calls[0]![0] as { take: number };
    expect(findCall.take).toBe(200);
  });

  it('returns an empty array when no rows match', async () => {
    const snapshots = makeRepo([]);
    const aggregates = makeRepo();
    const summary = makeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    const result = await svc.listSnapshots(POOL, {});
    expect(result.items).toEqual([]);
  });
});

describe('MarketsService.listAggregate', () => {
  it('clamps days at 90', async () => {
    const snapshots = makeRepo();
    const aggregates = makeRepo([]);
    const summary = makeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    await svc.listAggregate(POOL, { days: 1000 });
    const findCall = aggregates.find.mock.calls[0]![0] as { take: number };
    expect(findCall.take).toBe(90);
  });

  it('uses default 7 when days is omitted', async () => {
    const snapshots = makeRepo();
    const aggregates = makeRepo([]);
    const summary = makeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    await svc.listAggregate(POOL, {});
    const findCall = aggregates.find.mock.calls[0]![0] as { take: number };
    expect(findCall.take).toBe(7);
  });

  // Phase 12.3.3-I — latest-snapshot price/decimal enrichment.
  describe('latest-snapshot price enrichment', () => {
    const aggregateRow = {
      pool: POOL,
      day: '2026-05-08',
      volumeA24h: '1000',
      volumeB24h: '2000',
      feesA24h: '10',
      feesB24h: '20',
      txCount24h: 5,
      uniqueWallets24h: 3,
      apy24h: '0.05',
      updatedAt: new Date('2026-05-08T12:00:00.000Z'),
    };

    it('passes through latest-snapshot prices + decimals on the response', async () => {
      const snapshots = makeRepo();
      // Latest snapshot WITH prices + decimals — represents the post-12.3.3.1
      // happy path: snapshot60s populated all four fields.
      snapshots.findOne.mockResolvedValue({
        priceAUsdc: '1.50000000',
        priceBUsdc: '2.25000000',
        decimalsA: 9,
        decimalsB: 6,
      });
      const aggregates = makeRepo([aggregateRow]);
      const summary = makeRepo();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);

      const result = await svc.listAggregate(POOL, {});
      expect(result.items).toHaveLength(1);
      const row = result.items[0]!;
      expect(row.priceAUsdc).toBe(1.5);
      expect(row.priceBUsdc).toBe(2.25);
      expect(row.decimalsA).toBe(9);
      expect(row.decimalsB).toBe(6);

      // Snapshot lookup uses (pool, blockTime <= dayEndUnix) DESC limit 1.
      // 2026-05-08T00:00:00Z midnight + 86400s = 2026-05-09T00:00:00Z =
      // 1778544000 unix seconds. The findOne should target that boundary.
      const findOneCall = snapshots.findOne.mock.calls[0]![0] as {
        where: { pool: string };
        order: Record<string, string>;
      };
      expect(findOneCall.where.pool).toBe(POOL);
      expect(findOneCall.order).toEqual({ blockTime: 'DESC' });
    });

    it('falls back to null when no snapshot exists before the day boundary', async () => {
      const snapshots = makeRepo();
      // No snapshot found — pre-12.3.3.1 row OR pool with no historical
      // snapshots before this day.
      snapshots.findOne.mockResolvedValue(null);
      const aggregates = makeRepo([aggregateRow]);
      const summary = makeRepo();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);

      const result = await svc.listAggregate(POOL, {});
      expect(result.items).toHaveLength(1);
      const row = result.items[0]!;
      expect(row.priceAUsdc).toBeNull();
      expect(row.priceBUsdc).toBeNull();
      expect(row.decimalsA).toBeNull();
      expect(row.decimalsB).toBeNull();
    });

    it('falls back to null when snapshot exists but price/decimal columns are NULL', async () => {
      const snapshots = makeRepo();
      // Snapshot from before migration 0006 — row exists but the four
      // columns are NULL. Mapper must not coerce NULL to 0.
      snapshots.findOne.mockResolvedValue({
        priceAUsdc: null,
        priceBUsdc: null,
        decimalsA: null,
        decimalsB: null,
      });
      const aggregates = makeRepo([aggregateRow]);
      const summary = makeRepo();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);

      const result = await svc.listAggregate(POOL, {});
      const row = result.items[0]!;
      expect(row.priceAUsdc).toBeNull();
      expect(row.priceBUsdc).toBeNull();
      expect(row.decimalsA).toBeNull();
      expect(row.decimalsB).toBeNull();
    });
  });
});

describe('MarketsService.getSummary', () => {
  it('returns NotFoundException when the singleton row is missing', async () => {
    const snapshots = makeRepo();
    const aggregates = makeRepo();
    const summary = makeRepo([]); // findOne returns null
    summary.findOne.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new MarketsService(snapshots as any, aggregates as any, summary as any);
    await expect(svc.getSummary()).rejects.toBeInstanceOf(NotFoundException);
  });
});
