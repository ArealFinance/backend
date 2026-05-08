import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Per-pool periodic snapshot (Phase 12.3.1 — markets aggregates).
 *
 * One row per `(pool, block_time)`. Inserted by the 60s `snapshotPools60s`
 * cron job which reads on-chain pool state via the SDK markets reader.
 *
 * `block_time` is the cron's own wall-clock at job execution (best-effort,
 * ~60s granularity) — NOT the Solana slot wall-clock. The SDK markets
 * reader does not currently roundtrip a per-pool slot timestamp; we
 * surface the cron clock as a pragmatic stand-in. Adequate for time-series
 * visualisation (`(pool, block_time DESC)` index makes "latest snapshot
 * for pool X" an index-only point lookup), but NOT suitable for on-chain
 * reconciliation by slot. If slot-precise time becomes a requirement,
 * surface it via the SDK reader and migrate this column.
 *
 * Numeric storage:
 *   - Reserves / TVL in token base units use `numeric(40,0)` (wide enough
 *     for u64 lamport balances, lossless via TypeORM's string round-trip).
 *   - `tvl_usd` uses `numeric(40,8)` for 8-decimal USD precision; nullable
 *     when the pool has no priced side (TVL widget renders "—").
 *   - `lp_supply` is `numeric(40,0)` for u64 LP token supply.
 *   - `fee_growth_a` / `fee_growth_b` use `numeric(40,0)` to mirror the
 *     on-chain fee accumulator units (q64.64 fixed-point, stringified).
 *   - `price_a_usdc` / `price_b_usdc` (added in migration 0006) are USDC
 *     per 1 token (the SDK's natural shape) at snapshot time; nullable when
 *     the token is unpriceable (no direct or chained pool resolved).
 *   - `decimals_a` / `decimals_b` (added in migration 0006) are the
 *     on-chain mint decimals for the two sides, captured at snapshot time
 *     so the 5min rollup doesn't need a fresh RPC roundtrip per pool to
 *     compute `apy_24h`.
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

  @Column({
    type: 'numeric',
    precision: 40,
    scale: 8,
    name: 'price_a_usdc',
    nullable: true,
  })
  priceAUsdc!: string | null;

  @Column({
    type: 'numeric',
    precision: 40,
    scale: 8,
    name: 'price_b_usdc',
    nullable: true,
  })
  priceBUsdc!: string | null;

  @Column({ type: 'smallint', name: 'decimals_a', nullable: true })
  decimalsA!: number | null;

  @Column({ type: 'smallint', name: 'decimals_b', nullable: true })
  decimalsB!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
