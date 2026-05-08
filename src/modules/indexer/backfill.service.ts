import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Connection, type PublicKey } from '@solana/web3.js';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';

import { Event } from '../../entities/event.entity.js';
import { SOLANA_CONNECTION } from './connection.provider.js';
import { DecoderService } from './decoder.service.js';
import { type HistoricalEventJob, INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';

/**
 * One-shot historical replay.
 *
 * On a fresh deploy, the events table is empty. The websocket listener only
 * sees events from "now" forward, and `ReconcileService` won't find a
 * `lastSeenSlot` to walk back from — so without backfill we'd silently miss
 * everything that happened before the deploy.
 *
 * Strategy:
 *   - At bootstrap, check whether the events table has ANY row for each
 *     program. If yes → skip backfill (reconcile will handle gaps).
 *   - If no → walk back from `currentSlot` for `BACKFILL_BLOCKS` slots,
 *     enqueue every signature.
 *
 * The job is fire-and-forget at startup. It can take many minutes for
 * chatty programs; we rely on the persister's idempotency so a restart
 * mid-backfill simply resumes from where it left off.
 */
const SIGNATURES_PAGE_LIMIT = 1000;

@Injectable()
export class BackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    private readonly decoder: DecoderService,
    private readonly config: ConfigService,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @InjectQueue(INDEXER_QUEUE_NAME) private readonly queue: Queue<HistoricalEventJob>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    void this.runIfNeeded().catch((err) => {
      this.logger.error(`backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async runIfNeeded(): Promise<void> {
    for (const programId of this.decoder.getRegisteredProgramIds()) {
      const seen = await this.hasAnyEvents(programId.toBase58());
      if (seen) {
        this.logger.debug(
          `backfill: ${programId.toBase58()} already has events — skipping (reconcile will handle gaps)`,
        );
        continue;
      }
      await this.backfillProgram(programId);
    }
  }

  private async backfillProgram(programId: PublicKey): Promise<void> {
    const lookback = this.config.get<number>('indexer.backfillBlocks') ?? 216_000;
    const currentSlot = await this.conn.getSlot('confirmed');
    const startSlot = Math.max(0, currentSlot - lookback);

    this.logger.log(
      `backfill: ${programId.toBase58()} from slot ${startSlot} (lookback=${lookback})`,
    );

    let collected = 0;
    let before: string | undefined;
    while (true) {
      const batch = await this.conn.getSignaturesForAddress(programId, {
        before,
        limit: SIGNATURES_PAGE_LIMIT,
      });
      if (batch.length === 0) break;

      let crossed = false;
      for (const b of batch) {
        if (b.slot < startSlot) {
          crossed = true;
          break;
        }
        if (b.err) continue;
        await this.queue.add(
          'historical',
          {
            kind: 'historical',
            programId: programId.toBase58(),
            signature: b.signature,
            slot: b.slot,
            blockTime: b.blockTime ?? null,
          },
          {
            removeOnComplete: 1000,
            removeOnFail: 5000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
          },
        );
        collected += 1;
      }
      if (crossed) break;
      if (batch.length < SIGNATURES_PAGE_LIMIT) break;
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
    }

    this.logger.log(`backfill: enqueued ${collected} signatures for ${programId.toBase58()}`);
  }

  private async hasAnyEvents(programIdBase58: string): Promise<boolean> {
    const count = await this.events.count({
      where: { programId: programIdBase58 },
      take: 1,
    });
    return count > 0;
  }
}
