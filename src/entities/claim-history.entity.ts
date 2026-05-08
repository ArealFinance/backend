import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Per-claim history projection (Phase 12.2.1).
 *
 * Captures `yield-distribution::RewardsClaimed` events with the additional
 * cumulative counter so the portfolio claims tab can show both per-event
 * deltas AND the running per-(wallet, ot_mint) total without an aggregate
 * query.
 *
 * Index strategy:
 *   - `(wallet, block_time DESC)` — primary read pattern, "recent claims for
 *     this wallet".
 *   - `(ot_mint, block_time DESC)` — markets / OT-holder analytics.
 */
@Entity({ schema: 'areal', name: 'claim_history' })
@Unique('UQ_claim_history_signature_log_index', ['signature', 'logIndex'])
@Index('idx_claim_history_wallet_blocktime', ['wallet', 'blockTime'])
@Index('idx_claim_history_otmint_blocktime', ['otMint', 'blockTime'])
export class ClaimHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 88 })
  signature!: string;

  @Column({ type: 'integer', name: 'log_index' })
  logIndex!: number;

  @Column({ type: 'varchar', length: 44 })
  wallet!: string;

  @Column({ type: 'varchar', length: 44, name: 'ot_mint' })
  otMint!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0 })
  amount!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'cumulative_claimed' })
  cumulativeClaimed!: string;

  @Column({ type: 'timestamptz', name: 'block_time' })
  blockTime!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
