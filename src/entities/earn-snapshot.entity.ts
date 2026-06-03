import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Periodic snapshot of the earn vault's on-chain economics.
 *
 * One row every 5 minutes, written by `EarnSnapshotService`'s cron. Each row
 * captures the exact on-chain inputs needed to (a) render the earn dashboard's
 * Book NAV / stRWT rate / TVL, and (b) compute honest annualised APY from the
 * stRWT rate's growth over a real elapsed span (see `EarnStatsService`).
 *
 * Numeric storage (all exact — no float drift):
 *   - `book_nav`, `strwt_rate` are 6-dec fixed-point integers (NAV_SCALE /
 *     RATE_SCALE = 1e6) stored as `numeric(40,0)`. We keep them as raw
 *     fixed-point rather than dividing by 1e6 at write time so the APY ratio
 *     `rate_now / rate_start` is computed from the canonical on-chain value.
 *   - `tvl` is USD in 6-dec fixed-point (`numeric(40,0)`), == total invested
 *     capital (see `calculateTvl`).
 *   - `strwt_supply`, `rwt_supply`, `total_capital` are raw base-unit u128/u64
 *     counters stored as `numeric(40,0)` (wide enough for u128, lossless via
 *     TypeORM's string round-trip).
 *
 * `ts` is the cron's wall-clock at execution (timestamptz, indexed for the
 * time-window range scans the stats endpoint does). Best-effort ~5min
 * granularity — adequate for time-series, NOT slot-precise.
 */
@Entity({ schema: 'areal', name: 'earn_snapshots' })
@Index('idx_earn_snapshots_ts', ['ts'])
export class EarnSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz' })
  ts!: Date;

  /** Book NAV in 6-dec fixed-point (NAV_SCALE = 1e6 → 1_000_000 == $1.00). */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'book_nav' })
  bookNav!: string;

  /** stRWT→RWT rate in 6-dec fixed-point (RATE_SCALE = 1e6 → 10_000_000 == 10). */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'strwt_rate' })
  strwtRate!: string;

  /** TVL in USD, 6-dec fixed-point (== total invested capital). */
  @Column({ type: 'numeric', precision: 40, scale: 0 })
  tvl!: string;

  /** stRWT mint supply (base units, 6-dec). */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'strwt_supply' })
  strwtSupply!: string;

  /** earn-RWT mint supply (base units, 6-dec). */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'rwt_supply' })
  rwtSupply!: string;

  /** EarnConfig.total_invested_capital (u128, 6-dec USD). */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'total_capital' })
  totalCapital!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
