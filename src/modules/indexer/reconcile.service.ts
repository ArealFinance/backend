import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Connection, type PublicKey } from '@solana/web3.js';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';

import { Event } from '../../entities/event.entity.js';
import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';
import { DecoderService } from './decoder.service.js';
import { type HistoricalEventJob, INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';

/**
 * Periodic catch-up job.
 *
 * Why both `ChainListenerService` AND this:
 *   - The websocket subscription can drop silently — reconnects are not
 *     observable from web3.js, and any events emitted during the gap are
 *     LOST forever from the live feed.
 *   - Reconcile pages backwards through `getSignaturesForAddress` from
 *     "now" until the most-recent persisted slot per program, enqueuing
 *     historical jobs for any signatures the persister hasn't seen.
 *   - The persister's idempotent UPSERT means re-enqueueing live signatures
 *     during reconcile is safe — at worst we waste one row insert attempt.
 *
 * Pattern lifted from `bots/shared/src/reconcile.ts` (`reconcileEvents`) but
 * adapted to enqueue to Bull rather than dispatch synchronously.
 */
const SIGNATURES_PAGE_LIMIT = 1000;

@Injectable()
export class ReconcileService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconcileService.name);
  private isRunning = false;

  constructor(
    private readonly decoder: DecoderService,
    private readonly config: ConfigService,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @InjectQueue(INDEXER_QUEUE_NAME) private readonly queue: Queue<HistoricalEventJob>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
  ) {}

  /**
   * Run once on boot to catch anything that landed while the process was down.
   * Triggered explicitly here (rather than waiting for the cron's first tick)
   * so a fresh deployment closes the gap immediately.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Fire-and-forget: bootstrap reconcile shouldn't block server startup.
    void this.runOnce().catch((err) => {
      this.logger.error(
        `bootstrap reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledReconcile(): Promise<void> {
    await this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('reconcile already running — skipping tick');
      return;
    }
    this.isRunning = true;
    try {
      for (const programId of this.decoder.getRegisteredProgramIds()) {
        await this.reconcileProgram(programId);
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async reconcileProgram(programId: PublicKey): Promise<void> {
    const fromSlot = await this.lastSeenSlot(programId.toBase58());
    const maxSignatures = this.config.get<number>('indexer.maxReconcileSignatures') ?? 50_000;

    const collected: Array<{ signature: string; slot: number; blockTime: number | null }> = [];
    let before: string | undefined;
    while (true) {
      const batch = await this.conn.getSignaturesForAddress(programId, {
        before,
        limit: SIGNATURES_PAGE_LIMIT,
      });
      if (batch.length === 0) break;

      let crossedLowerBound = false;
      for (const b of batch) {
        // Strict less-than so siblings on the same slot are not skipped.
        if (fromSlot !== null && b.slot < fromSlot) {
          crossedLowerBound = true;
          break;
        }
        if (b.err) continue;
        collected.push({
          signature: b.signature,
          slot: b.slot,
          blockTime: b.blockTime ?? null,
        });
        if (collected.length >= maxSignatures) {
          crossedLowerBound = true;
          break;
        }
      }
      if (crossedLowerBound) break;
      if (batch.length < SIGNATURES_PAGE_LIMIT) break;
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
    }

    if (collected.length === 0) {
      this.logger.debug(
        `reconcile: no new signatures for ${programId.toBase58()} (fromSlot=${fromSlot})`,
      );
      return;
    }

    // Replay oldest-first to match chronological event order.
    collected.reverse();

    for (const c of collected) {
      await this.queue.add(
        'historical',
        {
          kind: 'historical',
          programId: programId.toBase58(),
          signature: c.signature,
          slot: c.slot,
          blockTime: c.blockTime,
        },
        {
          removeOnComplete: 1000,
          removeOnFail: 5000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    }
    this.logger.log(
      `reconcile: enqueued ${collected.length} signatures for ${programId.toBase58()}`,
    );
  }

  /**
   * Returns the slot of the most-recent event we've persisted for this
   * program, or `null` if the table is empty (cold start).
   *
   * NB: stored as bigint string in Postgres → coerce via Number. Solana slots
   * are well below 2^53 (~285 years at 400ms slots), so the precision loss
   * is purely theoretical.
   */
  private async lastSeenSlot(programIdBase58: string): Promise<number | null> {
    const row = await this.events
      .createQueryBuilder('e')
      .select('MAX(e.slot)', 'max')
      .where('e.programId = :pid', { pid: programIdBase58 })
      .getRawOne<{ max: string | null }>();
    if (!row?.max) return null;
    return Number(row.max);
  }
}
