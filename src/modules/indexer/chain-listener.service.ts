import { InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Connection, type PublicKey } from '@solana/web3.js';
import type { Queue } from 'bull';

import { DecoderService } from './decoder.service.js';
import { type LiveEventJob, INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';
import { SOLANA_CONNECTION } from './connection.provider.js';

/**
 * Subscribes to `onLogs` for each registered Areal program and enqueues
 * decoded events for the persister to consume.
 *
 * Subscription is per-program (web3.js requires one filter per `onLogs`).
 * Reconnect handling: web3.js will silently re-subscribe under the hood when
 * the underlying ws drops; the gap is closed by `ReconcileService` on its
 * 5-minute cron — see comment there for why we do BOTH.
 *
 * In-process dedupe:
 *   We do not maintain a `Set<signature>` here. Bull jobs hit the persister,
 *   which is idempotent at the SQL level — so a duplicate enqueue is cheap.
 *   The trade-off is a tiny bit of redis memory vs. memory pressure on a
 *   long-running listener that might accumulate millions of seen signatures.
 */
@Injectable()
export class ChainListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainListenerService.name);
  private readonly subscriptionIds = new Map<string, number>();

  constructor(
    private readonly decoder: DecoderService,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @InjectQueue(INDEXER_QUEUE_NAME) private readonly queue: Queue<LiveEventJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const programId of this.decoder.getRegisteredProgramIds()) {
      await this.subscribe(programId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const promises: Array<Promise<void>> = [];
    for (const subId of this.subscriptionIds.values()) {
      promises.push(this.conn.removeOnLogsListener(subId));
    }
    await Promise.allSettled(promises);
    this.subscriptionIds.clear();
  }

  private async subscribe(programId: PublicKey): Promise<void> {
    const subId = this.conn.onLogs(
      programId,
      async (logs, ctx) => {
        if (logs.err) return;

        // Decode quickly — only enqueue if at least one Areal event is in
        // there. Saves a queue round-trip for every transaction touching
        // the program that doesn't actually emit an event we care about.
        const decoded = this.decoder.decodeLogs(programId, logs.logs);
        if (decoded.length === 0) return;

        try {
          await this.queue.add(
            'live',
            {
              kind: 'live',
              programId: programId.toBase58(),
              signature: logs.signature,
              slot: ctx.slot,
              // `onLogs` doesn't carry blockTime — we'll fall back to slot
              // → wall-clock estimation in the persister if it stays null.
              blockTime: null,
              logs: logs.logs,
            },
            {
              // Keep failed jobs around for inspection; succeeded jobs are
              // ephemeral by default.
              removeOnComplete: 1000,
              removeOnFail: 5000,
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
            },
          );
        } catch (err) {
          this.logger.error(
            `failed to enqueue ${logs.signature}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
      'confirmed',
    );
    this.subscriptionIds.set(programId.toBase58(), subId);
    this.logger.log(`subscribed to onLogs for ${programId.toBase58()} (subId=${subId})`);
  }
}
