import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Per-pool periodic snapshot (Phase 12.3.1 — markets aggregates).
 *
 * One row per `(pool, block_time)`. Inserted by the 60s `snapshotPools60s`
 * cron job which reads on-chain pool state via the SDK markets reader. The
 * combination of `block_time` (Solana slot wall-clock) and the periodic
 * cadence keeps us deterministic across restarts — re-running the job at
 * the same slot produces an identical row, and the index `(pool, block_time DESC)`
 * makes "latest snapshot for pool X" an index-only point lookup.
 *
 * Numeric storage:
 *   - Reserves / TVL in token base units use `numeric(40,0)` (wide enough
 *     for u64 lamport balances, lossless via TypeORM's string round-trip).
 *   - `tvl_usd` uses `numeric(40,8)` for 8-decimal USD precision; nullable
 *     when the pool has no priced side (TVL widget renders "—").
 *   - `lp_supply` is `numeric(40,0)` for u64 LP token supply.
 *   - `fee_growth_a` / `fee_growth_b` use `numeric(40,0)` to mirror the
 *     on-chain fee accumulator units (q64.64 fixed-point, stringified).
 */
@Entity({ schema: 'areal', name: 'pool_snapshots' })
@Index('idx_pool_snapshots_pool_blocktime', ['pool', 'blockTime'])
export class PoolSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 44 })
  pool!: string;

  @Column({ type: 'bigint', name: 'block_time' })
  blockTime!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'tvl_a' })
  tvlA!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'tvl_b' })
  tvlB!: string;

  @Column({ type: 'numeric', precision: 40, scale: 8, name: 'tvl_usd', nullable: true })
  tvlUsd!: string | null;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'reserve_a' })
  reserveA!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'reserve_b' })
  reserveB!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'fee_growth_a' })
  feeGrowthA!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'fee_growth_b' })
  feeGrowthB!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'lp_supply' })
  lpSupply!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
