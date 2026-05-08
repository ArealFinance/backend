import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0003 — tighten `refresh_tokens.token_hash` from varchar(128) to varchar(64).
 *
 * Reason:
 *   `hashToken()` always emits a 64-char lowercase hex string (HMAC-SHA-256
 *   output → 32 bytes → 64 hex chars). The original column was sized for
 *   128 chars on the off-chance we ever needed to store a longer digest;
 *   we never did. Narrowing the column:
 *     - shrinks the index footprint (token_hash is UNIQUE, so the entire
 *       index lives in memory on a hot path),
 *     - makes mismatched values (e.g. a stray base64-encoded 88-char digest
 *       from a misconfigured client) reject at the DB layer instead of
 *       silently round-tripping.
 *
 * Safety:
 *   Existing rows can only contain 64-char hex (every code path that ever
 *   wrote into this column went through `hashToken()` which has always
 *   returned 64 hex chars). PostgreSQL's `ALTER COLUMN ... TYPE varchar(64)`
 *   on rows that already fit succeeds without rewriting the heap.
 *
 *   The down migration widens back to varchar(128) without truncation —
 *   reversible.
 */
export class TightenRefreshTokenHash1714953600000 implements MigrationInterface {
  name = 'TightenRefreshTokenHash1714953600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "areal"."refresh_tokens" ALTER COLUMN "token_hash" TYPE varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "areal"."refresh_tokens" ALTER COLUMN "token_hash" TYPE varchar(128)`,
    );
  }
}
