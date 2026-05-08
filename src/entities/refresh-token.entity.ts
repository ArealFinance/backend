import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Persisted refresh token (HASHED).
 *
 * We never store the raw refresh token — only its sha256 digest. On
 * `/auth/refresh` we re-hash the presented token and look up by hash, so a
 * leaked DB cannot be used to mint new access tokens.
 *
 * Rotation policy (Phase 12.1 simple):
 *   - Issued on `/auth/login`.
 *   - Refresh request must present a non-revoked, non-expired token.
 *   - On successful refresh, mark `revoked_at = now()` on the old row and
 *     insert a new row (refresh-token rotation).
 *
 * Invariants:
 *   - `wallet` is the base58 pubkey owning this token.
 *   - `token_hash` is unique — same hash twice would mean a hash collision
 *     (sha256, won't happen in practice) or duplicate insert (bug).
 */
@Entity({ schema: 'areal', name: 'refresh_tokens' })
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 44 })
  @Index('idx_refresh_tokens_wallet')
  wallet!: string;

  // HMAC-SHA-256(JWT_REFRESH_SECRET, raw_token) → 32 bytes → 64 hex chars.
  // Kept narrow so the unique index footprint stays small (this index is on
  // the auth hot path) and so any malformed client input rejects at the DB
  // layer instead of silently round-tripping. See migration 0003.
  @Column({ type: 'varchar', length: 64, name: 'token_hash', unique: true })
  tokenHash!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
