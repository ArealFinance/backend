import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Singleton protocol-wide summary (Phase 12.3.1 — markets aggregates).
 *
 * Exactly ONE row, pinned by `id = 'singleton'` (CHECK constraint enforced
 * at migration time). The 30-second `writeProtocolSummary30s` cron UPDATEs
 * this row in place from:
 *   - sum of `tvl_usd` across the latest snapshot per pool
 *   - sum of `transactions` over the trailing 24h (volume + tx count)
 *   - `COUNT(DISTINCT wallet)` over the trailing 24h
 *   - `COUNT(*)` over enumerated pools / OT mints (current chain state)
 *
 * Singleton over a sequence: the dashboard only ever wants "now"; keeping
 * historical summaries would require a separate `protocol_summary_history`
 * table that no UI surface reads today (deferred).
 */
@Entity({ schema: 'areal', name: 'protocol_summary' })
@Check(`"id" = 'singleton'`)
export class ProtocolSummary {
  @PrimaryColumn({ type: 'varchar', length: 16, default: 'singleton' })
  id!: string;

  @Column({ type: 'numeric', precision: 40, scale: 8, name: 'total_tvl_usd', default: 0 })
  totalTvlUsd!: string;

  @Column({ type: 'numeric', precision: 40, scale: 8, name: 'volume_24h_usd', default: 0 })
  volume24hUsd!: string;

  @Column({ type: 'integer', name: 'tx_count_24h', default: 0 })
  txCount24h!: number;

  @Column({ type: 'integer', name: 'active_wallets_24h', default: 0 })
  activeWallets24h!: number;

  @Column({ type: 'integer', name: 'pool_count', default: 0 })
  poolCount!: number;

  @Column({ type: 'integer', name: 'distributor_count', default: 0 })
  distributorCount!: number;

  @Column({ type: 'bigint', name: 'block_time', default: 0 })
  blockTime!: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
