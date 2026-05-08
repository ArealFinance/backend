import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0004 — projection tables for portfolio history (Phase 12.2.1).
 *
 * Creates four new tables that derive FROM `areal.events`:
 *   - `transactions`             — per-wallet user-meaningful actions
 *   - `claim_history`            — yield-distribution::RewardsClaimed
 *   - `revenue_distributions`    — ownership-token::RevenueDistributed (no wallet)
 *   - `lp_position_history`      — native-dex Add/Remove/Zap liquidity
 *
 * All four use `(signature, log_index)` as the projection idempotency key
 * (no `program_id` here — projector dispatch already filters by event_name,
 * so each `(signature, log_index)` projects into at most one row per table).
 *
 * Backfill is a separate CLI (`npm run projections:backfill`) — this
 * migration does NOT touch existing `events` rows. Adding it on top of the
 * production schema is purely additive: the four new tables start empty and
 * fill from the moment the projector module starts, plus whatever the
 * backfill CLI catches up.
 *
 * Indexes mirror the entity decorators 1:1.
 */
export class ProjectionTables1715040000000 implements MigrationInterface {
  name = 'ProjectionTables1715040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // transactions ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "signature" varchar(88) NOT NULL,
        "log_index" integer NOT NULL,
        "kind" varchar(32) NOT NULL,
        "wallet" varchar(44) NOT NULL,
        "ot_mint" varchar(44),
        "pool" varchar(44),
        "amount_a" numeric(40, 0),
        "amount_b" numeric(40, 0),
        "shares_delta" numeric(40, 0),
        "block_time" timestamptz NOT NULL,
        "slot" bigint NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_transactions_signature_log_index" UNIQUE ("signature", "log_index")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_transactions_wallet_blocktime"
      ON "areal"."transactions" ("wallet", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_transactions_kind_blocktime"
      ON "areal"."transactions" ("kind", "block_time")
    `);

    // claim_history -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."claim_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "signature" varchar(88) NOT NULL,
        "log_index" integer NOT NULL,
        "wallet" varchar(44) NOT NULL,
        "ot_mint" varchar(44) NOT NULL,
        "amount" numeric(40, 0) NOT NULL,
        "cumulative_claimed" numeric(40, 0) NOT NULL,
        "block_time" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_claim_history" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_claim_history_signature_log_index" UNIQUE ("signature", "log_index")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_claim_history_wallet_blocktime"
      ON "areal"."claim_history" ("wallet", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_claim_history_otmint_blocktime"
      ON "areal"."claim_history" ("ot_mint", "block_time")
    `);

    // revenue_distributions ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."revenue_distributions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "signature" varchar(88) NOT NULL,
        "log_index" integer NOT NULL,
        "ot_mint" varchar(44) NOT NULL,
        "total_amount" numeric(40, 0) NOT NULL,
        "protocol_fee" numeric(40, 0) NOT NULL,
        "distribution_count" integer NOT NULL,
        "num_destinations" integer NOT NULL,
        "block_time" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_revenue_distributions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_revenue_distributions_signature_log_index" UNIQUE ("signature", "log_index")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_revenue_distributions_otmint_blocktime"
      ON "areal"."revenue_distributions" ("ot_mint", "block_time")
    `);

    // lp_position_history -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."lp_position_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "signature" varchar(88) NOT NULL,
        "log_index" integer NOT NULL,
        "wallet" varchar(44) NOT NULL,
        "pool" varchar(44) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "amount_a" numeric(40, 0) NOT NULL,
        "amount_b" numeric(40, 0) NOT NULL,
        "shares_delta" numeric(40, 0) NOT NULL,
        "block_time" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_lp_position_history" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_lp_position_history_signature_log_index" UNIQUE ("signature", "log_index")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_lp_position_history_wallet_blocktime"
      ON "areal"."lp_position_history" ("wallet", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_lp_position_history_pool_blocktime"
      ON "areal"."lp_position_history" ("pool", "block_time")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."lp_position_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."revenue_distributions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."claim_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."transactions"`);
  }
}
