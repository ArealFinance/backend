import { Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Job } from 'bull';
import { DataSource } from 'typeorm';

import { EventProjectionService } from '../projections/event-projection.service.js';
import { SOLANA_CONNECTION } from './connection.provider.js';
import { DecoderService } from './decoder.service.js';
import { type IndexerJob, INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';
import { PersisterService } from './persister.service.js';

/**
 * Bull worker draining the `indexer:events` queue.
 *
 * Two job kinds:
 *   - `live`: logs are inline. Decode + persist directly.
 *   - `historical`: only the signature is in the payload. Fetch the
 *     transaction, then decode + persist.
 *
 * Failures throw — Bull's exponential backoff (configured at the producer
 * site) retries up to N attempts. After max attempts a job lands in the
 * failed-jobs set for ops to inspect.
 */
@Processor(INDEXER_QUEUE_NAME)
export class IndexerConsumer {
  private readonly logger = new Logger(IndexerConsumer.name);

  constructor(
    private readonly decoder: DecoderService,
    private readonly persister: PersisterService,
    private readonly projections: EventProjectionService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
  ) {}

  @Process('live')
  async handleLive(job: Job<Extract<IndexerJob, { kind: 'live' }>>): Promise<void> {
    const { programId, signature, slot, blockTime, logs } = job.data;
    await this.processLogs({
      programId: new PublicKey(programId),
      signature,
      slot,
      blockTime,
      logs,
    });
  }

  @Process('historical')
  async handleHistorical(job: Job<Extract<IndexerJob, { kind: 'historical' }>>): Promise<void> {
    const { programId, signature, slot, blockTime } = job.data;
    const tx = await this.conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta?.logMessages) {
      this.logger.warn(`historical job: tx ${signature} has no logs (dropped or pruned)`);
      return;
    }
    await this.processLogs({
      programId: new PublicKey(programId),
      signature,
      slot: tx.slot ?? slot,
      blockTime: tx.blockTime ?? blockTime,
      logs: tx.meta.logMessages,
    });
  }

  private async processLogs(input: {
    programId: PublicKey;
    signature: string;
    slot: number;
    blockTime: number | null;
    logs: string[];
  }): Promise<void> {
    const decoded = this.decoder.decodeLogs(input.programId, input.logs);
    if (decoded.length === 0) return;

    // Resolve blockTime → Date. If RPC withheld it, fall back to "now" — the
    // wall clock is "good enough" within the live-listener case (events
    // typically reach us within a slot or two). Backfill / reconcile prefer
    // the RPC-provided value when present.
    const blockTimeMs =
      input.blockTime !== null && Number.isFinite(input.blockTime)
        ? input.blockTime * 1000
        : Date.now();
    const blockTimeDate = new Date(blockTimeMs);

    // Persist + project per event inside a single Postgres transaction so
    // either both writes (raw `events` row + projection row(s)) commit or
    // both roll back. Phase 12.2.1: this prevents half-projected events
    // (an `events` row with no `transactions` / `claim_history` row) which
    // would otherwise silently corrupt portfolio history.
    for (const { event, logIndex } of decoded) {
      const meta = {
        signature: input.signature,
        logIndex,
        slot: input.slot,
        blockTime: blockTimeDate,
      };
      await this.dataSource.transaction(async (manager) => {
        await this.persister.persistInTx(manager, event, meta);
        await this.projections.projectInTx(manager, event, meta);
      });
    }
  }
}
