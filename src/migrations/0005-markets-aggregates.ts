import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0005 — markets aggregate tables (Phase 12.3.1).
 *
 * Creates three tables that derive FROM `areal.events` + `areal.transactions`:
 *
 *   - `pool_snapshots`         — per-pool periodic state snapshot (60s cadence)
 *   - `daily_pool_aggregates`  — per-(pool, day) UPSERT (5min cadence)
 *   - `protocol_summary`       — singleton row (30s cadence)
 *
 * All three are owned by the `MarketsAggregatorService` cron jobs. The raw
 * events table is the source of truth; these tables are pure derivations
 * that can be rebuilt by re-running the cron jobs (no ingestion happens here).
 *
 * The `protocol_summary` table is a singleton: a CHECK constraint pins
 * `id = 'singleton'` so the cron's `UPDATE` (or initial INSERT) is the only
 * way the row can change shape. Any attempt to insert a second row fails at
 * the DB level — defence in depth against a buggy migration introducing
 * historical rows that the cron job would silently clobber.
 */
export class MarketsAggregates1715140000000 implements MigrationInterface {
  name = 'MarketsAggregates1715140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pool_snapshots ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."pool_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pool" varchar(44) NOT NULL,
        "block_time" bigint NOT NULL,
        "tvl_a" numeric(40, 0) NOT NULL,
        "tvl_b" numeric(40, 0) NOT NULL,
        "tvl_usd" numeric(40, 8),
        "reserve_a" numeric(40, 0) NOT NULL,
        "reserve_b" numeric(40, 0) NOT NULL,
        "fee_growth_a" numeric(40, 0) NOT NULL,
        "fee_growth_b" numeric(40, 0) NOT NULL,
        "lp_supply" numeric(40, 0) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_pool_snapshots" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_pool_snapshots_pool_blocktime"
      ON "areal"."pool_snapshots" ("pool", "block_time" DESC)
    `);

    // daily_pool_aggregates ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."daily_pool_aggregates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pool" varchar(44) NOT NULL,
        "day" date NOT NULL,
        "volume_a_24h" numeric(40, 0) NOT NULL DEFAULT 0,
        "volume_b_24h" numeric(40, 0) NOT NULL DEFAULT 0,
        "fees_a_24h" numeric(40, 0) NOT NULL DEFAULT 0,
        "fees_b_24h" numeric(40, 0) NOT NULL DEFAULT 0,
        "tx_count_24h" integer NOT NULL DEFAULT 0,
        "unique_wallets_24h" integer NOT NULL DEFAULT 0,
        "apy_24h" numeric(20, 8),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_daily_pool_aggregates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_daily_pool_aggregates_pool_day" UNIQUE ("pool", "day")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_daily_pool_aggregates_pool_day"
      ON "areal"."daily_pool_aggregates" ("pool", "day" DESC)
    `);

    // protocol_summary --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."protocol_summary" (
        "id" varchar(16) NOT NULL DEFAULT 'singleton',
        "total_tvl_usd" numeric(40, 8) NOT NULL DEFAULT 0,
        "volume_24h_usd" numeric(40, 8) NOT NULL DEFAULT 0,
        "tx_count_24h" integer NOT NULL DEFAULT 0,
        "active_wallets_24h" integer NOT NULL DEFAULT 0,
        "pool_count" integer NOT NULL DEFAULT 0,
        "distributor_count" integer NOT NULL DEFAULT 0,
        "block_time" bigint NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_protocol_summary" PRIMARY KEY ("id"),
        CONSTRAINT "ck_protocol_summary_singleton" CHECK ("id" = 'singleton')
      )
    `);
    // Seed the singleton row immediately so the 30s cron's first UPDATE
    // hits an existing tuple (avoids the cron needing to handle "first run
    // INSERT vs subsequent UPDATE" branching).
    await queryRunner.query(`
      INSERT INTO "areal"."protocol_summary" ("id") VALUES ('singleton')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."protocol_summary"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."daily_pool_aggregates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."pool_snapshots"`);
  }
}
