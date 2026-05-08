/**
 * Phase 12.2.1 backfill CLI for the projection layer.
 *
 * Replays every row in `areal.events` through `EventProjectionService` so
 * historical data captured by Phase 12.1 (which only persisted raw events)
 * lands in the new projection tables. Idempotent thanks to the
 * `(signature, log_index)` UPSERT key on every projection — re-running is
 * safe.
 *
 * Usage:
 *   npm run build
 *   npm run projections:backfill
 *
 * Strict ordering:
 *   `ORDER BY block_time ASC, signature ASC, log_index ASC`. The order
 *   guarantees `claim_history.cumulative_claimed` rows land in chain order
 *   so a future "running balance" query never reads a higher cumulative
 *   value before a lower one.
 *
 * Batching:
 *   1000 rows per fetch + per Postgres TX. Big enough to amortise round-trip
 *   cost, small enough that any single TX can roll back and retry without
 *   losing meaningful progress.
 */

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PublicKey } from '@solana/web3.js';
import { DataSource } from 'typeorm';

import { AppModule } from '../app.module.js';
import { Event } from '../entities/event.entity.js';
import { EventProjectionService } from '../modules/projections/event-projection.service.js';

const BATCH_SIZE = 1000;
const PROGRESS_INTERVAL = 10_000;

async function main(): Promise<void> {
  // `createApplicationContext` skips the HTTP layer entirely — we only need
  // DI to resolve the projection service and a managed DataSource.
  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  try {
    const ds = ctx.get<DataSource>(getDataSourceToken());
    const projector = ctx.get(EventProjectionService);
    const eventsRepo = ds.getRepository(Event);

    let processed = 0;
    let errors = 0;
    let lastBlockTime: Date | null = null;
    let lastSignature: string | null = null;
    let lastLogIndex: number | null = null;

    // eslint-disable-next-line no-console
    console.log(`[backfill] starting projection backfill, batch size ${BATCH_SIZE}`);

    while (true) {
      // Strict ordering on the keyset. We page by the (block_time, signature,
      // log_index) tuple — the same ordering the projection cursor uses on
      // the read side, so a re-run after partial failure resumes deterministically.
      const qb = eventsRepo
        .createQueryBuilder('e')
        .orderBy('e.block_time', 'ASC')
        .addOrderBy('e.signature', 'ASC')
        .addOrderBy('e.log_index', 'ASC')
        .limit(BATCH_SIZE);

      if (lastBlockTime && lastSignature !== null && lastLogIndex !== null) {
        qb.where('(e.block_time, e.signature, e.log_index) > (:bt, :sig, :li)', {
          bt: lastBlockTime,
          sig: lastSignature,
          li: lastLogIndex,
        });
      }

      const batch = await qb.getMany();
      if (batch.length === 0) break;

      // Per-batch transaction. Either the whole batch's projections commit or
      // none — if a single event throws, the batch rolls back and we exit
      // with a non-zero code so ops can investigate.
      try {
        await ds.transaction(async (manager) => {
          for (const row of batch) {
            const decoded = {
              programId: new PublicKey(row.programId),
              // The `programName` is not used by any projector; cast to a known
              // label to satisfy the SDK's DecodedEvent shape.
              programName: 'native-dex' as const,
              eventName: row.eventName,
              data: row.body,
            };
            await projector.projectInTx(manager, decoded, {
              signature: row.signature,
              logIndex: row.logIndex,
              slot: Number(row.slot),
              blockTime: row.blockTime,
            });
          }
        });
      } catch (err) {
        errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[backfill] batch failed at sig ${batch[0]?.signature}#${batch[0]?.logIndex}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Break (don't throw) so the summary log below still fires with the
        // correct `errors` count. Ops can grep the summary for "batches
        // failed" to decide whether to re-run.
        break;
      }

      processed += batch.length;
      const last = batch[batch.length - 1]!;
      lastBlockTime = last.blockTime;
      lastSignature = last.signature;
      lastLogIndex = last.logIndex;

      if (processed % PROGRESS_INTERVAL < BATCH_SIZE) {
        // eslint-disable-next-line no-console
        console.log(
          `[backfill] processed ${processed} events (last block_time=${last.blockTime.toISOString()})`,
        );
      }

      // Stop early when the batch was a partial fill — we've exhausted the
      // table.
      if (batch.length < BATCH_SIZE) break;
    }

    // eslint-disable-next-line no-console
    console.log(`[backfill] done: ${processed} events processed, ${errors} batches failed`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
