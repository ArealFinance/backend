import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { DailyPoolAggregate } from '../../entities/daily-pool-aggregate.entity.js';
import { PoolSnapshot } from '../../entities/pool-snapshot.entity.js';
import { ProtocolSummary } from '../../entities/protocol-summary.entity.js';
import type { ListAggregateDto } from './dto/list-aggregate.dto.js';
import type { ListSnapshotsDto } from './dto/list-snapshots.dto.js';
import type { DailyAggregateDto, ListAggregateResponseDto } from './dto/daily-aggregate.dto.js';
import type { ProtocolSummaryDto } from './dto/protocol-summary.dto.js';
import type { ListSnapshotsResponseDto, SnapshotRowDto } from './dto/snapshot-row.dto.js';

const DEFAULT_SNAPSHOT_LIMIT = 100;
const MAX_SNAPSHOT_LIMIT = 200;
const DEFAULT_AGGREGATE_DAYS = 7;
const MAX_AGGREGATE_DAYS = 90;

/**
 * Read-only public-facing service for the markets aggregate tables.
 *
 * Reads are intentionally simple — every query is a single point/range
 * lookup against a covering index. The aggregator service writes; this
 * one only ever reads. Time-series clamping happens here so the
 * controller stays a thin DTO layer.
 */
@Injectable()
export class MarketsService {
  constructor(
    @InjectRepository(PoolSnapshot)
    private readonly snapshots: Repository<PoolSnapshot>,
    @InjectRepository(DailyPoolAggregate)
    private readonly aggregates: Repository<DailyPoolAggregate>,
    @InjectRepository(ProtocolSummary)
    private readonly summary: Repository<ProtocolSummary>,
  ) {}

  /**
   * Per-pool snapshot time-series. Latest-first.
   *
   * Clamping: limit ∈ [1, 200] (hard cap), `from`/`to` are unix seconds
   * compared against `block_time` (also unix seconds in the DB).
   */
  async listSnapshots(pool: string, query: ListSnapshotsDto): Promise<ListSnapshotsResponseDto> {
    const limit = clamp(query.limit ?? DEFAULT_SNAPSHOT_LIMIT, 1, MAX_SNAPSHOT_LIMIT);

    // We compose `where` as an array of conditions — TypeORM's `Repository.find`
    // ANDs all entries of an object. `block_time` is bigint (unix seconds);
    // raw numbers in the DTO are coerced to string via String(...) because
    // `bigint` columns in TypeORM compare via string equality.
    const where: Record<string, unknown> = { pool };
    if (typeof query.from === 'number' && typeof query.to === 'number') {
      // Both endpoints — TypeORM has no native `Between` for bigint strings,
      // so two bounds via TypeORM operators on the same column would clobber
      // each other; switch to QueryBuilder for the dual-bound path.
      const qb = this.snapshots
        .createQueryBuilder('s')
        .where('s.pool = :pool', { pool })
        .andWhere('s.block_time >= :from', { from: String(query.from) })
        .andWhere('s.block_time <= :to', { to: String(query.to) })
        .orderBy('s.block_time', 'DESC')
        .limit(limit);
      const rows = await qb.getMany();
      return { items: rows.map(toSnapshotRow) };
    }
    if (typeof query.from === 'number') {
      where.blockTime = MoreThanOrEqual(String(query.from));
    } else if (typeof query.to === 'number') {
      where.blockTime = LessThanOrEqual(String(query.to));
    }

    const rows = await this.snapshots.find({
      where,
      order: { blockTime: 'DESC' },
      take: limit,
    });
    return { items: rows.map(toSnapshotRow) };
  }

  /**
   * Per-pool daily aggregate window. Most-recent N days, descending.
   * Clamps `days` to [1, 90] regardless of DTO validation outcome — the
   * service is the last guard before SQL.
   */
  async listAggregate(pool: string, query: ListAggregateDto): Promise<ListAggregateResponseDto> {
    const days = clamp(query.days ?? DEFAULT_AGGREGATE_DAYS, 1, MAX_AGGREGATE_DAYS);

    const rows = await this.aggregates.find({
      where: { pool },
      order: { day: 'DESC' },
      take: days,
    });
    return { items: rows.map(toAggregateRow) };
  }

  /**
   * Protocol singleton. The migration seeds the row on `up()`, so a `404`
   * here means the migration never ran — return `NotFoundException` so
   * ops sees a hard signal instead of a misleading "all zeros" response.
   */
  async getSummary(): Promise<ProtocolSummaryDto> {
    const row = await this.summary.findOne({ where: { id: 'singleton' } });
    if (!row) {
      throw new NotFoundException('protocol_summary not initialised');
    }
    return {
      totalTvlUsd: Number(row.totalTvlUsd),
      volume24hUsd: Number(row.volume24hUsd),
      txCount24h: row.txCount24h,
      activeWallets24h: row.activeWallets24h,
      poolCount: row.poolCount,
      distributorCount: row.distributorCount,
      blockTime: Number(row.blockTime),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(Math.max(value, lo), hi);
}

function toSnapshotRow(r: PoolSnapshot): SnapshotRowDto {
  return {
    pool: r.pool,
    blockTime: Number(r.blockTime),
    tvlA: r.tvlA,
    tvlB: r.tvlB,
    tvlUsd: r.tvlUsd === null ? null : Number(r.tvlUsd),
    reserveA: r.reserveA,
    reserveB: r.reserveB,
    feeGrowthA: r.feeGrowthA,
    feeGrowthB: r.feeGrowthB,
    lpSupply: r.lpSupply,
  };
}

function toAggregateRow(r: DailyPoolAggregate): DailyAggregateDto {
  return {
    pool: r.pool,
    day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
    volumeA24h: r.volumeA24h,
    volumeB24h: r.volumeB24h,
    feesA24h: r.feesA24h,
    feesB24h: r.feesB24h,
    txCount24h: r.txCount24h,
    uniqueWallets24h: r.uniqueWallets24h,
    apy24h: r.apy24h === null ? null : Number(r.apy24h),
    updatedAt: r.updatedAt.toISOString(),
  };
}
