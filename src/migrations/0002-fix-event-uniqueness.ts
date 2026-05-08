import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0002 — fix `events` uniqueness to include `program_id`.
 *
 * Reason:
 *   The original 0001 schema enforced UNIQUE(signature, log_index). That
 *   ignores the fact that a single Solana transaction can `invoke` more than
 *   one Areal program (CPI), and `DecoderService` numbers events per-program
 *   starting at 0. Two programs both emitting their first event in the same
 *   tx legitimately share `log_index = 0`, and the 2-tuple key would silently
 *   drop the second program's row on UPSERT.
 *
 *   Multi-program transactions are the norm in Areal:
 *     - nexus → yield-distribution (revenue → distribute)
 *     - ownership-token → yield-distribution (mint → publish)
 *     - rwt-engine → yield-distribution (claim flow)
 *
 *   The widened key `(signature, program_id, log_index)` keeps idempotency
 *   intact (re-ingest of the same per-program stream is still a no-op) while
 *   correctly accepting multi-program co-emissions.
 *
 * Safety:
 *   `up()` drops the old constraint and adds the new one in the same
 *   transaction. If the existing rows already violate the new (wider) key
 *   they would have ALSO violated the old (narrower) one — so this migration
 *   cannot fail on existing data given 0001 was clean.
 */
export class FixEventUniqueness0002 implements MigrationInterface {
  name = 'FixEventUniqueness0002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "areal"."events" DROP CONSTRAINT IF EXISTS "uq_events_signature_log_index"`,
    );
    await queryRunner.query(
      `ALTER TABLE "areal"."events"
         ADD CONSTRAINT "uq_events_signature_program_log_index"
         UNIQUE ("signature", "program_id", "log_index")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "areal"."events" DROP CONSTRAINT IF EXISTS "uq_events_signature_program_log_index"`,
    );
    await queryRunner.query(
      `ALTER TABLE "areal"."events"
         ADD CONSTRAINT "uq_events_signature_log_index"
         UNIQUE ("signature", "log_index")`,
    );
  }
}
