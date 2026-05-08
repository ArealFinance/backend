import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0001 — initial schema.
 *
 * Creates:
 *   - schema `areal`
 *   - `events` (raw chain events, indexer source-of-truth)
 *   - `users` (wallet → first/last seen)
 *   - `refresh_tokens` (hashed JWT refresh tokens with rotation)
 *
 * Indexes mirror the entity decorators 1:1. Adding indexes here without
 * matching `@Index` on the entity (or vice versa) WILL cause TypeORM
 * `synchronize` (in dev) to recreate them on every startup — keep both sides
 * in sync.
 */
export class InitSchema0001 implements MigrationInterface {
  name = 'InitSchema0001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // uuid_generate_v4() lives in the `uuid-ossp` extension. Postgres 13+
    // also ships `gen_random_uuid()` via pgcrypto, but uuid-ossp keeps us
    // compatible with older deployments and is what TypeORM expects by default.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "areal"`);

    // events ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "program_id" varchar(44) NOT NULL,
        "event_name" varchar(64) NOT NULL,
        "signature" varchar(90) NOT NULL,
        "log_index" integer NOT NULL,
        "slot" bigint NOT NULL,
        "block_time" timestamptz NOT NULL,
        "body" jsonb NOT NULL,
        "primary_actor" varchar(44),
        "pool" varchar(44),
        "ot_mint" varchar(44),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_events_signature_log_index" UNIQUE ("signature", "log_index")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_events_program_event_time"
      ON "areal"."events" ("program_id", "event_name", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_events_actor_time"
      ON "areal"."events" ("primary_actor", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_events_pool_time"
      ON "areal"."events" ("pool", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_events_ot_mint_time"
      ON "areal"."events" ("ot_mint", "block_time")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_events_slot"
      ON "areal"."events" ("slot")
    `);

    // users -------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."users" (
        "wallet" varchar(44) NOT NULL,
        "first_seen_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_users" PRIMARY KEY ("wallet")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_users_last_seen"
      ON "areal"."users" ("last_seen_at")
    `);

    // refresh_tokens ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "areal"."refresh_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet" varchar(44) NOT NULL,
        "token_hash" varchar(128) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "uq_refresh_tokens_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_refresh_tokens_wallet"
      ON "areal"."refresh_tokens" ("wallet")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "areal"."events"`);
    // Schema not dropped — other future tables may live there.
  }
}
