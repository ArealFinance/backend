import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Per-OT revenue distribution projection (Phase 12.2.1).
 *
 * Captures `ownership-token::RevenueDistributed`. Unlike the other
 * projections this one is NOT keyed by wallet — a single distribution
 * splits across N OT-holders inside the same instruction, so the natural
 * grain is `(ot_mint, distribution_count)`. Per-wallet revenue gets
 * derived from the related `RewardsClaimed` events (already in
 * `claim_history`).
 *
 * Why a dedicated table:
 *   - `transactions` is keyed by wallet; revenue events have none.
 *   - The markets / portfolio "revenue rate" widget reads recent N distributions
 *     for an OT to compute APR — much faster than scanning raw `events`.
 */
@Entity({ schema: 'areal', name: 'revenue_distributions' })
@Unique('UQ_revenue_distributions_signature_log_index', ['signature', 'logIndex'])
@Index('idx_revenue_distributions_otmint_blocktime', ['otMint', 'blockTime'])
export class RevenueDistribution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 88 })
  signature!: string;

  @Column({ type: 'integer', name: 'log_index' })
  logIndex!: number;

  @Column({ type: 'varchar', length: 44, name: 'ot_mint' })
  otMint!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'total_amount' })
  totalAmount!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'protocol_fee' })
  protocolFee!: string;

  @Column({ type: 'integer', name: 'distribution_count' })
  distributionCount!: number;

  @Column({ type: 'integer', name: 'num_destinations' })
  numDestinations!: number;

  @Column({ type: 'timestamptz', name: 'block_time' })
  blockTime!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
