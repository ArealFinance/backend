import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Per-LP-position history projection (Phase 12.2.1).
 *
 * Captures the three native-dex liquidity events:
 *   - LiquidityAdded         → kind='add',    shares_delta = +shares_minted
 *   - LiquidityRemoved       → kind='remove', shares_delta = -shares_burned
 *   - ZapLiquidityExecuted   → kind='zap',    shares_delta = +shares_minted
 *
 * `shares_delta` is signed so a per-(wallet, pool) sum reproduces the
 * provider's current position size without joining back to chain state.
 *
 * Note `RwtMinted` is intentionally NOT here — RWT minting is an OT-engine
 * action (writes only `transactions` with kind='mint_rwt'), it doesn't
 * touch the AMM and so doesn't change LP position.
 */
@Entity({ schema: 'areal', name: 'lp_position_history' })
@Unique('UQ_lp_position_history_signature_log_index', ['signature', 'logIndex'])
@Index('idx_lp_position_history_wallet_blocktime', ['wallet', 'blockTime'])
@Index('idx_lp_position_history_pool_blocktime', ['pool', 'blockTime'])
export class LpPositionHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 88 })
  signature!: string;

  @Column({ type: 'integer', name: 'log_index' })
  logIndex!: number;

  @Column({ type: 'varchar', length: 44 })
  wallet!: string;

  @Column({ type: 'varchar', length: 44 })
  pool!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'add' | 'remove' | 'zap';

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'amount_a' })
  amountA!: string;

  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'amount_b' })
  amountB!: string;

  /** Signed: positive on add/zap, negative on remove. */
  @Column({ type: 'numeric', precision: 40, scale: 0, name: 'shares_delta' })
  sharesDelta!: string;

  @Column({ type: 'timestamptz', name: 'block_time' })
  blockTime!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
