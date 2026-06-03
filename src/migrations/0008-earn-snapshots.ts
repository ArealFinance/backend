import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0008 — earn vault snapshots.
 *
 * Creates `areal.earn_snapshots`, a time-series of the earn vault's on-chain
 * economics written every 5 minutes by `EarnSnapshotService`. Each row records
 * the exact on-chain inputs needed to render Book NAV / stRWT rate / TVL and to
 * compute honest annualised APY from the stRWT rate's real elapsed growth.
 *
 * All economic columns are `numeric(40,0)` (exact, no float drift):
 *   - `book_nav` / `strwt_rate` — 6-dec fixed-point (1e6 scale).
 *   - `tvl` / `total_capital`   — 6-dec USD (u128 capital fits in numeric(40,0)).
 *   - `strwt_supply` / `rwt_supply` — raw base-unit mint supplies.
 *
 * `ts` is indexed (`idx_earn_snapshots_ts`) because the stats endpoint does
 * window range scans ("oldest snapshot within the last day / week / month").
 *
 * Pure derivation table — rebuildable by re-running the snapshot cron; no
 * ingestion happens here. Reversible via `down()`.
 */
export class EarnSnapshots1715140000003 implements MigrationInterface {
  name = 'EarnSnapshots1715140000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "areal"."earn_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ts" timestamptz NOT NULL,
        "book_nav" numeric(40, 0) NOT NULL,
        "strwt_rate" numeric(40, 0) NOT NULL,
        "tvl" numeric(40, 0) NOT NULL,
        "strwt_supply" numeric(40, 0) NOT NULL,
        "rwt_supply" numeric(40, 0) NOT NULL,
        "total_capital" numeric(40, 0) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_earn_snapshots" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_earn_snapshots_ts"
      ON "areal"."earn_snapshots" ("ts")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "areal"."idx_earn_snapshots_ts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."earn_snapshots"`);
  }
}
