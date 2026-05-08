import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Raw Areal program event captured by the indexer.
 *
 * One row per `(signature, logIndex)` pair. The unique constraint is the
 * idempotency key — re-ingesting the same chain log (e.g. live + reconcile
 * race) is a no-op. Projections (transactions, pool snapshots, leaderboards,
 * etc.) are derived FROM this table in Phase 12.2+.
 *
 * Columns:
 *   - `program_id` — base58 program ID; one of the 5 Areal program IDs
 *     defined in `@areal/sdk/network`.
 *   - `event_name` — Anchor-compatible event name (e.g. `LiquidityAdded`).
 *   - `signature` — base58 transaction signature (~88 chars, < 90).
 *   - `log_index` — 0-based ordinal of the event within the transaction's
 *     emitted events; combined with `signature` it's globally unique.
 *   - `slot` — Solana slot. Stored as `bigint` (Postgres) → string in JS so
 *     we don't lose precision past 2^53.
 *   - `block_time` — wall-clock derived from `getBlockTime`. Nullable on the
 *     RPC side, but we coerce to `now()` if the RPC withholds it (rare).
 *   - `body` — full borsh-decoded event body as JSON. Schema varies by event
 *     name; consumer is responsible for typing.
 *   - `primary_actor`, `pool`, `ot_mint` — denormalised lookup keys extracted
 *     during ingest so common per-actor / per-pool queries stay index-only.
 *     All nullable because not every event references all three.
 */
@Entity({ schema: 'areal', name: 'events' })
// Uniqueness is per (signature, program_id, log_index): the same Solana
// transaction can `invoke` two Areal programs in separate CPIs, each emitting
// its own 0-indexed event stream (DecoderService numbers events per-program).
// The original 2-tuple key would collide on multi-program transactions and
// silently drop the second program's events on UPSERT — a correctness bug
// for nexus → yield-distribution and ownership-token → yield-distribution
// flows where two events legitimately share log_index 0 within one tx.
@Unique('uq_events_signature_program_log_index', ['signature', 'programId', 'logIndex'])
@Index('idx_events_program_event_time', ['programId', 'eventName', 'blockTime'])
@Index('idx_events_actor_time', ['primaryActor', 'blockTime'])
@Index('idx_events_pool_time', ['pool', 'blockTime'])
@Index('idx_events_ot_mint_time', ['otMint', 'blockTime'])
@Index('idx_events_slot', ['slot'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 44, name: 'program_id' })
  programId!: string;

  @Column({ type: 'varchar', length: 64, name: 'event_name' })
  eventName!: string;

  @Column({ type: 'varchar', length: 90 })
  signature!: string;

  @Column({ type: 'integer', name: 'log_index' })
  logIndex!: number;

  @Column({ type: 'bigint' })
  slot!: string;

  @Column({ type: 'timestamptz', name: 'block_time' })
  blockTime!: Date;

  @Column({ type: 'jsonb' })
  body!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 44, name: 'primary_actor', nullable: true })
  primaryActor!: string | null;

  @Column({ type: 'varchar', length: 44, nullable: true })
  pool!: string | null;

  @Column({ type: 'varchar', length: 44, name: 'ot_mint', nullable: true })
  otMint!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
