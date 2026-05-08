import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0006 — pool snapshot price/decimals capture (Phase 12.3.1 — R-12.3.1-1).
 *
 * Adds four columns to `areal.pool_snapshots` so the 60s snapshot job can
 * record per-token USDC price + on-chain decimals AT SNAPSHOT TIME:
 *
 *   - `price_a_usdc`, `price_b_usdc` (`numeric(40,8)`, NULLABLE) — USDC per 1
 *     token, the SDK markets-reader's natural shape. NULL when the token
 *     can't be priced (no direct or chained pool).
 *   - `decimals_a`, `decimals_b` (`smallint`, NULLABLE) — on-chain mint
 *     decimals captured alongside the price. Persisting them avoids a
 *     fresh RPC roundtrip per pool at rollup time.
 *
 * Existing rows stay NULL. The 5min `rollupDailyAggregates5m` then computes
 * `apy_24h = (fees_usd_24h / tvl_usd) * 365` from the LATEST snapshot per
 * pool when ALL inputs (per-token prices, decimals, tvl_usd) are present —
 * historical rows from before this migration leave `apy_24h` NULL until the
 * next snapshot cycle replaces them.
 *
 * Reversible via `down()` — drops the four columns in reverse order.
 */
export class PoolSnapshotPrices1715140000001 implements MigrationInterface {
  name = 'PoolSnapshotPrices1715140000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "areal"."pool_snapshots"
        ADD COLUMN "price_a_usdc" numeric(40, 8),
        ADD COLUMN "price_b_usdc" numeric(40, 8),
        ADD COLUMN "decimals_a" smallint,
        ADD COLUMN "decimals_b" smallint
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "areal"."pool_snapshots"
        DROP COLUMN "decimals_b",
        DROP COLUMN "decimals_a",
        DROP COLUMN "price_b_usdc",
        DROP COLUMN "price_a_usdc"
    `);
  }
}
