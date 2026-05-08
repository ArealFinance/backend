import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0007 — rename `distributor_count` -> `cumulative_distributor_count`
 * on `areal.protocol_summary` (Phase 12.3.1 — R-12.3.1-2).
 *
 * The original column name was misleading. The 30s `writeProtocolSummary30s`
 * job populates it via:
 *
 *   SELECT COUNT(DISTINCT primary_actor) FROM areal.events
 *    WHERE event_name = 'RevenueDistributed';
 *
 * which is "how many unique distributors have ever distributed revenue
 * over the full event history" — a CUMULATIVE metric, not a current-state
 * one. The rename surfaces that semantics in the schema, the entity, and
 * the wire format. There is no SDK / UI consumer of `distributorCount`
 * yet, so this is the right window for a rename instead of a deprecation
 * cycle.
 *
 * Reversible via `down()` — the rename is symmetric.
 */
export class RenameDistributorCount1715140000002 implements MigrationInterface {
  name = 'RenameDistributorCount1715140000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "areal"."protocol_summary"
        RENAME COLUMN "distributor_count" TO "cumulative_distributor_count"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "areal"."protocol_summary"
        RENAME COLUMN "cumulative_distributor_count" TO "distributor_count"
    `);
  }
}
