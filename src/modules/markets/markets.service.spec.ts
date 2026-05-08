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
