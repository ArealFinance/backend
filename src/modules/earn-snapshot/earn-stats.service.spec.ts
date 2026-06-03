import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EarnSnapshot } from '../../entities/earn-snapshot.entity.js';
import { EarnStatsService } from './earn-stats.service.js';
import { RATE_SCALE, NAV_SCALE } from './earn-onchain.js';

/**
 * APY honesty tests for EarnStatsService.
 *
 * The load-bearing honesty rule is:
 *   - Require ACTUAL history spanning >= the requested window.
 *   - If not, return null (never extrapolate).
 *   - Annualise the REAL rate growth only: apy = (rate_now / rate_start) ^ (YEAR / elapsed) − 1.
 *   - Flat rate (ratio == 1) is genuinely 0% APY, not null.
 *
 * These tests verify the three APY windows (day/week/month) stay honest, that
 * short histories return null, and that downsampling works.
 */

describe('EarnStatsService: APY honesty', () => {
  let service: EarnStatsService;
  let mockSnapshotRepo: any;

  beforeEach(async () => {
    // Build a mock repository with chainable query builder
    mockSnapshotRepo = {
      createQueryBuilder: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([]),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EarnStatsService,
        {
          provide: getRepositoryToken(EarnSnapshot),
          useValue: mockSnapshotRepo,
        },
      ],
    }).compile();

    service = module.get<EarnStatsService>(EarnStatsService);
  });

  describe('no snapshots', () => {
    it('throws NotFoundException when no snapshots exist', async () => {
      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([]),
      });

      await expect(service.getStats()).rejects.toThrow(/no earn snapshots yet/i);
    });
  });

  describe('short history (< window)', () => {
    it('returns null for day APY when history < 24h', async () => {
      const now = new Date();
      const snapshot = {
        ts: new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12h old
        bookNav: '1000000', // $1.00
        strwtRate: '10000000', // 10.0
        tvl: '100000000',
      } as EarnSnapshot;

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([snapshot]),
      });

      const result = await service.getStats();
      expect(result.apy.day).toBeNull();
    });

    it('returns null for week APY when history < 7 days', async () => {
      const now = new Date();
      const snapshot = {
        ts: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days old
        bookNav: '1000000',
        strwtRate: '10000000',
        tvl: '100000000',
      } as EarnSnapshot;

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([snapshot]),
      });

      const result = await service.getStats();
      expect(result.apy.week).toBeNull();
    });

    it('returns null for month APY when history < 30 days', async () => {
      const now = new Date();
      const snapshot = {
        ts: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000), // 15 days old
        bookNav: '1000000',
        strwtRate: '10000000',
        tvl: '100000000',
      } as EarnSnapshot;

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([snapshot]),
      });

      const result = await service.getStats();
      expect(result.apy.month).toBeNull();
    });

    it('returns null when earliest snapshot is EXACTLY at the window boundary (not before)', async () => {
      const now = new Date();
      const windowStartMs = now.getTime() - 24 * 60 * 60 * 1000; // 24h ago
      const snapshot = {
        ts: new Date(windowStartMs), // exactly at boundary
        bookNav: '1000000',
        strwtRate: '10000000',
        tvl: '100000000',
      } as EarnSnapshot;

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([snapshot]),
      });

      const result = await service.getStats();
      // Earliest is NOT older than (now - window), so it should return null
      expect(result.apy.day).toBeNull();
    });
  });

  describe('flat rate (0% APY)', () => {
    it('returns 0 (not null) when rate has not moved (no rewards)', async () => {
      // Honesty rule: flat rate → apy = 0 (genuine), not null.
      // The ratio is exactly 1, so the math yields 0, which is correct.
      const now = new Date();
      const rate = 10_000_000n;
      const snapshots = [
        {
          ts: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000), // 40d old
          bookNav: '1000000',
          strwtRate: String(rate),
          tvl: '100000000',
        },
        {
          ts: new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000), // 25d old (in month window, different from first)
          bookNav: '1000000',
          strwtRate: String(rate),
          tvl: '100000000',
        },
        {
          ts: now,
          bookNav: '1000000',
          strwtRate: String(rate),
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Month window: earliest (40d old) < (now - 30d) → honesty guard passes
      // Find start: first snapshot >= (now - 30d) → the 25d snapshot
      // Elapsed: (now) - (25d ago) = 25d → positive
      // Ratio: rate / rate = 1
      // APY = 1^(365/25) - 1 = 1 - 1 = 0
      expect(result.apy.month).toBe(0);
    });
  });

  describe('APY growth calculation (annualized)', () => {
    it('computes APY > 0 when rate grows over a long span', async () => {
      const now = new Date();
      // 10% growth over ~25 days: 1.1 ^ (365/25) - 1 = 1.1^14.6 - 1 ≈ 3.02 (correct)
      const rateStart = 10_000_000n;
      const rateEnd = 11_000_000n; // 10% growth

      const snapshots = [
        {
          ts: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000), // 40d old (before month window)
          bookNav: '1000000',
          strwtRate: String(rateStart),
          tvl: '100000000',
        },
        {
          ts: new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000), // 25d old (in month window, start point)
          bookNav: '1000000',
          strwtRate: String(rateStart),
          tvl: '100000000',
        },
        {
          ts: now,
          bookNav: '1000000',
          strwtRate: String(rateEnd),
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Month: earliest (40d) passes guard, start = 25d, latest = now, elapsed = 25d
      // Ratio = 1.1, APY = 1.1^(365/25) - 1 ≈ 1.1^14.6 - 1 ≈ 3.02 (202% APY)
      expect(result.apy.month).not.toBeNull();
      expect(result.apy.month).toBeGreaterThan(2.5);
      expect(result.apy.month).toBeLessThan(3.5);
    });

    it('does NOT annualise when history is too short (returns null)', async () => {
      const now = new Date();
      // Short history (only 5 days) → should return null for month window
      const rateStart = 10_000_000n;
      const rateEnd = 11_000_000n;

      const snapshots = [
        {
          ts: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5d old
          bookNav: '1000000',
          strwtRate: String(rateStart),
          tvl: '100000000',
        },
        {
          ts: now,
          bookNav: '1000000',
          strwtRate: String(rateEnd),
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Earliest = 5d old, window_start for month = now - 30d
      // Is 5d < 30d? Yes (5d timestamp > now - 30d timestamp)
      // So earliest is NOT older than window_start → guard returns null
      expect(result.apy.month).toBeNull();
    });

    it('returns null when elapsed time is zero (same-ts snapshots)', async () => {
      const ts = new Date();
      const snapshots = [
        {
          ts,
          bookNav: '1000000',
          strwtRate: '10000000',
          tvl: '100000000',
        },
        {
          ts, // same ts
          bookNav: '1000000',
          strwtRate: '15000000', // rate grew but time didn't
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Can't annualise zero elapsed time
      expect(result.apy.day).toBeNull();
    });

    it('returns null when rate decreases (defensive against corrupt data)', async () => {
      const now = new Date();
      const rate1 = 10_000_000n;
      const rate2 = 9_000_000n; // decreased (shouldn't happen on-chain)

      const snapshots = [
        {
          ts: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          bookNav: '1000000',
          strwtRate: String(rate1),
          tvl: '100000000',
        },
        {
          ts: now,
          bookNav: '1000000',
          strwtRate: String(rate2),
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      expect(result.apy.month).toBeNull();
    });
  });

  describe('per-window oldest-in-window selection', () => {
    it('selects oldest snapshot IN the day window (not oldest overall)', async () => {
      const now = new Date();
      // 3 snapshots: older than day, at day boundary, and recent
      const old = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7d old (outside day window)
      const boundary = new Date(now.getTime() - 24 * 60 * 60 * 1000); // exactly 1d old
      const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h old

      const snapshots = [
        {
          ts: old,
          bookNav: '1000000',
          strwtRate: '10000000',
          tvl: '100000000',
        },
        {
          ts: boundary,
          bookNav: '1000000',
          strwtRate: '11000000', // 10% growth since old
          tvl: '100000000',
        },
        {
          ts: recent,
          bookNav: '1000000',
          strwtRate: '11000000', // flat since boundary
          tvl: '100000000',
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // For day window: we should use boundary → recent (both IN window)
      // ratio = 11000000 / 11000000 = 1, so APY = 0
      expect(result.apy.day).toBe(0);
    });
  });

  describe('downsampling', () => {
    it('returns all points when history <= 60 snapshots', async () => {
      const now = new Date();
      const snapshots = Array.from({ length: 50 }, (_, i) => ({
        ts: new Date(now.getTime() - i * 60 * 1000),
        bookNav: '1000000',
        strwtRate: '10000000',
        tvl: '100000000',
      })) as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // No downsampling needed
      expect(result.history.length).toBe(50);
    });

    it('downsamples to ~60 points when history is large', async () => {
      const now = new Date();
      // 300 snapshots (5-min cadence ≈ 25 hours of data)
      const snapshots = Array.from({ length: 300 }, (_, i) => ({
        ts: new Date(now.getTime() - i * 5 * 60 * 1000),
        bookNav: '1000000',
        strwtRate: String(10_000_000n + BigInt(i) * 1_000n),
        tvl: '100000000',
      })) as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Should be downsampled to ~60 points
      expect(result.history.length).toBeLessThanOrEqual(60);
      expect(result.history.length).toBeGreaterThan(50);
    });

    it('includes the latest point in the downsampled result', async () => {
      const now = new Date();
      const snapshots = Array.from({ length: 300 }, (_, i) => ({
        ts: new Date(now.getTime() - i * 60 * 1000),
        bookNav: '1000000',
        strwtRate: String(10_000_000n + BigInt(i) * 1_000n),
        tvl: '100000000',
      })) as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // Last point in downsampled should match latest
      const lastDownsampled = result.history[result.history.length - 1];
      const latest = snapshots[snapshots.length - 1];
      expect(lastDownsampled.ts).toBe(latest.ts.toISOString());
    });

    it('points are in ascending (oldest to newest) order', async () => {
      const now = new Date();
      // Create snapshots in ascending order (oldest first), as the service expects
      // The getMany query returns ascending by ts, so snapshots[0] is oldest
      const snapshots = Array.from({ length: 200 }, (_, i) => ({
        ts: new Date(now.getTime() - (199 - i) * 60 * 1000), // reversed: i=0 is oldest
        bookNav: '1000000',
        strwtRate: '10000000',
        tvl: '100000000',
      })) as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      for (let i = 1; i < result.history.length; i++) {
        const prev = new Date(result.history[i - 1].ts);
        const curr = new Date(result.history[i].ts);
        expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
      }
    });
  });

  describe('API response format', () => {
    it('returns floated NAV, rate, TVL (6-dec fixed-point scaled)', async () => {
      const now = new Date();
      const snapshots = [
        {
          ts: now,
          bookNav: '2000000', // $2.00 in 6-dec fixed-point
          strwtRate: '15000000', // 15.0 in 6-dec fixed-point
          tvl: '500000000', // $500M
        },
      ] as EarnSnapshot[];

      mockSnapshotRepo.createQueryBuilder.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue(snapshots),
      });

      const result = await service.getStats();
      // 2000000 / 1_000_000 = 2.0
      expect(result.bookNav).toBeCloseTo(2.0, 5);
      // 15000000 / 1_000_000 = 15.0
      expect(result.strwtRate).toBeCloseTo(15.0, 5);
      // 500000000 / 1_000_000 = 500.0
      expect(result.tvl).toBeCloseTo(500.0, 5);
    });
  });
});
