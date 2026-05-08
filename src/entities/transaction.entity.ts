import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Per-wallet transaction projection (Phase 12.2.1).
 *
 * One row per "user-meaningful" on-chain action that we want to surface in
 * the activity feed. Six kinds today:
 *
 *   - claim       — yield-distribution::RewardsClaimed
 *   - swap        — native-dex::SwapExecuted
 *   - add_lp      — native-dex::LiquidityAdded
 *   - remove_lp   — native-dex::LiquidityRemoved
 *   - zap_lp      — native-dex::ZapLiquidityExecuted
 *   - mint_rwt    — rwt-engine::RwtMinted
 *
 * Notably absent: `RevenueDistributed`. That event has no `wallet` (the
 * distribution fans out across N OT-holders inside the same instruction)
 * and gets its own table — `revenue_distributions`.
 *
 * Idempotency:
 *   `(signature, log_index)` is the natural projection key. Re-running the
 *   projector on an event we already projected is a no-op via UPSERT
 *   conflict-do-nothing in the dispatcher.
 *
 * Numeric fields:
 *   `amount_a`, `amount_b`, `shares_delta` are `numeric(40,0)` — wide enough
 *   for u64 lamport amounts. JS-side they round-trip as strings (TypeORM
 *   default for `numeric`).
 */
@Entity({ schema: 'areal', name: 'transactions' })
@Unique('UQ_transactions_signature_log_index', ['signature', 'logIndex'])
@Index('idx_transactions_wallet_blocktime', ['wallet', 'blockTime'])
@Index('idx_transactions_kind_blocktime', ['kind', 'blockTime'])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 88 })
  signature!: string;

  @Column({ type: 'integer', name: 'log_index' })
  logIndex!: number;

  @Column({ type: 'varchar', length: 32 })
  kind!: 'claim' | 'swap' | 'add_lp' | 'remove_lp' | 'zap_lp' | 'mint_rwt';

  @Column({ type: 'varchar', length: 44 })
  wallet!: string;

  @Column({ type: 'varchar', length: 44, name: 'ot_mint', nullable: true })
  otMint!: string | null;

  @Column({ type: 'varchar', length: 44, nullable: true })
  pool!: string | null;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'amount_a', nullable: true })
  amountA!: string | null;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'amount_b', nullable: true })
  amountB!: string | null;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'shares_delta', nullable: true })
  sharesDelta!: string | null;

  @Column({ type: 'timestamptz', name: 'block_time' })
  blockTime!: Date;

  @Column({ type: 'bigint' })
  slot!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
