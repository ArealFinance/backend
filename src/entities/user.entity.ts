import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Lightweight user record keyed by the wallet pubkey.
 *
 * We do not store any PII — Areal is an on-chain protocol, the wallet IS the
 * identity. This row exists only to:
 *   - track first-seen / last-seen timestamps (for analytics and abuse rate-
 *     limiting decisions),
 *   - hold a stable surrogate that other tables can foreign-key against
 *     should we add user-scoped projections later (notification prefs, etc).
 *
 * The wallet column is a base58 Solana pubkey (32-byte → 44 chars max). It is
 * the primary key directly — no surrogate UUID — because every interaction
 * already carries the wallet and we want index-only lookups in the hot path.
 */
@Entity({ schema: 'areal', name: 'users' })
export class User {
  @PrimaryColumn({ type: 'varchar', length: 44, name: 'wallet' })
  wallet!: string;

  @CreateDateColumn({ name: 'first_seen_at' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  @Index('idx_users_last_seen')
  lastSeenAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
