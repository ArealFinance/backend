import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Per-pool daily aggregate (Phase 12.3.1 — markets aggregates).
 *
 * One row per `(pool, day)` UPSERTed by the 5-minute `rollupDailyAggregates5m`
 * cron. The job aggregates the trailing 24h of:
 *   - `volume_*_24h` / `fees_*_24h` from `transactions` rows of kind `swap`,
 *     summed per side; both sides reflected so a swap A→B contributes to
 *     `volume_a_24h` (input) and `volume_b_24h` (output).
 *   - `tx_count_24h` is `COUNT(*)` over `transactions` for the pool/day window.
 *   - `unique_wallets_24h` is `COUNT(DISTINCT wallet)` — a known scaling cliff
 *     past ~10M tx/day, but acceptable for v1 (R-ticket noted).
 *   - `apy_24h` is currently a RESERVED FIELD — written as NULL by the
 *     5min rollup. The intended derivation `fees_usd_24h / tvl_usd * 365`
 *     requires (a) USD-denominated fees per swap (Phase 12.2 swap projector
 *     stores native units only, not priced) and (b) a USD price oracle —
 *     neither shipped in Phase 12.x backend. Tracked as a follow-up
 *     R-ticket; UI will render "—" until it lands.
 *
 * Idempotency: `(pool, day)` UNIQUE — re-running the job overwrites the
 * row in place. The `updated_at` timestamp records the last refresh so
 * staleness alerts can fire if the cron stalls.
 */
@Entity({ schema: 'areal', name: 'daily_pool_aggregates' })
@Unique('UQ_daily_pool_aggregates_pool_day', ['pool', 'day'])
@Index('idx_daily_pool_aggregates_pool_day', ['pool', 'day'])
export class DailyPoolAggregate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 44 })
  pool!: string;

  @Column({ type: 'date' })
  day!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'volume_a_24h', default: 0 })
  volumeA24h!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'volume_b_24h', default: 0 })
  volumeB24h!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'fees_a_24h', default: 0 })
  feesA24h!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'fees_b_24h', default: 0 })
  feesB24h!: string;

  @Column({ type: 'integer', name: 'tx_count_24h', default: 0 })
  txCount24h!: number;

  @Column({ type: 'integer', name: 'unique_wallets_24h', default: 0 })
  uniqueWallets24h!: number;

  @Column({ type: 'numeric', precision: 20, scale: 8, name: 'apy_24h', nullable: true })
  apy24h!: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
